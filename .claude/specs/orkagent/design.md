# Design: Orkagent

> Technical design for the agent command center CLI/TUI

## Overview

Orkagent is a single Node.js process application built with TypeScript, using Ink (React for CLIs) for the TUI layer. It follows a centralized store architecture where provider adapters normalize all LLM interactions into a unified `StreamEvent` stream. Each agent runs as a supervised async `AgentRunner` with its own error boundary. The system is modular by phase: Phase 1 delivers the core loop (config, providers, runners, store, UI), with subsequent phases adding communication, sandboxing, plugins, and templates as composable layers.

---

## Architecture

### High-Level Component Diagram

```
+---------------------------------------------------------------+
|                         CLI Entry (index.ts)                   |
|  - Argument parsing (orkagent up / save / fork / templates)    |
|  - Config loading and Zod validation                           |
+---------------------------------------------------------------+
                              |
                              v
+---------------------------------------------------------------+
|                    Orchestrator (orchestrator.ts)               |
|  - Agent lifecycle management (start, stop, restart)           |
|  - Cost tracking and guardrail enforcement                     |
|  - Session persistence                                         |
+------------------+------------------+-------------------------+
                   |                  |
          +--------v--------+  +------v-------+
          |   AgentRunner   |  |  AgentRunner  |  ... (1 per agent)
          |  (runner.ts)    |  |  (runner.ts)  |
          |  - Error bound. |  |  - Error bnd. |
          |  - Retry logic  |  |  - Retry lgc  |
          +--------+--------+  +------+--------+
                   |                  |
          +--------v--------+  +------v--------+
          | Provider Adapter|  |Provider Adapt. |
          | (anthropic.ts)  |  | (openai.ts)   |
          +-----------------+  +----------------+
                   |                  |
                   v                  v
          [Anthropic API]      [OpenAI API]       [Ollama API]

+---------------------------------------------------------------+
|                     Store (store.ts)                            |
|  - Centralized state: agents, messages, tokens, costs          |
|  - Event emitter for state changes                             |
|  - Batched change notifications (50-100ms)                     |
+---------------------------------------------------------------+
                              |
                              v
+---------------------------------------------------------------+
|                      TUI Layer (ui/)                           |
|  - App.tsx: root layout, keybinding handler                    |
|  - AgentPane.tsx: single agent output with virtual scroll      |
|  - StatusBar.tsx: state, tokens, cost                          |
|  - InputBar.tsx: message input for focused agent               |
|  - ApprovalPrompt.tsx: tool permission prompts                 |
+---------------------------------------------------------------+

Phase 2 additions:
+---------------------------------------------------------------+
|                    EventBus (eventbus.ts)                       |
|  - Pub/sub message routing between agents                      |
|  - Watch subscription management                               |
|  - Dependency graph resolution                                 |
+---------------------------------------------------------------+

Phase 3 additions:
+---------------------------------------------------------------+
|                  Tool Layer (tools/)                            |
|  - ToolRegistry: built-in + plugin tools                       |
|  - PermissionGuard: allow-list enforcement + approval prompts  |
|  - Built-in: FileReadTool, FileWriteTool, ShellTool, WebSearch |
|  - SSHRunner: remote tool invocation via SSH                   |
+---------------------------------------------------------------+

Phase 4 additions:
+---------------------------------------------------------------+
|                  Plugin Loader (plugins/)                       |
|  - Manifest validation                                         |
|  - Provider/tool/hook registration                             |
|  - Security boundary enforcement                               |
+---------------------------------------------------------------+
```

### Data Flow

```
[agents.yaml] --parse--> [Zod validation] --valid--> [Orchestrator]
                                                          |
                    +-------------------------------------+
                    |                                     |
                    v                                     v
             [AgentRunner 1]                      [AgentRunner N]
                    |                                     |
                    v                                     v
            [Provider.send()]                    [Provider.send()]
                    |                                     |
                    v                                     v
          AsyncIterable<StreamEvent>           AsyncIterable<StreamEvent>
                    |                                     |
                    +----------> [Store] <----------------+
                                   |
                          [batched notify, 50-100ms]
                                   |
                                   v
                              [TUI re-render]


Tool invocation flow (Phase 3):
  StreamEvent(tool_call) --> PermissionGuard.check(agent, tool)
       |                          |
       |  allowed                 |  not in allow-list
       v                          v
  ToolRegistry.run()      ApprovalPrompt --> user approve/deny
       |                          |
       v                          v
  StreamEvent(tool_result)   tool error / run
```

---

## Components

### CLI Entry (`src/index.ts`)

**Purpose**: Parse CLI arguments and dispatch to the appropriate command handler.

**Responsibilities**:
- Parse `orkagent up [-f config] [--resume] [--plain]` and other subcommands
- Load and validate config via `loadConfig()`
- Initialize the Orchestrator and mount the TUI

**Interfaces**:
- Input: `process.argv`
- Output: Initialized `Orchestrator` instance, mounted Ink app

**Traces to**: US-1

---

### Config Loader (`src/config.ts`)

**Purpose**: Parse YAML config and validate against the Zod schema.

**Responsibilities**:
- Read and parse `agents.yaml`
- Validate against `ConfigSchema` (Zod)
- Resolve environment variable references for API keys
- Detect circular dependencies in `depends_on` (Phase 2)

**Interfaces**:
- Input: File path string
- Output: `Config` typed object or thrown `ConfigValidationError`

**Traces to**: US-1, US-5 (circular dependency detection)

---

### Orchestrator (`src/orchestrator.ts`)

**Purpose**: Manage the lifecycle of all agent runners and coordinate system-wide concerns.

**Responsibilities**:
- Create and supervise `AgentRunner` instances
- Track cumulative cost per agent and per session
- Enforce cost guardrails (pause agents, prompt user)
- Handle `depends_on` sequencing (Phase 2)
- Persist and restore sessions (NFR-5)

**Interfaces**:
- Input: Validated `Config`, `Store` reference
- Output: Agent state transitions dispatched to `Store`

**Traces to**: US-1, US-5, US-13

---

### AgentRunner (`src/runner.ts`)

**Purpose**: Run a single agent's conversation loop with error boundaries and retry logic.

**Responsibilities**:
- Maintain conversation history (`Message[]`) for one agent
- Call `provider.send()` and consume the `AsyncIterable<StreamEvent>` stream
- Handle tool calls by dispatching to the tool layer (Phase 3) or returning them as events
- Implement restart logic (up to 3 attempts in 5 minutes)
- Handle rate limit backoff with exponential delay

**Interfaces**:
- Input: `AgentConfig`, `AgentProvider` instance, `Store` dispatch
- Output: `StreamEvent` emissions to the store
- Error: Isolated -- exceptions do not propagate to other runners

**Traces to**: US-4, US-13

---

### Provider Adapters (`src/providers/`)

**Purpose**: Normalize each LLM provider's API into the unified `AgentProvider` interface.

**Responsibilities**:
- Implement `AgentProvider.send()` returning `AsyncIterable<StreamEvent>`
- Implement `AgentProvider.abort()` to cancel in-flight requests
- Map provider-specific streaming formats to `StreamEvent`
- Map provider-specific tool call formats to unified `ToolCall`
- Extract token usage from provider responses

**Files**:
- `src/providers/anthropic.ts` -- Anthropic Messages API with streaming
- `src/providers/openai.ts` -- OpenAI Chat Completions with streaming
- `src/providers/ollama.ts` -- Ollama `/api/chat` with streaming
- `src/providers/types.ts` -- shared interfaces

**Traces to**: US-4

---

### Store (`src/store.ts`)

**Purpose**: Centralized state container for the entire application.

**Responsibilities**:
- Hold agent states, message buffers, token counts, cost accumulators
- Provide typed dispatch for state mutations
- Batch change notifications at 50-100ms intervals for TUI performance
- Expose read-only selectors for UI components

**Traces to**: US-2, NFR-1

---

### TUI Layer (`src/ui/`)

**Purpose**: Render the terminal interface using Ink (React for CLIs).

**Files and responsibilities**:
- `App.tsx` -- root layout, keybinding router, pane arrangement
- `AgentPane.tsx` -- single agent's output with virtual scrolling, state indicator
- `StatusBar.tsx` -- global status: agent states, total tokens, total cost
- `InputBar.tsx` -- message input when an agent pane is focused
- `ApprovalPrompt.tsx` -- modal for tool permission approval (Phase 3)

**Design constraints**:
- Components are pure display functions -- no side effects, no direct provider calls
- All data comes from store selectors
- Keybindings: vim-style hjkl for pane navigation, number keys for direct agent selection, tmux-style `Ctrl-b` prefix for commands (`Ctrl-b r` = restart, `Ctrl-b x` = stop, `Ctrl-b l` = logs)

**Traces to**: US-2, US-3, US-7 (approval prompts)

---

### EventBus (`src/eventbus.ts`) -- Phase 2

**Purpose**: Typed pub/sub message bus for inter-agent communication.

**Responsibilities**:
- Manage subscriptions keyed by event type
- Route `watches` events from producer agents to consumer agents
- Inject `context_from` content into agent system prompts
- Log undeliverable messages at debug level

**Traces to**: US-5, US-6

---

### Tool Layer (`src/tools/`) -- Phase 3

**Purpose**: Unified tool invocation with permission enforcement.

**Files**:
- `registry.ts` -- tool registration and lookup
- `permission.ts` -- allow-list checking and approval prompt dispatch
- `builtin/file.ts` -- file_read, file_write implementations
- `builtin/shell.ts` -- shell command invocation with path restrictions
- `builtin/web.ts` -- web_search implementation
- `ssh.ts` -- SSH connection management and remote tool invocation

**Traces to**: US-7, US-8, US-14

---

### Plugin Loader (`src/plugins/`) -- Phase 4

**Purpose**: Discover, validate, and load plugins at startup.

**Files**:
- `loader.ts` -- plugin discovery from node_modules and local paths
- `manifest.ts` -- Zod schema for plugin manifests
- `sandbox.ts` -- security boundary enforcement (no raw SDK access, no permission mutation)

**Traces to**: US-9, US-10

---

### Template Manager (`src/templates/`) -- Phase 5

**Purpose**: Save, publish, fork, and search agent topology templates.

**Files**:
- `save.ts` -- package current config into template directory
- `publish.ts` -- push template to git remote
- `fork.ts` -- clone template repo and customize
- `search.ts` -- query git registry index

**Traces to**: US-11, US-12

---

## Data Models

### Config Schema (Zod-validated)

```typescript
// src/config.ts

interface AgentConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  model: string;
  system: string;
  tools?: string[];                       // Phase 3: declared allow-list
  watches?: string[];                     // Phase 2: agent names to observe
  depends_on?: string[];                  // Phase 2: agents that must complete first
  context_from?: string[];                // Phase 2: agents whose output is injected
  remote?: {                              // Phase 3: SSH remote invocation
    host: string;
    user: string;
    key: string;
    port?: number;                        // default: 22
  };
  max_cost?: number;                      // Phase 3: per-agent cost limit in USD
  max_restarts?: number;                  // default: 3
}

interface TeamConfig {
  agents: string[];                       // references to agent names
}

interface PluginRef {                      // Phase 4
  name: string;
  path?: string;                          // local path override
  config?: Record<string, unknown>;
}

interface Config {
  version: 1;
  agents: Record<string, AgentConfig>;
  teams?: Record<string, TeamConfig>;
  plugins?: PluginRef[];                  // Phase 4
  session?: {
    max_cost?: number;                    // session-wide cost limit in USD
    resume?: boolean;
  };
}
```

### Core Runtime Types

```typescript
// src/providers/types.ts

interface StreamEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'done';
  agentId: string;                        // injected by runner, not by provider
  timestamp: number;
  content?: string;
  toolCall?: { id: string; name: string; input: unknown };
  toolResult?: { id: string; output: string; isError: boolean };
  usage?: { inputTokens: number; outputTokens: number };
  error?: { code: string; message: string; retryable: boolean };
}

interface AgentProvider {
  send(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent>;
  abort(): void;
}

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

type AgentState = 'pending' | 'starting' | 'running' | 'idle' | 'done' | 'error' | 'paused';
```

### Store State

```typescript
// src/store.ts

interface AgentStoreEntry {
  id: string;
  config: AgentConfig;
  state: AgentState;
  messages: Message[];
  outputBuffer: string[];                 // rolling window, max 10,000 lines
  tokenUsage: { input: number; output: number };
  costUsd: number;
  restartCount: number;
  lastError?: string;
}

interface AppState {
  agents: Record<string, AgentStoreEntry>;
  focusedAgentId: string | null;
  sessionCostUsd: number;
  sessionStartedAt: number;
}
```

### Plugin Manifest (Phase 4)

```typescript
interface PluginManifest {
  name: string;                           // must match npm package name
  version: string;                        // semver
  type: 'provider' | 'tool' | 'hook' | 'mixed';
  entry: string;                          // relative path to main export
  provides?: {
    providers?: string[];                 // provider names this plugin registers
    tools?: string[];                     // tool names this plugin registers
    hooks?: string[];                     // lifecycle hook names
  };
}
```

### Template Manifest (Phase 5)

```typescript
interface TemplateManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  repository?: string;
  requiredEnvVars: string[];              // API keys the template needs
  dependencies?: {                        // plugin dependencies
    plugins: Record<string, string>;      // name -> semver range
  };
}
```

---

## Sequence Diagrams

### Agent Launch (`orkagent up`)

```
User            CLI           Config        Orchestrator    Runner      Provider     Store       TUI
 |               |              |               |             |           |           |           |
 |--orkagent up->|              |               |             |           |           |           |
 |               |--loadConfig->|               |             |           |           |           |
 |               |              |--parse YAML-->|             |           |           |           |
 |               |              |--Zod validate>|             |           |           |           |
 |               |              |<--Config------|             |           |           |           |
 |               |<--Config-----|               |             |           |           |           |
 |               |--new Orchestrator(config)--->|             |           |           |           |
 |               |              |               |--init Store------------->|           |           |
 |               |              |               |--mount TUI----------------------------->|       |
 |               |              |               |                         |           |   |       |
 |               |              |               |--for each agent:        |           |   |       |
 |               |              |               |--new Runner(cfg)------->|           |   |       |
 |               |              |               |             |--create-->|           |   |       |
 |               |              |               |             |  Provider |           |   |       |
 |               |              |               |             |--send()-->|           |   |       |
 |               |              |               |             |           |--API call |   |       |
 |               |              |               |             |<-StreamEvent-|        |   |       |
 |               |              |               |             |--dispatch------------>|   |       |
 |               |              |               |             |           |           |--batch-->|
 |               |              |               |             |           |           |  render  |
```

### User Sends Message to Focused Agent

```
User         TUI(InputBar)    Store        Runner       Provider
 |               |              |             |             |
 |--type msg---->|              |             |             |
 |--press Enter->|              |             |             |
 |               |--dispatch--->|             |             |
 |               | addUserMsg   |             |             |
 |               |              |--notify---->|             |
 |               |              |             |--send()---->|
 |               |              |             |<-StreamEvt--|
 |               |              |<--dispatch--|             |
 |               |<--re-render--|             |             |
 |<--see output--|              |             |             |
```

### Tool Call with Permission Check (Phase 3)

```
Provider       Runner       PermissionGuard    Store/TUI(Approval)    ToolRegistry
   |              |               |                    |                    |
   |--tool_call-->|               |                    |                    |
   |              |--check()----->|                    |                    |
   |              |               |--in allow-list?    |                    |
   |              |               |  YES:              |                    |
   |              |               |--allowed---------->|                    |
   |              |               |                    |                    |
   |              |--invoke()--------------------------------------------->|
   |              |<--tool_result----------------------------------------------|
   |              |               |                    |                    |
   |              |               |  NO:               |                    |
   |              |               |--prompt user------>|                    |
   |              |               |                    |--show approval---->|
   |              |               |                    |<--user decision----|
   |              |               |<--approve/deny-----|                    |
   |              |               |                    |                    |
   |              |  if approved: |                    |                    |
   |              |--invoke()--------------------------------------------->|
   |              |<--tool_result----------------------------------------------|
   |              |               |                    |                    |
   |              |  if denied:   |                    |                    |
   |<--tool_error-|               |                    |                    |
```

### Agent Crash and Auto-Restart

```
Provider       Runner         Orchestrator      Store          TUI
   |              |               |               |              |
   |--error------>|               |               |              |
   |              |--catch------->|               |              |
   |              |  (error bnd)  |               |              |
   |              |               |--check restart count         |
   |              |               |  count < 3:   |              |
   |              |               |--dispatch---->|              |
   |              |               |  state=starting              |
   |              |               |               |--re-render-->|
   |              |               |--restart------>|              |
   |              |               |  (preserve     |              |
   |              |               |   msg history) |              |
   |              |<--new send()--|               |              |
   |              |               |               |              |
   |              |               |  count >= 3:  |              |
   |              |               |--dispatch---->|              |
   |              |               |  state=error  |              |
   |              |               |               |--re-render-->|
   |              |               |               | (show error) |
```

---

## CLI Commands

| Command | Description | Phase |
|---|---|---|
| `orkagent up [-f config] [--resume] [--plain] [--team name]` | Launch agents from config | 1 |
| `orkagent validate [-f config]` | Validate config without launching | 1 |
| `orkagent init` | Generate a starter `agents.yaml` in the current directory | 1 |
| `orkagent save <name>` | Package current config as a template | 5 |
| `orkagent publish <name>` | Push template to git registry | 5 |
| `orkagent fork <repo-url> [--name name]` | Clone and customize a template | 5 |
| `orkagent templates search <query>` | Search template registry | 5 |

---

## Keybinding Map

| Key | Context | Action |
|---|---|---|
| `h` / `l` | Overview | Move focus left / right between agent panes |
| `j` / `k` | Overview | Move focus down / up between agent panes |
| `1-9` | Overview | Jump to agent pane by index |
| `Enter` | Overview | Expand focused agent to full screen |
| `Escape` | Focused | Return to overview |
| `Ctrl-b r` | Any | Restart focused/selected agent |
| `Ctrl-b x` | Any | Stop focused/selected agent |
| `Ctrl-b l` | Any | Toggle log view for focused agent |
| `Ctrl-b a` | Any | Show all agents status summary |
| `q` / `Ctrl-c` | Any | Quit orkagent (with confirmation if agents running) |

---

## File Structure (Phase 1)

```
orkagent/
  package.json
  tsconfig.json
  src/
    index.ts            # CLI entry, arg parsing
    config.ts           # YAML loading + Zod schema
    orchestrator.ts     # Agent lifecycle management
    runner.ts           # Single agent conversation loop
    store.ts            # Centralized state
    providers/
      types.ts          # StreamEvent, AgentProvider, Message
      anthropic.ts      # Anthropic adapter
      openai.ts         # OpenAI adapter
      ollama.ts         # Ollama adapter
    ui/
      App.tsx           # Root TUI layout
      AgentPane.tsx     # Agent output pane
      StatusBar.tsx     # Status bar
      InputBar.tsx      # Message input
```

Grows to include `eventbus.ts`, `tools/`, `plugins/`, `templates/` in later phases.

---

## Implementation Considerations

### Dependencies

| Package | Purpose | Version Constraint |
|---|---|---|
| `ink` | React-based TUI rendering | ^5.x |
| `react` | Required by Ink | ^18.x |
| `@anthropic-ai/sdk` | Anthropic API client | ^0.x (latest) |
| `openai` | OpenAI API client | ^4.x |
| `zod` | Config and manifest validation | ^3.x |
| `yaml` | YAML parsing | ^2.x |
| `ssh2` | SSH remote operations (Phase 3) | ^1.x |

No additional frameworks. Standard Node.js `EventEmitter` for the event bus. `commander` or `yargs` for CLI parsing (evaluate which is lighter).

### Security Considerations

- **API key handling**: Keys are read from environment variables only. Never serialized to disk, logs, or template exports. The `orkagent save` command explicitly strips any inline key references.
- **Tool sandboxing**: The `PermissionGuard` sits between the runner and the tool registry. Provider adapters have no direct access to the tool layer, so a compromised adapter cannot bypass permissions.
- **Plugin isolation**: Plugins cannot access raw provider SDK instances or API keys. They receive `StreamEvent` data only. Plugin-provided tools are subject to the same permission guard as built-in tools. However, since plugins run in-process, a deliberately malicious plugin with full Node.js access could bypass these controls. This is documented as a known limitation (see Open Questions in requirements).
- **SSH security**: Only key-based authentication supported. No password auth. Keys must be specified explicitly in config or via SSH agent forwarding. Connection strings are validated to prevent injection.
- **Input validation**: All external input (YAML config, plugin manifests, template manifests) is validated via Zod schemas before processing.

### Performance Considerations

- **Batched rendering**: The store emits change notifications on a 50-100ms timer, not per-event. The TUI subscribes to these batched notifications. This prevents render thrashing with multiple fast-streaming agents.
- **Virtual scrolling**: Agent output buffers are capped at 10,000 lines. The `AgentPane` component renders only visible lines plus a small overscan buffer. Older lines are available via scroll-back but not in the React render tree.
- **Memory management**: Each `AgentStoreEntry.outputBuffer` is a ring buffer. When it reaches 10,000 lines, the oldest lines are evicted. Conversation history (`messages`) is not trimmed (needed for context), but the store tracks memory pressure and can warn the user.
- **Provider streaming**: All providers use streaming APIs. No response buffering -- events flow through as `AsyncIterable` chunks.
- **Single process**: No worker threads or child processes for MVP. The Node.js event loop handles all concurrency via async/await. This is sufficient because the CPU-bound work is minimal (parsing stream chunks, updating store); all I/O is async.

### Testing Strategy

- **Unit tests**: Zod schema validation, store reducers, provider event normalization, permission guard logic, dependency cycle detection. Use Vitest.
- **Integration tests**: Full agent lifecycle with a mock provider that returns canned `StreamEvent` sequences. Verify store state transitions, restart behavior, cost tracking.
- **E2E tests**: Launch `orkagent up` with a test config pointing at a mock HTTP server. Verify TUI output using `ink-testing-library`. Verify keybinding behavior.
- **Snapshot tests**: TUI component rendering with `ink-testing-library` snapshots for each agent state (running, idle, error, paused).

---

## Alternatives Considered

### Process Model: Worker Threads per Agent

- **Pros**: True isolation between agents; one agent's CPU-bound work cannot block others; crash isolation is automatic at the OS level.
- **Cons**: Significantly more complex IPC for store updates and TUI rendering; higher memory overhead per agent; worker threads require serialization of all cross-boundary data; debugging is harder.
- **Decision**: Rejected for MVP. The workload is I/O-bound (API streaming), not CPU-bound. Async error boundaries provide sufficient isolation. Can revisit if profiling reveals event loop contention with many agents.

### TUI Framework: Blessed vs Ink

- **Pros (Blessed)**: More mature, lower-level control, no React dependency.
- **Cons (Blessed)**: Unmaintained (last release 2017), imperative API leads to complex state management, no component model.
- **Pros (Ink)**: Active maintenance, React component model aligns with centralized store pattern, declarative rendering, `ink-testing-library` for testing.
- **Decision**: Ink selected. The React component model fits the "pure display, centralized store" architecture. The testing story is stronger.

### Config Format: YAML vs TOML vs JSON

- **Pros (TOML)**: Less ambiguous than YAML, good for config files.
- **Cons (TOML)**: Less familiar to the target audience (devs used to docker-compose YAML), nested structures are verbose.
- **Pros (JSON)**: No parsing ambiguity, native to TypeScript.
- **Cons (JSON)**: No comments, verbose, poor DX for hand-editing.
- **Decision**: YAML selected. The target audience is familiar with YAML from docker-compose, Kubernetes, and GitHub Actions. Zod validation eliminates YAML ambiguity risks at parse time.

### Template Registry: npm vs Git

- **Pros (npm)**: Established package ecosystem, versioning built-in, `npx` for running tools.
- **Cons (npm)**: Heavyweight for config-only packages, publishing friction, npm account required.
- **Pros (Git)**: Templates are just repos -- fork is `git clone`, publish is `git push`, no registry account needed beyond GitHub, version tags map naturally.
- **Decision**: Git-based registry selected. Lower friction for sharing, aligns with the "fork and customize" workflow, no additional account requirements.

### State Management: Redux-like vs Simple EventEmitter

- **Pros (Redux-like)**: Predictable state transitions, middleware for side effects, time-travel debugging.
- **Cons (Redux-like)**: Boilerplate, overkill for the state complexity level, external dependency.
- **Decision**: Simple typed store with `EventEmitter` for change notifications. The state shape is straightforward (agent entries + focused ID + costs). If complexity grows, can migrate to a reducer pattern without changing the component API.

---

## References

- [Ink -- React for CLIs](https://github.com/vadimdemedes/ink)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat)
- [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Zod Documentation](https://zod.dev)
- [EARS Notation](https://alistairmavin.com/ears/)
- [Andrej Karpathy -- "Bigger IDE" concept (Mar 11, 2026)](https://twitter.com/karpathy)
