# Requirements: Orkagent

> Agent command center -- a TypeScript CLI/TUI tool for orchestrating multi-agent AI workflows

## Overview

Orkagent solves the problem of managing multiple AI agents across scattered terminal windows with no unified visibility, coordination, or reusable topologies. It provides a TUI-based orchestrator where users define agent teams in YAML, launch them with `orkagent up`, observe all agents from a single terminal, enable agent-to-agent communication, sandbox tool access, extend via plugins, and share/fork agent topologies.

Delivery is phased: Core Foundation (P1), Agent Communication (P2), Tool Sandboxing (P3), Plugin System (P4), Forking and Template Marketplace (P5).

---

## User Stories

### US-1: Launch Agent Team from YAML Config

**As a** solo developer
**I want** to define my agent team in a YAML file and launch all agents with a single command
**So that** I can start a multi-agent workflow without manually configuring each agent

#### Acceptance Criteria (EARS Notation)

1. WHEN the user runs `orkagent up` in a directory containing `agents.yaml`
   THE SYSTEM SHALL parse the YAML file, validate it against the Zod schema, and start all agents defined in the active team.

2. WHEN the `agents.yaml` file fails Zod schema validation
   THE SYSTEM SHALL exit with a non-zero code and display each validation error with the exact YAML path, expected type, and received value.

3. WHEN the user runs `orkagent up` and no `agents.yaml` exists in the current directory
   THE SYSTEM SHALL exit with a non-zero code and display a message indicating no config file was found.

4. WHEN the user runs `orkagent up -f <path>`
   THE SYSTEM SHALL load the config from the specified file path instead of the default `agents.yaml`.

5. WHEN a provider API key is missing for any agent in the config
   THE SYSTEM SHALL exit with a non-zero code and identify the agent name and required environment variable before attempting any API calls.

**Phase**: 1

---

### US-2: Observe All Agents in Split-Pane TUI

**As a** solo developer
**I want** to see live streaming output from all running agents in a split-pane terminal view
**So that** I can monitor the entire team's work without switching between windows

#### Acceptance Criteria (EARS Notation)

1. WHEN agents are running
   THE SYSTEM SHALL render each agent's streaming output in its own pane within the TUI, updating at 50-100ms batched intervals.

2. WHEN the number of running agents exceeds the visible pane capacity
   THE SYSTEM SHALL provide virtual scrolling so the user can navigate to off-screen agent panes with no more than 16ms additional render latency per pane beyond the visible viewport.

3. THE SYSTEM SHALL display a status bar showing each agent's state (running, idle, done, error), cumulative input/output token counts, and estimated cost in USD.

4. WHEN the terminal is resized
   THE SYSTEM SHALL re-layout all panes proportionally within 100ms.

5. WHEN an agent emits a tool call event
   THE SYSTEM SHALL display the tool name and a truncated summary of the input in that agent's pane, visually distinct from text output.

**Phase**: 1

---

### US-3: Focus and Interact with Individual Agents

**As a** solo developer
**I want** to focus on a single agent and send it messages
**So that** I can steer an agent's work or provide additional instructions mid-run

#### Acceptance Criteria (EARS Notation)

1. WHEN the user presses the configured focus keybinding (vim-style hjkl navigation or numeric agent index)
   THE SYSTEM SHALL expand the selected agent's pane to full width and dim other panes.

2. WHEN an agent pane is focused and the user types a message and presses Enter
   THE SYSTEM SHALL append the message to that agent's conversation history and send it to the provider as a new user turn.

3. WHEN the user presses Escape or the configured unfocus keybinding
   THE SYSTEM SHALL return to the split-pane overview layout.

4. WHEN the user presses the tmux-style prefix key followed by a command key
   THE SYSTEM SHALL execute the corresponding agent command (restart, stop, show logs).

**Phase**: 1

---

### US-4: Multi-Provider Agent Configuration

**As a** solo developer
**I want** to mix agents from different LLM providers in a single team
**So that** I can use the best model for each task (e.g., Claude for research, GPT-4o for code)

#### Acceptance Criteria (EARS Notation)

1. WHEN an agent specifies `provider: anthropic` in the config
   THE SYSTEM SHALL route that agent's messages through the Anthropic adapter using the `ANTHROPIC_API_KEY` environment variable.

2. WHEN an agent specifies `provider: openai` in the config
   THE SYSTEM SHALL route that agent's messages through the OpenAI adapter using the `OPENAI_API_KEY` environment variable.

3. WHEN an agent specifies `provider: ollama` in the config
   THE SYSTEM SHALL route that agent's messages through the Ollama adapter connecting to `http://localhost:11434` by default or the URL specified in `OLLAMA_HOST`.

4. WHILE an agent is streaming a response
   THE SYSTEM SHALL normalize all provider-specific events into the unified `StreamEvent` type before passing them to the store.

5. WHEN a provider returns a rate limit error (HTTP 429 or equivalent)
   THE SYSTEM SHALL pause that agent's requests, apply exponential backoff starting at 1 second with a maximum of 60 seconds, and display the throttling status in the agent's pane.

**Phase**: 1

---

### US-5: Agent-to-Agent Communication via Pub/Sub

**As a** solo developer
**I want** agents to observe each other's output and react to it
**So that** I can build pipelines where one agent's output feeds into another's work

#### Acceptance Criteria (EARS Notation)

1. WHEN an agent config includes a `watches` array listing other agent names
   THE SYSTEM SHALL forward completed message events from watched agents to the watching agent as context injections.

2. WHEN an agent config includes `depends_on` listing other agent names
   THE SYSTEM SHALL delay starting that agent until all dependencies have reached "idle" or "done" state.

3. WHEN an agent config includes `context_from` listing other agent names
   THE SYSTEM SHALL inject the final output of the referenced agents into the dependent agent's system prompt before its first message.

4. WHEN a watched agent emits a `done` event
   THE SYSTEM SHALL deliver the event to all watchers within the next render cycle (50-100ms).

5. WHEN a circular dependency is detected in `depends_on` declarations
   THE SYSTEM SHALL reject the config at validation time with a clear error identifying the cycle.

**Phase**: 2

---

### US-6: Event Bus for Inter-Agent Messaging

**As a** solo developer
**I want** agents to send structured messages to each other through a typed event bus
**So that** complex multi-agent workflows can coordinate beyond simple output watching

#### Acceptance Criteria (EARS Notation)

1. THE SYSTEM SHALL provide a typed event bus supporting publish, subscribe, and unsubscribe operations keyed by event type string.

2. WHEN an agent tool call produces an event tagged for another agent
   THE SYSTEM SHALL route that event through the event bus to the target agent's message queue.

3. WHEN an agent subscribes to an event type and no events of that type are published within the agent's lifetime
   THE SYSTEM SHALL NOT produce any error or side effect.

4. WHEN the event bus receives a message for an agent that has already completed
   THE SYSTEM SHALL log the undelivered event at debug level and discard it.

**Phase**: 2

---

### US-7: Tool Sandboxing with Declarative Permissions

**As a** solo developer
**I want** each agent's tool access controlled by an explicit allow-list in the config
**So that** I can prevent agents from performing dangerous operations without my knowledge

#### Acceptance Criteria (EARS Notation)

1. WHEN an agent config declares `tools: [file_read, file_write]`
   THE SYSTEM SHALL only permit that agent to invoke the `file_read` and `file_write` tools; any other tool call SHALL be blocked.

2. WHEN an agent attempts a tool call not listed in its declared tools
   THE SYSTEM SHALL prompt the user in the TUI for explicit approval before executing, displaying the tool name, input summary, and the requesting agent's name.

3. WHEN the user denies an out-of-scope tool call
   THE SYSTEM SHALL return a tool error result to the agent indicating the operation was denied by the user.

4. WHEN the user approves an out-of-scope tool call
   THE SYSTEM SHALL execute the tool and optionally offer to add it to the agent's allow-list for the remainder of the session.

5. WHEN an agent declares `tools: [shell]` with path restrictions (e.g., `shell: { cwd: "./src" }`)
   THE SYSTEM SHALL reject any shell command that attempts to operate outside the declared path.

6. THE SYSTEM SHALL enforce isolation boundaries such that one agent's file operations cannot read or modify another agent's declared working directory unless explicitly permitted.

**Phase**: 3

---

### US-8: Unified Tool Layer with Provider Fallback

**As a** solo developer
**I want** a consistent tool interface across all providers
**So that** I can use the same tool definitions regardless of which LLM backend an agent uses

#### Acceptance Criteria (EARS Notation)

1. THE SYSTEM SHALL provide built-in tool implementations for `file_read`, `file_write`, `shell`, and `web_search` that work identically across all providers.

2. WHEN a provider natively supports a tool (e.g., Anthropic's computer use tools)
   THE SYSTEM SHALL use the native implementation by default unless the config explicitly specifies `tools_mode: unified`.

3. WHEN the unified tool layer is active for an agent
   THE SYSTEM SHALL translate tool calls from the provider's format into the unified tool interface and translate results back.

4. WHEN a tool execution exceeds 30 seconds (configurable per-tool)
   THE SYSTEM SHALL terminate the tool execution and return a timeout error to the agent.

**Phase**: 3

---

### US-9: Plugin System for Custom Extensions

**As a** plugin author
**I want** to create plugins that add custom providers, tools, or lifecycle hooks
**So that** I can extend orkagent's capabilities for my specific workflow needs

#### Acceptance Criteria (EARS Notation)

1. WHEN a plugin is listed in the `plugins` section of `agents.yaml`
   THE SYSTEM SHALL load the plugin from `node_modules` or the specified local path at startup.

2. WHEN a plugin exports an `AgentProvider` implementation
   THE SYSTEM SHALL register it as an available provider that can be referenced by agent configs.

3. WHEN a plugin exports tool definitions
   THE SYSTEM SHALL make those tools available for agents to declare in their `tools` array.

4. WHEN a plugin registers lifecycle hooks (onAgentStart, onMessage, onToolCall, onError, onAgentDone)
   THE SYSTEM SHALL invoke the hooks at the appropriate points in the agent lifecycle, in registration order.

5. WHEN a plugin fails to load (missing module, invalid manifest, runtime error)
   THE SYSTEM SHALL log the error, skip the plugin, and continue startup with a warning displayed in the status bar.

6. THE SYSTEM SHALL validate each plugin against a manifest schema (name, version, type, entry point) at load time.

**Phase**: 4

---

### US-10: Plugin Security Boundaries

**As a** solo developer
**I want** plugins to be isolated from the sandboxing system
**So that** a malicious or buggy plugin cannot bypass agent permission controls

#### Acceptance Criteria (EARS Notation)

1. THE SYSTEM SHALL execute plugin-provided tools through the same permission layer as built-in tools, subject to the agent's declared allow-list.

2. WHEN a plugin attempts to register a lifecycle hook that modifies agent permissions at runtime
   THE SYSTEM SHALL reject the hook registration and log a security warning.

3. THE SYSTEM SHALL NOT expose the raw provider SDK instances or API keys to plugins; plugins receive only the normalized `StreamEvent` interface.

4. WHEN a plugin-provided tool throws an unhandled exception
   THE SYSTEM SHALL catch the exception, return a tool error to the agent, and log the stack trace without crashing the process.

**Phase**: 4

---

### US-11: Save and Share Agent Topologies as Templates

**As a** team lead
**I want** to save my agent team configuration as a reusable template
**So that** my team can reuse proven agent topologies without reconfiguring from scratch

#### Acceptance Criteria (EARS Notation)

1. WHEN the user runs `orkagent save <name>`
   THE SYSTEM SHALL package the current `agents.yaml` (with API keys stripped) into a template directory with a `template.yaml` manifest containing name, version, description, and required environment variables.

2. WHEN the user runs `orkagent publish <name>`
   THE SYSTEM SHALL push the template directory to the configured git remote as a tagged commit.

3. WHEN a template references plugins
   THE SYSTEM SHALL include the plugin names and version constraints in the template manifest's `dependencies` section.

**Phase**: 5

---

### US-12: Fork and Customize Agent Topologies

**As a** community member
**I want** to browse published templates and fork them for my own use
**So that** I can start from a proven topology and customize it for my needs

#### Acceptance Criteria (EARS Notation)

1. WHEN the user runs `orkagent fork <repo-url>`
   THE SYSTEM SHALL clone the git repository into the current directory and rename the project in the manifest.

2. WHEN the user runs `orkagent fork <repo-url> --name <custom-name>`
   THE SYSTEM SHALL clone the repository and set the template name to the provided custom name.

3. WHEN a forked template has plugin dependencies
   THE SYSTEM SHALL display the required plugins and prompt the user to install them via npm.

4. WHEN the user runs `orkagent templates search <query>`
   THE SYSTEM SHALL search the configured git registry index for templates matching the query and display name, description, star count, and last updated date.

**Phase**: 5

---

### US-13: Agent Error Recovery and Cost Control

**As a** solo developer
**I want** crashed agents to auto-restart and cost limits to be enforced
**So that** long-running agent sessions do not fail permanently or run up unexpected bills

#### Acceptance Criteria (EARS Notation)

1. WHEN an agent crashes due to a provider error (non-rate-limit)
   THE SYSTEM SHALL automatically restart the agent with its conversation history preserved, up to 3 restart attempts within 5 minutes.

2. WHEN an agent exceeds its restart limit
   THE SYSTEM SHALL mark the agent as "failed", display the last error in its pane, and notify the user via the status bar.

3. WHEN an agent's cumulative cost exceeds the per-agent cost limit defined in config (default: no limit)
   THE SYSTEM SHALL pause the agent and prompt the user to approve continued spending or stop the agent.

4. WHEN the session's total cost across all agents exceeds the session cost limit defined in config
   THE SYSTEM SHALL pause all agents and prompt the user before continuing.

5. WHEN a rate limit response includes a `Retry-After` header or equivalent
   THE SYSTEM SHALL use that value for the backoff duration rather than the default exponential schedule.

**Phase**: 1 (basic restart + rate limits), Phase 3 (cost guardrails)

---

### US-14: SSH Remote Agent Execution

**As a** solo developer
**I want** agents to execute tools on remote machines via SSH
**So that** I can orchestrate work across multiple environments from a single terminal

#### Acceptance Criteria (EARS Notation)

1. WHEN an agent config includes `remote: { host: "...", user: "...", key: "~/.ssh/id_ed25519" }`
   THE SYSTEM SHALL establish an SSH connection and route that agent's `shell` and `file` tool calls to the remote machine.

2. WHEN SSH authentication fails
   THE SYSTEM SHALL mark the agent as "error", display the connection failure reason, and NOT retry automatically (SSH errors are not transient).

3. WHEN an SSH connection drops during an active tool call
   THE SYSTEM SHALL return a tool error to the agent and attempt to re-establish the connection once before marking the agent as errored.

4. THE SYSTEM SHALL support key-based authentication and SSH agent forwarding; password authentication SHALL NOT be supported.

**Phase**: 3

---

## Non-Functional Requirements

### NFR-1: Render Performance

- THE SYSTEM SHALL batch all stream events and re-render the TUI at intervals between 50ms and 100ms, never per-event.
- THE SYSTEM SHALL maintain a TUI frame rate that does not drop below 15 FPS with 20 concurrently streaming agents.
- THE SYSTEM SHALL use virtual scrolling for agent output buffers, retaining at most the last 10,000 lines per agent in memory.

### NFR-2: Startup Performance

- THE SYSTEM SHALL complete config validation and begin agent initialization within 500ms of `orkagent up` invocation (excluding provider API latency).
- THE SYSTEM SHALL validate the YAML config synchronously before any async provider initialization.

### NFR-3: Memory Usage

- THE SYSTEM SHALL NOT exceed 512 MB RSS with 10 concurrently active agents.
- THE SYSTEM SHALL trim agent output buffers using a rolling window when the buffer exceeds 10,000 lines, evicting the oldest entries to stay within the 512 MB RSS target.

### NFR-4: Security

- THE SYSTEM SHALL never log, display, or include API keys in error messages, template exports, or debug output.
- THE SYSTEM SHALL enforce tool permissions at the orchestrator layer, not within provider adapters, so that no provider bypass is possible.
- THE SYSTEM SHALL validate all YAML input against the Zod schema before any processing to prevent injection attacks via malformed config.

### NFR-5: Reliability

- THE SYSTEM SHALL isolate each agent in its own error boundary so that one agent's crash does not affect other agents.
- THE SYSTEM SHALL persist agent conversation history to a local session file so that `orkagent up --resume` can recover a previous session.

### NFR-6: Accessibility

- THE SYSTEM SHALL support terminal screen readers by providing structured text output alongside the TUI (via `--plain` flag for non-interactive mode).
- THE SYSTEM SHALL use distinct colors AND text indicators (icons/labels) for agent states so that status is not conveyed by color alone.

### NFR-7: Compatibility

- THE SYSTEM SHALL support Node.js 20 LTS and above.
- THE SYSTEM SHALL function in terminal emulators supporting 256-color mode (xterm-256color).
- THE SYSTEM SHALL function on macOS, Linux, and Windows (via WSL).

---

## Out of Scope

- Web UI, desktop application, or any graphical interface beyond the terminal TUI
- Building, training, or fine-tuning AI models
- Hosting or running LLM inference locally (Ollama is accessed as an external service)
- Multi-user collaboration or concurrent access to the same orkagent session
- Agent memory persistence across sessions beyond conversation history (no vector DB, no RAG)
- Cost tracking integration with billing APIs (cost is estimated from token counts and published pricing)

---

## Assumptions

1. Users have valid API keys for their configured providers set as environment variables.
2. Ollama is pre-installed and running when `provider: ollama` is used.
3. The terminal emulator supports ANSI escape codes and mouse events (for Ink).
4. SSH remote targets have the necessary tools (shell, filesystem) available on the remote machine.
5. Templates in the git-based registry follow the manifest schema; no server-side validation exists.
6. Plugin authors are semi-trusted -- the plugin security model prevents accidental sandbox violations but does not protect against deliberately malicious code with full Node.js access.

---

## Open Questions

- [x] **Plugin security model**: Decided -- plugins run in-process with a `PluginSandbox` boundary. The sandbox wraps tool invokers (catching exceptions) and enforces a forbidden hook deny-list (e.g., `onPermissionChange`). Capability-based manifest permissions deferred to a future phase. See Assumption 6.
- [x] **Watch event filtering**: Decided -- watches trigger on all `StreamEvent` types from the watched agent. Fine-grained event filtering deferred to a future phase; users can filter in their agent's system prompt.
- [x] **SSH authentication**: Decided -- orkagent supports explicit key paths and SSH agent forwarding via `SSH_AUTH_SOCK`. Reading `~/.ssh/config` for host aliases is deferred to a future phase.
- [x] **Session persistence format**: Decided -- JSON. Simplest to implement, human-readable for debugging. SQLite migration can be considered if performance becomes an issue with large sessions.

---

## Traceability Matrix

| Requirement | Phase | User Role |
|---|---|---|
| US-1 | 1 | Solo developer |
| US-2 | 1 | Solo developer |
| US-3 | 1 | Solo developer |
| US-4 | 1 | Solo developer |
| US-5 | 2 | Solo developer |
| US-6 | 2 | Solo developer |
| US-7 | 3 | Solo developer |
| US-8 | 3 | Solo developer |
| US-9 | 4 | Plugin author |
| US-10 | 4 | Solo developer |
| US-11 | 5 | Team lead |
| US-12 | 5 | Community member |
| US-13 | 1, 3 | Solo developer |
| US-14 | 3 | Solo developer |
