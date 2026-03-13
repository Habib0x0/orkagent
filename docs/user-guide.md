# Orkagent User Guide

Orkagent is a CLI/TUI for running multiple AI agents in parallel from a single YAML config file. Agents stream output into a terminal dashboard, can communicate with each other, and can call tools to read files, run shell commands, or search the web.

The name combines **Or** (orchestrate) + **Ka** (Karpathy) + **gent** (agent).

---

## Installation

```bash
npm install -g orkagent
```

Verify the installation:

```bash
orkagent --version
# 0.1.0
```

---

## Quick Start

**1. Generate a starter config:**

```bash
orkagent init
```

This writes an `agents.yaml` in the current directory:

```yaml
version: 1

agents:
  assistant:
    provider: ollama
    model: llama3.2
    system: You are a helpful assistant.
```

**2. Start the agents:**

```bash
orkagent up
```

The TUI launches and shows the first agent full-screen.

**3. Validate a config without launching:**

```bash
orkagent validate -f agents.yaml
# Config valid
```

---

## CLI Commands

### `orkagent init`

Generates a minimal `agents.yaml` in the current directory. Exits with an error if the file already exists.

### `orkagent validate [-f path]`

Validates the config file against the schema and checks that required API keys are present as environment variables. Does not launch any agents.

| Flag | Default | Description |
|------|---------|-------------|
| `-f, --file <path>` | `agents.yaml` | Path to the config file |

Exit code 0 on success, 1 on error. Errors include the YAML path and what was expected vs. received.

### `orkagent up [-f path] [--resume] [--plain] [--team name]`

Loads the config and launches the TUI with all agents running.

| Flag | Default | Description |
|------|---------|-------------|
| `-f, --file <path>` | `agents.yaml` | Path to the config file |
| `--resume` | off | Restore conversation histories from the previous session |
| `--plain` | off | Non-interactive mode; prints agent output to stdout instead of the TUI |
| `--team <name>` | all agents | Launch only the agents listed in the named team |

Session state is saved to `.orkagent-session.json` in the current directory on exit (Ctrl-C or SIGTERM). Pass `--resume` on the next run to restore agent conversation histories from that file.

### `orkagent save <name> [-f path] [-d description]`

Packages the current config as a shareable template file `<name>.template.yaml`.

```bash
orkagent save research-duo -d "Two-agent research and writing pipeline"
# Template saved: research-duo.template.yaml
```

| Flag | Default | Description |
|------|---------|-------------|
| `-f, --file <path>` | `agents.yaml` | Config file to package |
| `-d, --description <text>` | none | Short description added as a comment |

### `orkagent publish <name> [--registry url]`

Pushes a saved template to a git registry.

```bash
orkagent publish research-duo --registry https://github.com/your-org/templates
```

Requires that `orkagent save <name>` has been run first.

### `orkagent fork <repo-url> [--name name]`

Clones a template repository and sets it up locally.

```bash
orkagent fork https://github.com/orkagent/templates --name my-team
# Template forked to: /path/to/my-team
```

| Flag | Default | Description |
|------|---------|-------------|
| `--name <name>` | derived from repo URL | Local directory name for the cloned template |

### `orkagent templates search <query> [--limit n] [--registry url]`

Searches the template registry index.

```bash
orkagent templates search "code review" --limit 5
```

---

## The TUI

When you run `orkagent up`, the terminal shows a live dashboard with a tmux-style layout: one agent occupies the full screen at a time, and you cycle between agents using keyboard shortcuts.

### Layout

```
  researcher [running]  tok:1.2k  $0.0012
  -----------------------------------------------
  The latest research on LLMs shows that...
  [TOOL: file_write]
  More streaming text here...


  1:researcher*  2:coder-  3:reviewer.   in:3.4k out:1.1k $0.0024
```

**Agent pane (main area):** Shows the currently selected agent's name, state label, token count, and estimated cost in the header. Streaming output fills the body. Tool calls appear in magenta with a `[TOOL: name]` prefix.

**Status bar (bottom row):** A tab bar listing all agents. The active agent is highlighted with inverse text. A compact state symbol follows each agent name. Token totals and session cost appear on the right.

### Agent States

States are shown in two places: as a text label in the agent pane header, and as a compact symbol in the status bar.

| Pane label | Status bar symbol | Color | Meaning |
|------------|-------------------|-------|---------|
| `[running]` | `*` | green | Agent is actively calling the model |
| `[idle]` | `-` | yellow | Agent is waiting for input or a dependency |
| `[paused]` | `\|` | cyan | Agent has been paused, usually by a cost guardrail |
| `[done]` | `.` | gray | Agent has finished and will not run again |
| `[error]` | `!` | red | Agent has encountered an unrecoverable error |

Both labels and colors are shown — state is never conveyed by color alone.

### Keybindings

**Navigation:**

| Key | Action |
|-----|--------|
| `n`, right arrow, or Tab | Move to the next agent |
| `p` or left arrow | Move to the previous agent |
| `1` through `9` | Jump directly to agent by index |

**Input mode:**

| Key | Action |
|-----|--------|
| `i` or Enter | Enter input mode — type a message to send to the current agent |
| Escape | Exit input mode without sending |

When input mode is active, a prompt appears at the bottom of the screen:

```
[agent-name] > your message here_
```

Type your message and press Enter to send it. The message is appended to the agent's conversation history and a new API call is triggered immediately.

**Agent control (tmux-style prefix commands):**

Press `Ctrl-b`, release, then immediately press the command key:

| Key sequence | Action |
|-------------|--------|
| `Ctrl-b r` | Restart the current agent (fresh history, new connection) |
| `Ctrl-b x` | Stop the current agent (transitions to `done`) |
| `Ctrl-b n` | Next agent |
| `Ctrl-b p` | Previous agent |

### Tool Approval Prompt

When an agent wants to use a tool that is not in its declared `tools` allow-list, an approval dialog appears at the top of the screen:

```
Tool approval required
agent: analyzer   tool: shell
{"command": "grep -r TODO src/"}

[y] Approve   [n] Deny   [a] Approve + remember
```

| Key | Action |
|-----|--------|
| `y` | Approve this tool call |
| `n` | Deny this tool call; the agent receives an error result |
| `a` | Approve and add to the agent's allow-list for this session |

If multiple approvals are queued, they are shown one at a time. The count of remaining approvals is displayed in the header.

### Plain Output Mode

For CI environments or screen readers, use `--plain`:

```bash
orkagent up --plain -f agents.yaml
```

Output is written line-by-line to stdout in the format `[agent-id] <line>`. No Ink rendering is used.

---

## Provider Setup

### Anthropic

Set your API key:

```bash
export ANTHROPIC_API_KEY=your-key-here
```

Example agent config:

```yaml
agents:
  assistant:
    provider: anthropic
    model: claude-sonnet-4-5
    system: You are a helpful coding assistant.
```

Supported models with built-in cost tracking: `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-3-5`, `claude-3-opus`, `claude-3-sonnet`, `claude-3-haiku`.

### OpenAI

Set your API key:

```bash
export OPENAI_API_KEY=your-key-here
```

Example agent config:

```yaml
agents:
  assistant:
    provider: openai
    model: gpt-4o
    system: You are a helpful assistant.
```

Supported models with built-in cost tracking: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo`.

### Ollama (local, no API key required)

Ensure Ollama is running:

```bash
ollama serve
```

By default, orkagent connects to `http://localhost:11434`. Override with:

```bash
export OLLAMA_HOST=http://your-ollama-host:11434
```

Example agent config:

```yaml
agents:
  assistant:
    provider: ollama
    model: qwen2.5:0.5b
    system: You are a helpful assistant.
```

Ollama agents incur no cost.

---

## Cost Management

Each agent tracks its token usage. The status bar shows running totals for input tokens, output tokens, and estimated cost.

**Per-agent limit:** When an agent exceeds its `max_cost` (in USD), it is paused automatically:

```yaml
agents:
  backend:
    provider: anthropic
    model: claude-sonnet-4-5
    max_cost: 2.00
```

**Session limit:** When the combined cost of all agents exceeds `session.max_cost`, all running agents are paused:

```yaml
session:
  max_cost: 10.00
```

A paused agent shows `[paused]` in the pane header and `|` in the status bar. Use `Ctrl-b r` to restart a paused agent if you want to continue.

Ollama agents always have zero cost.

---

## Troubleshooting

**"Config validation failed: agents.xxx.provider: expected..."**

Check that the provider value is exactly one of `anthropic`, `openai`, or `ollama`.

**"agent 'xxx' requires ANTHROPIC_API_KEY to be set"**

Export the environment variable before running orkagent:

```bash
export ANTHROPIC_API_KEY=your-key-here
orkagent up
```

**"circular dependency detected: a -> b -> a"**

Two or more agents have `depends_on` entries that form a loop. Remove one of the edges to break the cycle.

**Agent shows `[error]` state**

The agent failed after exhausting its restart budget (3 restarts within 5 minutes by default, configurable via `max_restarts`). The error message appears in the agent pane header in red. Use `Ctrl-b r` to manually restart the agent.

**TUI does not render correctly**

Try `--plain` mode for non-interactive output. Ensure your terminal emulator supports 256 colors (`TERM=xterm-256color`).

**Cannot connect to Ollama**

Verify Ollama is running with `ollama serve` and that `OLLAMA_HOST` points to the correct address if it is not on localhost.
