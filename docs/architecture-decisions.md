# Architecture Decision Records

This document captures the key design decisions made during orkagent's development, the alternatives that were considered, and the reasoning behind each choice.

---

## ADR-1: Adapter Pattern for Provider Normalization

### Status
Accepted

### Context

Orkagent supports three LLM providers: Anthropic, OpenAI, and Ollama. Each has a different API shape, different streaming formats, different tool call encoding, and different token usage reporting. The runner loop needs to handle all of them without branching on provider type throughout the codebase.

### Decision

All provider integrations implement a shared `AgentProvider` interface defined in `src/providers/types.ts`. The interface has two methods:

- `send(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent>` — streams normalized events
- `abort(): void` — cancels an in-flight request

Each adapter (`AnthropicAdapter`, `OpenAIAdapter`, `OllamaAdapter`) maps its provider-specific streaming format to the internal `StreamEvent` union. The `AgentRunner` in `src/runner.ts` only speaks `StreamEvent`; it has no knowledge of which provider it is talking to.

### Alternatives Considered

**Single function with provider switch:** A single `sendMessage(provider, messages)` function with a large `switch` statement. Rejected because it would grow unboundedly as providers were added, make testing harder (each test would need to mock the same function), and couple provider-specific logic to the runner.

**Provider-specific runner subclasses:** One `AnthropicRunner`, one `OpenAIRunner`, etc. Rejected because the runner's retry logic, error boundary, tool dispatch, and state management are identical across providers. Duplication in subclasses would diverge over time.

### Consequences

- Adding a new provider requires only a new file in `src/providers/` and a case in the `createProvider` factory in the orchestrator.
- The runner, store, and TUI are completely decoupled from provider specifics.
- The `StreamEvent` type is the central contract; changes to it require updating all adapters.
- Ollama's tool call support is limited (the adapter does not yet emit `tool_call` events), which is a known gap documented in the Ollama adapter.

---

## ADR-2: Centralized Store with Batched Notifications

### Status
Accepted

### Context

Multiple agents stream output simultaneously. Each streaming chunk could trigger a TUI re-render if the store notified subscribers on every mutation. With 10 agents each receiving 5–10 chunks per second, naively propagating every mutation would cause hundreds of re-renders per second — enough to make the terminal flicker and drive CPU usage up.

### Decision

The `Store` class in `src/store.ts` is a single centralized state container backed by a Node.js `EventEmitter`. It uses a 50 ms batched notification strategy: all mutations mark the store as dirty, and a `setInterval` at 50 ms checks the dirty flag and emits a single `change` event if the state has been modified. The TUI subscribes to `change` events and re-renders from the latest state snapshot.

The output buffer per agent is a ring buffer capped at 10,000 lines. Streaming tokens accumulate into the current line; a new line is started only on `\n` characters. Lines beyond the 10,000-line cap evict the oldest entries.

### Alternatives Considered

**Redux-style reducer with action queue:** Predictable state transitions and time-travel debugging potential. Rejected as over-engineered for this state shape. The agent state model is straightforward (a map of agent entries), and the boilerplate overhead was not justified.

**React state with `useReducer` in App.tsx:** Moving state directly into React would tightly couple the state model to the UI component tree. Non-UI consumers (orchestrator cost tracking, session persistence) would have no access to state without threading callbacks through multiple layers.

**Per-event notification:** Simplest implementation, but causes render thrashing with many fast-streaming agents. Rejected for performance reasons.

### Consequences

- TUI re-renders are bounded to approximately 20 per second regardless of how many agents are streaming.
- Non-TUI consumers (the orchestrator's cost tracking) also subscribe to `change` events, getting the same batched updates.
- A mutation's effect on the TUI is visible within at most 50 ms — imperceptible to users.
- The ring buffer prevents unbounded memory growth for long-running agents.

---

## ADR-3: tmux-Style Single-Agent Full-Screen Layout

### Status
Accepted

### Context

The original design called for a split-pane grid showing all agents simultaneously, with hjkl vim-style navigation to move focus between panes. In practice, with more than 3 agents the grid cells become too narrow to read comfortably, and the rendering complexity of managing relative pane sizes across resize events added significant implementation overhead.

### Decision

The TUI was rewritten to a tmux-style layout: one agent is displayed full-screen at a time, and the user cycles between agents using `n`/`p`, arrow keys, Tab, or numeric index (`1`-`9`). The agent currently being viewed is called the "active" agent. All agents remain running regardless of which one is active.

A status bar at the bottom renders a tab strip showing all agents. The active agent's tab is highlighted with inverse text. Each tab shows the agent's index, name, and a compact one-character state symbol. Token totals and session cost appear on the right.

The `AgentPane` renders only the lines that fit the terminal height, computed from `useStdout().rows` minus header and status bar rows. No virtual scrolling UI is exposed — the pane always shows the most recent lines.

The tmux-style prefix `Ctrl-b` followed by `r` (restart) or `x` (stop) controls the active agent. Input mode is entered with `i` or Enter and exited with Escape.

### Alternatives Considered

**Original grid layout with hjkl navigation:** Each agent in its own proportionally-sized pane, focused pane expanded to full width. Rejected after implementation because: pane widths became unreadably narrow with more than 4 agents; the grid layout required tracking relative pane dimensions across terminal resize events; hjkl movement in a grid required knowing pane neighbors (left/right/up/down), which was non-trivial with variable grid shapes.

**Scrollable agent list with virtual viewport:** A single scrollable view of all agent panes stacked vertically. Rejected because vertical stacking requires each pane to have a fixed height, which wastes space when agents have little output and overflows when they have a lot.

### Consequences

- Any number of agents can run without layout degradation — the view degrades gracefully at scale because only one pane renders at a time.
- The status bar tab strip can become crowded with many agents, but is still readable because only the agent name and a single symbol are shown per tab.
- Users who want to monitor two agents simultaneously must cycle between them. This is a deliberate trade-off for simplicity.
- The keybinding set is different from the original design (no hjkl grid navigation; Tab and arrow keys are equivalent to `n`/`p`).

---

## ADR-4: Ink (React for CLIs) as the TUI Framework

### Status
Accepted

### Context

The TUI needs to render agent output, handle keyboard input for navigation and control, and display modal overlays for tool approval prompts. This requires a component model with a clear separation between state and presentation.

### Decision

[Ink](https://github.com/vadimdemedes/ink) was selected as the TUI framework. Ink renders React component trees to the terminal using Yoga (flexbox layout) and provides hooks for keyboard input (`useInput`), terminal size (`useStdout`), and standard components for text and boxes.

The TUI component tree is:

```
App
├── ApprovalPrompt (modal, rendered first when pending approvals exist)
├── AgentPane (active agent, full-screen)
├── InputBar (rendered only when input mode is active)
└── StatusBar
```

Components are pure display functions. All data comes from store selectors passed as props. No component makes provider calls or modifies agent state directly.

### Alternatives Considered

**Blessed:** A lower-level terminal widget library. Rejected because it was last released in 2017 and is effectively unmaintained. Its imperative API would also conflict with the centralized store pattern — managing widget state separately from application state would create synchronization complexity.

**Blessed-contrib:** Extends Blessed with dashboards and charts. Inherits the maintenance concern.

**Plain ANSI escape codes:** Maximum control, no dependencies. Rejected because writing a layout engine, virtual DOM diffing, and keyboard input handling from scratch is a substantial project that would dwarf the agent features.

### Consequences

- The `ink-testing-library` provides snapshot and interaction testing for TUI components, which gives strong regression coverage.
- React's declarative model makes the "pure display, centralized store" architecture natural to implement.
- Ink's flexbox layout handles the single-pane full-screen layout without manual terminal row/column arithmetic.
- The React dependency adds approximately 50 KB to the installed package size.
- The `AgentPane` computes its visible line window manually from `useStdout().rows`, since Ink does not provide a built-in virtual list component.

---

## ADR-5: Commander for CLI Argument Parsing

### Status
Accepted

### Context

The CLI needs subcommands (`up`, `validate`, `init`, `save`, `publish`, `fork`, `templates search`) with per-command options, help text generation, and argument validation.

### Decision

[Commander](https://github.com/tj/commander.js) (`^12.x`) was selected for CLI argument parsing. Commands are defined declaratively with `.command()`, `.option()`, and `.action()` handlers.

### Alternatives Considered

**Yargs:** A mature alternative with a similar API. Rejected because Commander has fewer dependencies, produces cleaner help output, and its API is more familiar to the target developer audience.

**Meow:** Lightweight but lacks the subcommand model needed for this CLI's scope.

**Manual `process.argv` parsing:** Rejected for obvious reasons.

### Consequences

- Help text (`--help`) is generated automatically from command and option descriptions.
- Commander's `.parse()` call is synchronous and completes before any async work begins, satisfying the requirement that config validation completes within 500 ms of process start.

---

## ADR-6: Per-Agent Permission Guard with Runtime Approval Prompts

### Status
Accepted

### Context

Agents can invoke tools that have real side effects (writing files, running shell commands). Granting agents unlimited tool access is unsafe. However, requiring users to pre-declare every possible tool call in the config is impractical — agents may legitimately want to use tools not anticipated at config time.

### Decision

Each agent has an allow-list declared in its `tools` config field. The `PermissionGuard` in `src/tools/permission.ts` is created per-agent with this list. When the runner dispatches a tool call:

1. `guard.check(agentId, toolName)` returns `'allowed'` if the tool is in the allow-list.
2. If not allowed, it returns `'prompt'`, which causes the runner to call `guard.requestApproval()`.
3. `requestApproval` pushes a `PendingApproval` entry to the store and awaits a user decision.
4. The `ApprovalPrompt` TUI component renders the pending approval and dispatches the user's `y`/`n`/`a` keypress back to the store.
5. `a` (approve + remember) calls `guard.addToAllowList(toolName)` so future calls from this agent are auto-approved for the session.

The guard sits between the runner and the tool registry. Provider adapters have no access to the tool layer, so a compromised adapter cannot bypass permissions.

### Alternatives Considered

**Deny all tools not in the allow-list (no prompt):** Simpler, but would halt agents whenever they attempted a legitimate but unanticipated tool call. Poor developer experience.

**Allow all tools (no guard):** No friction, but dangerous for `shell` and `file_write`. Rejected for security reasons.

**Per-tool policy config (allow/deny/prompt per tool per agent):** More granular but significantly more verbose to configure. The current model (allow-list + runtime prompt) covers the common cases with minimal config overhead.

### Consequences

- Tool approval prompts block the agent's conversation loop while waiting for a user decision. This is intentional — the user must be in the loop for unexpected tool calls.
- The approval is synchronous from the agent's perspective: the runner awaits the promise before continuing.
- The `PendingApproval` queue handles multiple simultaneous approval requests from different agents — they are shown one at a time in FIFO order.

---

## ADR-7: In-Process Plugin Sandbox

### Status
Accepted

### Context

Plugins need to extend orkagent with custom tools and hooks. The degree of isolation possible in a Node.js process without worker threads or child processes is limited. Full isolation (preventing a plugin from calling `process.exit()` or reading environment variables) requires VM module sandboxing or subprocess isolation, both of which add significant complexity.

### Decision

The `PluginSandbox` in `src/plugins/sandbox.ts` provides a restricted registration API:

- Plugins register tools and hooks through the sandbox, not directly on the registries.
- Tool invokers are wrapped so that unhandled exceptions are caught, logged, and converted to tool error results rather than crashing the host.
- Hook registrations with forbidden names (`onPermissionChange`, `onConfigMutate`, `onAllowListModify`) are rejected with a security warning.
- Plugins do not receive provider SDK instances or API keys.

This is a **soft sandbox**: it defends against accidental misbehavior and prevents hooks from escalating permissions, but it does not prevent a deliberately malicious plugin from using Node.js built-ins. This limitation is documented explicitly.

### Alternatives Considered

**Node.js `vm` module:** Could restrict global access but adds significant complexity, breaks `require`/`import` semantics, and does not prevent access to `process` or `Buffer`. The security benefit is marginal for plugins that already have `import` access.

**Worker threads per plugin:** Full memory isolation. Rejected for MVP because it requires message-passing serialization for every tool invocation and hook call, adds IPC latency, and significantly complicates the plugin development model.

**Child processes:** Strongest isolation, but same IPC complexity. Rejected for the same reason as worker threads.

### Consequences

- Plugin development is simple: standard ES module with two named exports.
- Tool exceptions never crash agents, which is the most important invariant.
- Forbidden hook names provide a lightweight defense against permission escalation via hooks.
- Users are responsible for vetting plugins they install. The documentation states this limitation clearly.

---

## ADR-8: Git-Based Template Registry

### Status
Accepted

### Context

Users should be able to share agent topologies (multi-agent configs with specific prompts, tools, and dependencies) with others. A distribution mechanism is needed that is low-friction, does not require a separate account, and fits naturally with the "fork and customize" workflow common in open source.

### Decision

Templates are git repositories. The distribution model maps directly to git primitives:

- **Save:** `orkagent save <name>` packages the current config into a template file.
- **Publish:** `orkagent publish <name>` pushes to a git remote.
- **Fork:** `orkagent fork <repo-url>` runs `git clone` and updates the local manifest.
- **Search:** `orkagent templates search <query>` fetches and filters a community index file hosted in a git repository.

The default registry is `https://github.com/orkagent/templates`.

### Alternatives Considered

**npm registry:** Established ecosystem with versioning and `npx` support. Rejected because templates are config files, not executable code. Publishing to npm requires an npm account and follows npm's package lifecycle, which is heavyweight for what is essentially a YAML file. The `npm publish` friction would discourage sharing.

**Dedicated API/web registry:** Most control over discovery and search. Rejected for MVP because it requires infrastructure to build and operate, and provides no benefits over git for the current feature set.

### Consequences

- Forking a template is a single command with no account required beyond GitHub access.
- Versioning is handled by git tags.
- Search is limited to filtering a flat index file — no ranking, no full-text search beyond substring matching on name and description.
- Template search returns empty results in the current implementation, as the community registry index is not yet populated.

---

## ADR-9: Single-Process Concurrency Model

### Status
Accepted

### Context

Multiple agents run simultaneously. The question is whether each agent should run in its own OS thread or process, or whether all agents should run in the same event loop.

### Decision

All agents run as async coroutines in a single Node.js process. The `AgentRunner.start()` method returns a `Promise` that the orchestrator collects via `Promise.all`. Each runner's conversation loop is an `async` function consuming an `AsyncIterable<StreamEvent>`. All I/O (provider API calls, file reads, SSH connections) is non-blocking.

### Alternatives Considered

**Worker threads per agent:** True memory isolation, CPU-bound work in one agent cannot block others, OS-level crash isolation. Rejected because the workload is I/O-bound, not CPU-bound. The agents spend most of their time awaiting HTTP responses. The overhead of serializing `StreamEvent` objects across thread boundaries for every chunk is not justified by the isolation benefit. Worker threads also significantly complicate the shared store design.

**Child processes per agent:** Strongest isolation. Same objections as worker threads, plus higher startup overhead. Rejected for MVP.

### Consequences

- An agent that enters a tight CPU loop (e.g., a misbehaving plugin tool invoker) can starve the event loop and delay other agents. In practice, this has not been observed because tool execution is brief relative to API round trips.
- The Node.js event loop handles hundreds of concurrent async operations without issue at the scale orkagent targets (up to ~20 agents).
- If CPU-bound workloads become a concern in future, individual tool invocations can be moved to worker threads without changing the rest of the architecture.
- Memory is shared across all agents, which makes the centralized store simple to implement but means a memory leak in one agent's output buffer could affect the whole session (mitigated by the 10,000-line ring buffer cap).

---

## ADR-10: YAML as the Config Format

### Status
Accepted

### Context

The config file needs to be human-editable, support comments (so users can annotate their agent configs), and be familiar to the target audience.

### Decision

YAML parsed by the `yaml` package (`^2.x`). Zod schema validation eliminates YAML's type ambiguity risks at parse time — all values are validated against explicit types before use.

### Alternatives Considered

**TOML:** Less ambiguous than YAML, good for flat config files. Rejected because it is less familiar to the target audience (developers who use docker-compose, Kubernetes manifests, and GitHub Actions). Nested structures in TOML are verbose compared to YAML.

**JSON:** No parsing ambiguity, native to TypeScript. Rejected because JSON does not support comments, which are important for annotating system prompts and agent configs. JSON's verbosity (quotes on all keys) hurts readability for hand-edited files.

**TypeScript/JavaScript:** Maximum flexibility, native types, programmatic generation. Rejected because it requires a build step or runtime evaluation (`eval`/`require`), introduces security concerns for shared configs, and raises the barrier for non-TypeScript users.

### Consequences

- Users can include `#` comments in their config files to document their agent setups.
- YAML's scalar type coercion (e.g., `yes`/`no` becoming booleans) is mitigated by Zod, which enforces explicit types.
- The `yaml` package's error messages for malformed YAML are forwarded verbatim in the `ConfigValidationError`, giving users actionable parse errors.
