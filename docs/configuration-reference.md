# Configuration Reference

All orkagent behavior is controlled by a single YAML file, `agents.yaml` by default. The file is validated against a Zod schema on every `orkagent up` or `orkagent validate` invocation.

---

## Top-Level Structure

```yaml
version: 1                        # required, must be exactly 1

agents:                           # required, at least one agent
  <agent-id>:
    ...

teams:                            # optional
  <team-name>:
    agents: [<agent-id>, ...]

plugins:                          # optional
  - name: <plugin-name>
    ...

session:                          # optional
  max_cost: <number>
  resume: <boolean>
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `1` (literal) | Yes | Schema version. Must be `1`. |
| `agents` | `Record<string, AgentConfig>` | Yes | Map of agent IDs to agent configs. |
| `teams` | `Record<string, TeamConfig>` | No | Named subsets of agents for targeted launch. |
| `plugins` | `PluginRef[]` | No | Plugins to load at startup. |
| `session` | `SessionConfig` | No | Session-wide settings. |

Agent IDs must be valid YAML keys (no spaces; underscores and hyphens are fine).

---

## `agents.<id>` - AgentConfig

Each key under `agents` is a unique agent ID. The value is an agent configuration object.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `"anthropic" \| "openai" \| "ollama"` | The LLM provider to use. |
| `model` | `string` (non-empty) | Model identifier passed directly to the provider API. |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `system` | `string` | none | System prompt passed as the first message to the model. |
| `tools` | `string[]` | `[]` | Allow-list of tool names the agent may call without prompting for approval. Any tool not in this list triggers an approval prompt. |
| `tools_mode` | `"unified" \| "native"` | none | Tool call format. `unified` uses the normalized internal format; `native` passes tool definitions in the provider's native format. |
| `watches` | `string[]` | none | Agent IDs to observe. When a watched agent emits output or completes a tool call, a message is injected into this agent's conversation. |
| `depends_on` | `string[]` | none | Agent IDs that must reach `idle` or `done` state before this agent starts. Circular dependencies are detected at load time and rejected. |
| `context_from` | `string[]` | none | Agent IDs whose final output buffer is prepended to this agent's system prompt before it starts. Implies the same wait behavior as `depends_on`. |
| `remote` | `RemoteConfig` | none | SSH connection config for remote tool invocation. When set, tool calls are routed to the remote host via SSH. |
| `max_cost` | `number` (positive) | none | Per-agent cost limit in USD. The agent is paused automatically when this threshold is exceeded. |
| `max_restarts` | `integer >= 0` | `3` | Maximum number of automatic restarts allowed within a 5-minute window before the agent transitions to `error` state. |

### Example

```yaml
agents:
  researcher:
    provider: anthropic
    model: claude-haiku-3-5
    system: You are a research assistant. Summarize findings concisely.
    tools:
      - file_read
      - web_search
    max_cost: 1.50
    max_restarts: 5
```

---

## `agents.<id>.remote` - RemoteConfig

When `remote` is set, tool calls for this agent are executed on the remote host over SSH rather than locally. Only key-based authentication is supported.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | `string` (non-empty) | Yes | Hostname or IP address of the remote machine. |
| `user` | `string` (non-empty) | Yes | SSH username. |
| `key` | `string` | No | Path to the SSH private key file. If omitted, the SSH agent (`SSH_AUTH_SOCK`) is used. |
| `port` | `integer > 0` | No | SSH port. Defaults to `22`. |

```yaml
agents:
  builder:
    provider: ollama
    model: qwen2.5:0.5b
    tools:
      - file_read
      - file_write
      - shell
    remote:
      host: build-server.internal
      user: ci
      key: ~/.ssh/id_ed25519
      port: 22
```

SSH authentication failures do not retry. Connection drops during tool execution attempt one reconnect before marking the agent as errored.

---

## `teams.<name>` - TeamConfig

Teams define named subsets of agents. Use `--team <name>` with `orkagent up` to launch only the agents in that team.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agents` | `string[]` (min 1) | Yes | List of agent IDs that belong to this team. |

```yaml
teams:
  review:
    agents:
      - analyzer
      - reviewer
      - fixer

  quick:
    agents:
      - analyzer
```

Launch a specific team:

```bash
orkagent up --team review
```

---

## `plugins` - PluginRef[]

Each entry in the `plugins` array declares a plugin to load at startup. Plugins can register additional tools and lifecycle hooks.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` (non-empty) | Yes | Plugin name. Used as the module specifier if `path` is not set. |
| `path` | `string` | No | Local file path to the plugin entry point. Overrides `name` as the module path. |
| `config` | `Record<string, unknown>` | No | Arbitrary config object stored with the plugin reference. Note: this value is not currently forwarded to the plugin module at load time; use environment variables to pass runtime config to plugins. |

```yaml
plugins:
  - name: orkagent-jira
    config:
      base_url: https://your-org.atlassian.net
      project: ENG

  - name: my-local-plugin
    path: ./plugins/my-tool.js
```

Plugin load failures produce a warning in the status bar but do not stop other agents from starting.

---

## `session` - SessionConfig

Session-level settings apply to the entire run.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_cost` | `number` (positive) | none | Session-wide cost limit in USD. When the sum of all agent costs exceeds this value, all running agents are paused. |
| `resume` | `boolean` | `false` | Reserved. Use `--resume` on the CLI instead. |

```yaml
session:
  max_cost: 20.00
```

---

## Built-in Tool Names

These tool names are registered by orkagent at startup and can be listed in any agent's `tools` allow-list:

| Tool name | Input schema | Description |
|-----------|-------------|-------------|
| `file_read` | `{ path: string }` | Read a file. Path is relative to the working directory. 30-second timeout. |
| `file_write` | `{ path: string, content: string }` | Write a file. Creates parent directories automatically. 30-second timeout. |
| `shell` | `{ command: string, cwd?: string }` | Execute a shell command. Returns combined stdout and stderr. Path traversal is rejected. 30-second timeout. |
| `web_search` | `{ query: string, num_results?: number }` | Search the web. Returns up to 10 results (default 5). 30-second timeout. |

Plugin tools add their own names to this list and can be placed in an agent's `tools` allow-list.

---

## Environment Variables

| Variable | Provider | Required | Description |
|----------|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | anthropic | Yes | Anthropic API key. Required if any agent uses `provider: anthropic`. |
| `OPENAI_API_KEY` | openai | Yes | OpenAI API key. Required if any agent uses `provider: openai`. |
| `OLLAMA_HOST` | ollama | No | Base URL for the Ollama API. Defaults to `http://localhost:11434`. |

API key validation happens during config load. A missing key causes an immediate error with the agent name and variable name in the message. API keys are never written to logs, session files, or template exports.

---

## Dependency and Communication Fields

### `depends_on`

Holds the agent back in `pending` state until all listed agents reach `idle` or `done`. Useful for strict sequencing.

```yaml
agents:
  step_b:
    provider: ollama
    model: qwen2.5:0.5b
    depends_on:
      - step_a
```

Circular dependencies (e.g., A depends on B which depends on A) are detected at load time and produce a `ConfigValidationError` listing all agents in the cycle.

### `context_from`

Before starting, collects the entire output buffer of each listed agent and prepends it to this agent's system prompt. The agent also waits for the listed agents to complete, so explicitly listing them in `depends_on` alongside `context_from` makes the intent clearer even though `context_from` implies the same wait.

```yaml
agents:
  writer:
    provider: ollama
    model: qwen2.5:0.5b
    depends_on:
      - researcher
    context_from:
      - researcher
```

### `watches`

Subscribes this agent to real-time events from the listed agents. Each time a watched agent emits a completion or tool result event, a user-turn message is injected into this agent's conversation. The watched agent does not need to finish first.

```yaml
agents:
  moderator:
    provider: ollama
    model: qwen2.5:0.5b
    watches:
      - pro
      - con
```

---

## Validation Rules

The following conditions cause `loadConfig` to throw `ConfigValidationError`:

- `version` is not `1`
- Any agent is missing `provider` or `model`
- `provider` is not one of `anthropic`, `openai`, `ollama`
- `model` is an empty string
- `max_restarts` is negative
- `max_cost` or `session.max_cost` is not a positive number
- `remote.port` is not a positive integer
- `teams.<name>.agents` is empty
- `plugins.<n>.name` is empty
- A circular dependency is found in the `depends_on` graph
- An Anthropic or OpenAI agent is present and the corresponding API key environment variable is not set

---

## Complete Example

```yaml
version: 1

agents:
  planner:
    provider: anthropic
    model: claude-haiku-3-5
    system: Design a minimal plan for the given task. Be concise.
    max_cost: 0.50

  coder:
    provider: anthropic
    model: claude-sonnet-4-5
    system: Implement the plan. Write clean, tested TypeScript.
    tools:
      - file_read
      - file_write
      - shell
    depends_on:
      - planner
    context_from:
      - planner
    max_cost: 3.00
    max_restarts: 5

  reviewer:
    provider: ollama
    model: qwen2.5:0.5b
    system: Review the implementation for correctness and security issues.
    tools:
      - file_read
    watches:
      - coder
    depends_on:
      - coder

teams:
  dev:
    agents:
      - planner
      - coder
      - reviewer

session:
  max_cost: 5.00
```
