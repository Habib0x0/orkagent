<p align="center">
  <img src="https://img.shields.io/badge/orkagent-agent%20command%20center-blue?style=for-the-badge&labelColor=000" alt="orkagent" />
</p>

<p align="center">
  <strong>One terminal to orchestrate all your AI agents.</strong>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#configuration">Config</a> ·
  <a href="#plugins">Plugins</a> ·
  <a href="#templates">Templates</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/orkagent"><img src="https://img.shields.io/npm/v/orkagent?style=flat-square&color=blue" alt="npm" /></a>
  <a href="https://github.com/Habib0x/orkagent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square" alt="node" />
</p>

---

Your AI agents are scattered across terminal tabs. You copy-paste between them, lose context, forget what each one is doing. Orkagent fixes that.

It launches multiple LLM agents from a single YAML file, renders them in a tmux-style terminal UI (one agent full-screen, cycle between them), lets them watch each other, share context, and use tools -- all with per-agent permissions and cost guardrails. Mix Claude, GPT, and Ollama in the same team.

| | |
|---|---|
| **Multi-Provider** | Run Claude, GPT-4o, and Llama side by side. One config, any model. |
| **Live TUI** | tmux-style terminal UI -- one agent full-screen, cycle between them with keybindings. |
| **Agent Communication** | Agents watch each other via pub/sub. Output from one feeds into another. |
| **Tool Sandboxing** | Per-agent permission allow-lists. File, shell, web tools with approval prompts. |
| **Cost Guardrails** | Per-agent and session-wide cost limits. Auto-pause when budgets are hit. |
| **Plugin System** | Extend with custom providers, tools, and lifecycle hooks. Security-sandboxed. |
| **Templates** | Save, publish, fork, and search reusable agent topologies. |

---

## Quickstart

```bash
npm install -g orkagent
```

Initialize a starter config:

```bash
orkagent init
```

This creates `agents.yaml` in your current directory. Edit it, then launch:

```bash
orkagent up
```

Validate your config without launching:

```bash
orkagent validate
```

---

## Configuration

Define your agent team in `agents.yaml`:

```yaml
version: 1

agents:
  researcher:
    provider: ollama
    model: llama3.2
    system: You are a research assistant.
    max_restarts: 5

  coder:
    provider: anthropic
    model: claude-sonnet-4-5-20250514
    watches:
      - researcher          # sees researcher's output in real time
    depends_on:
      - researcher          # waits for researcher to start first
    context_from:
      - researcher          # injects researcher's output into system prompt
    tools:
      - file_read
      - file_write
      - shell
    max_cost: 5.0           # pause this agent after $5

  reviewer:
    provider: openai
    model: gpt-4o
    watches:
      - coder
    tools:
      - file_read

teams:
  default:
    agents:
      - researcher
      - coder
      - reviewer

session:
  max_cost: 15.0            # pause all agents after $15 total
```

### Agent options

| Field | Description |
|---|---|
| `provider` | `anthropic`, `openai`, or `ollama` |
| `model` | Model name (e.g. `claude-sonnet-4-5-20250514`, `gpt-4o`, `llama3.2`) |
| `system` | System prompt |
| `watches` | Agent IDs whose output this agent observes via pub/sub |
| `depends_on` | Agent IDs that must start before this one |
| `context_from` | Agent IDs whose output is injected into this agent's system prompt |
| `tools` | Allow-list of tools: `file_read`, `file_write`, `shell`, `web_search` |
| `max_cost` | Per-agent cost limit in USD |
| `max_restarts` | Max restart attempts (default: 3) |
| `remote` | SSH config for remote tool execution |

---

## TUI Keybindings

The TUI uses a tmux-style layout: one agent is shown full-screen at a time, with a tab bar at the bottom showing all agents.

**Navigation:**

| Key | Action |
|---|---|
| `n` / Right arrow / Tab | Next agent |
| `p` / Left arrow | Previous agent |
| `1`-`9` | Jump to agent by index |

**Input mode:**

| Key | Action |
|---|---|
| `i` / `Enter` | Enter input mode (send message to active agent) |
| `Escape` | Exit input mode |

**Agent control (Ctrl-b prefix):**

| Key | Action |
|---|---|
| `Ctrl-b r` | Restart active agent |
| `Ctrl-b x` | Stop active agent |
| `Ctrl-b n` | Next agent |
| `Ctrl-b p` | Previous agent |

**Status bar indicators:**

| Symbol | State |
|---|---|
| `*` (green) | Running |
| `-` (yellow) | Idle / Pending |
| `\|` (cyan) | Paused |
| `.` (gray) | Done |
| `!` (red) | Error |

---

## How it works

```
agents.yaml
     ↓
 Config Loader (Zod validation, cycle detection)
     ↓
 Orchestrator
     ├── AgentRunner (researcher)  →  Ollama adapter   →  StreamEvents
     ├── AgentRunner (coder)       →  Anthropic adapter →  StreamEvents
     └── AgentRunner (reviewer)    →  OpenAI adapter    →  StreamEvents
                                                              ↓
                                                     Centralized Store
                                                              ↓
                                                    Batched TUI Render
                                                              ↓
                                                        Terminal
```

**Tool call flow:**

```
Agent requests tool_call
        ↓
  PermissionGuard
        ↓
  In allow-list? ── YES ──→ Execute tool → Return result to agent
        ↓ NO
  Approval prompt in TUI
        ↓
  Approve → Execute    Deny → Error returned to agent
```

Each agent runs in its own error boundary. One agent crashing never takes down the others. Failed agents auto-restart with backoff (up to `max_restarts` within a 5-minute window).

---

## Plugins

Extend orkagent with custom providers, tools, and lifecycle hooks.

### Plugin manifest

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "type": "tool",
  "entry": "dist/index.js",
  "provides": {
    "tools": ["my_custom_tool"]
  }
}
```

### Plugin module

```typescript
import type { PluginModule } from "orkagent";

export const tools = [
  {
    definition: {
      name: "my_custom_tool",
      description: "Does something useful",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
    invoker: async (input) => ({
      id: crypto.randomUUID(),
      output: `Result for: ${input.query}`,
      isError: false,
    }),
  },
];

export const hooks = {
  onAgentStart: (agentId, config) => {
    console.log(`Agent ${agentId} started`);
  },
  onAgentDone: (agentId) => {
    console.log(`Agent ${agentId} finished`);
  },
};
```

### Security sandbox

Plugins run in-process but inside a security sandbox:

- No access to raw SDK instances or API keys
- Tool invocations go through `PermissionGuard`
- Forbidden hooks (`onPermissionChange`, `onConfigMutate`, `onAllowListModify`) are rejected
- Exceptions in plugin tools are caught and returned as error results -- never crash the host

### Lifecycle hooks

| Hook | When it fires |
|---|---|
| `onAgentStart` | Agent runner begins |
| `onMessage` | Agent receives or sends a message |
| `onToolCall` | Agent invokes a tool |
| `onError` | Agent encounters an error |
| `onAgentDone` | Agent runner completes |

### Enable plugins in config

```yaml
plugins:
  - name: my-plugin
  - name: another-plugin
```

---

## Templates

Save and share reusable agent topologies.

```bash
# Package current config as a template
orkagent save my-research-team

# Publish to a git registry
orkagent publish my-research-team

# Fork someone else's template
orkagent fork https://github.com/user/orkagent-templates --name my-copy

# Search the registry
orkagent templates search "code review"
```

Templates bundle your `agents.yaml` with a manifest describing the team topology, making it easy to share proven agent configurations.

---

## Built-in tools

| Tool | What it does |
|---|---|
| `file_read` | Read file contents (30s timeout) |
| `file_write` | Write file with auto-mkdir (30s timeout) |
| `shell` | Execute commands via `execFile` -- no shell injection, path traversal prevention, configurable cwd jail |
| `web_search` | Web search with configurable result count |

### Remote execution

Tools can run on remote machines via SSH:

```yaml
agents:
  deployer:
    provider: anthropic
    model: claude-sonnet-4-5-20250514
    tools:
      - shell
    remote:
      host: prod-server.example.com
      user: deploy
      privateKeyPath: ~/.ssh/id_ed25519
```

Key-based auth only. No password authentication.

---

## CLI commands

| Command | Purpose |
|---|---|
| `orkagent up` | Launch agents from config |
| `orkagent up --team backend` | Launch a specific team |
| `orkagent up --resume` | Resume a previous session |
| `orkagent up --plain` | Non-interactive mode (JSON to stdout) |
| `orkagent validate` | Validate config without launching |
| `orkagent init` | Generate starter `agents.yaml` |
| `orkagent save <name>` | Package config as template |
| `orkagent publish <name>` | Push template to git registry |
| `orkagent fork <url>` | Clone and customize a template |
| `orkagent templates search <q>` | Search template registry |

---

## Cost tracking

Orkagent tracks token usage and estimated cost per agent in real time, displayed in the status bar.

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|---|---|---|
| `claude-opus-4-5` | $15.00 | $75.00 |
| `claude-sonnet-4-5` | $3.00 | $15.00 |
| `claude-haiku-3-5` | $0.80 | $4.00 |
| `gpt-4o` | $5.00 | $15.00 |
| `gpt-4o-mini` | $0.15 | $0.60 |
| Ollama (local) | Free | Free |

Set `max_cost` per agent or per session. Agents auto-pause when limits are hit.

---

## Architecture

```
src/
├── index.ts              CLI entry point (commander)
├── config.ts             YAML + Zod validation
├── orchestrator.ts       Agent lifecycle management
├── runner.ts             Single agent conversation loop
├── store.ts              Centralized state with batched updates
├── eventbus.ts           Pub/sub for inter-agent messaging
├── hooks.ts              Lifecycle hook registry
├── providers/
│   ├── types.ts          StreamEvent + AgentProvider interfaces
│   ├── anthropic.ts      Claude adapter
│   ├── openai.ts         GPT adapter
│   └── ollama.ts         Ollama adapter
├── tools/
│   ├── registry.ts       Tool registration and lookup
│   ├── permission.ts     PermissionGuard with approval prompts
│   ├── ssh.ts            Remote tool execution
│   └── builtin/          file_read, file_write, shell, web_search
├── ui/
│   ├── App.tsx           tmux-style layout and keybinding router
│   ├── AgentPane.tsx     Full-screen agent output pane
│   ├── StatusBar.tsx     tmux-style tab bar with state indicators
│   ├── InputBar.tsx      Message input
│   └── ApprovalPrompt.tsx Tool permission modal
├── plugins/
│   ├── loader.ts         Plugin discovery and loading
│   ├── manifest.ts       Manifest schema (Zod)
│   └── sandbox.ts        Security boundaries
└── templates/
    ├── save.ts           Package config as template
    ├── publish.ts        Push to git registry
    ├── fork.ts           Clone and customize
    ├── search.ts         Search registry
    └── manifest.ts       Template manifest schema
```

**Key design decisions:**

- **Adapter pattern** -- All providers normalize to a unified `StreamEvent` type. The orchestrator never imports provider SDKs directly.
- **Centralized store** -- Single source of truth with batched change notifications (50-100ms) to prevent render thrashing with many streaming agents.
- **Error boundaries** -- Each `AgentRunner` has isolated error handling. Agent crashes don't cascade.
- **DFS cycle detection** -- Circular `depends_on` references are caught at config load time, not at runtime.

---

## Tech stack

| Dependency | Purpose |
|---|---|
| [Ink](https://github.com/vadimdemedes/ink) | React for CLIs -- terminal UI components |
| [React](https://react.dev) | Component model for Ink |
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | Claude API |
| [openai](https://github.com/openai/openai-node) | OpenAI API |
| [commander](https://github.com/tj/commander.js) | CLI argument parsing |
| [ssh2](https://github.com/mscdex/ssh2) | SSH protocol for remote tools |
| [zod](https://github.com/colinhacks/zod) | Schema validation |
| [yaml](https://github.com/eemeli/yaml) | YAML parsing |

---

## Development

```bash
git clone https://github.com/Habib0x/orkagent.git
cd orkagent
npm install
npm run build
npm run test       # 378 tests across 28 suites
```

---

## The name

**Or** (Orchestrate) + **Ka** (Karpathy) + **gent** (Agent).

Inspired by Andrej Karpathy's vision of the "bigger IDE" -- a command center where multiple AI agents collaborate on complex tasks, each with their own role, tools, and context.

---

<p align="center">
  <strong>Stop juggling terminal tabs. Orchestrate.</strong>
</p>
