# Tasks: Orkagent

> Implementation task breakdown for the agent command center CLI/TUI

<!--
IMPORTANT: Do NOT edit task descriptions, acceptance criteria, or dependencies.
Only update Status, Wired, and Verified fields. This ensures traceability.

Status lifecycle: pending -> in_progress -> completed -> (only after Wired + Verified)
Wired: Is this code connected to the rest of the application? Can a user reach it?
Verified: Has it been tested end-to-end as a user would interact with it?
-->

## Summary

| Status | Count |
|--------|-------|
| Pending | 0 |
| In Progress | 0 |
| Completed | 45 |
| Wired | 6 |
| Verified | 45 |

---

## Phase 1: Core Foundation

### T-1: Project scaffolding and toolchain setup

- **Status**: completed
- **Wired**: n/a
- **Verified**: yes
- **Requirements**: US-1, NFR-7
- **Description**: Initialize the Node.js TypeScript project with all required dependencies. Create `package.json` with the dependency list from the design (ink, react, @anthropic-ai/sdk, openai, zod, yaml, commander or yargs). Configure `tsconfig.json` for ES2022 target with strict mode, module resolution for Node 20 LTS, and JSX support for Ink. Set up Vitest for testing. Add a `bin` entry for the `orkagent` CLI. Create the `src/` directory structure matching the Phase 1 file layout from the design document.
- **Acceptance**: `npm install` completes without errors. `npx tsc --noEmit` passes on an empty `src/index.ts`. `npx vitest run` executes with no test files and exits 0. The `orkagent` binary is resolvable via `npm link`.
- **Dependencies**: none

---

### T-2: Core type definitions

- **Status**: completed
- **Wired**: n/a
- **Verified**: yes
- **Requirements**: US-4, US-2
- **Description**: Implement `src/providers/types.ts` with all shared interfaces from the design: `StreamEvent`, `AgentProvider`, `Message`, `ToolCall`, `ToolResult`, `ToolDefinition`, and `AgentState`. These are the contracts every other module depends on. Include JSDoc comments explaining the purpose of each field. No implementation logic -- types only.
- **Acceptance**: `npx tsc --noEmit` passes. Every field from the design's data model section is present. `AgentState` includes all seven states: `pending | starting | running | idle | done | error | paused`.
- **Dependencies**: T-1

---

### T-3: Config loader with Zod schema validation

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-1, US-4, NFR-2, NFR-4
- **Description**: Implement `src/config.ts`. Define and export `AgentConfig`, `TeamConfig`, `Config`, and `ConfigSchema` (Zod). The schema must cover all fields from the design's data model including phase-gated optional fields (`tools`, `watches`, `depends_on`, `context_from`, `remote`, `max_cost`, `max_restarts`). Implement `loadConfig(filePath: string): Config` that reads the YAML file, parses it with the `yaml` package, runs Zod validation, and throws `ConfigValidationError` with structured error details (YAML path, expected type, received value) on failure. Validate that all referenced provider API keys exist as environment variables before returning. Config loading must be synchronous (no async). Keep API keys out of any error messages or logs.
- **Acceptance**: Unit tests cover: valid config loads cleanly, missing file throws with "no config found" message, Zod failure includes YAML path and received value in error, missing API key identifies the agent name and env var name. `loadConfig` completes in under 500ms on a 100-agent config file.
- **Dependencies**: T-2

---

### T-4: Anthropic provider adapter

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-4
- **Description**: Implement `src/providers/anthropic.ts`. The class implements `AgentProvider`. `send()` calls the Anthropic Messages API with streaming enabled and returns an `AsyncIterable<StreamEvent>`. Map all Anthropic streaming event types (`content_block_delta`, `message_delta`, `input_json_delta` for tool calls, `message_stop`) to the unified `StreamEvent` format. Extract `usage.input_tokens` and `usage.output_tokens` from the `message_delta` event. Implement `abort()` using the SDK's abort controller. Handle HTTP 429 rate limit responses by emitting a `StreamEvent` with `error.code = 'rate_limit'` and `error.retryable = true`. Inject `agentId` into each emitted event (agentId is passed to the constructor).
- **Acceptance**: Unit tests with a mock Anthropic SDK verify: text delta maps to `type: 'text'`, tool call input maps to `type: 'tool_call'`, message stop maps to `type: 'done'`, usage is extracted, 429 response emits retryable error event, abort cancels the stream.
- **Dependencies**: T-2, T-1

---

### T-5: OpenAI provider adapter

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-4
- **Description**: Implement `src/providers/openai.ts`. Mirrors the Anthropic adapter but uses the OpenAI Chat Completions streaming API. Map `delta.content` to `type: 'text'`, `delta.tool_calls` to `type: 'tool_call'`, `finish_reason: 'stop'` to `type: 'done'`. Extract usage from the final chunk (`usage.prompt_tokens`, `usage.completion_tokens`). Handle 429 responses. Implement `abort()`.
- **Acceptance**: Unit tests mirror T-4's coverage. Text, tool call, done, usage, rate limit, and abort are all tested with mocked OpenAI responses.
- **Dependencies**: T-2, T-1

---

### T-6: Ollama provider adapter

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-4
- **Description**: Implement `src/providers/ollama.ts`. Uses `fetch` with streaming against Ollama's `/api/chat` endpoint. Default base URL is `http://localhost:11434`; override via `OLLAMA_HOST`. Parse the NDJSON stream. Map `message.content` to `type: 'text'`, `done: true` to `type: 'done'`. Ollama does not reliably report token usage in all versions -- emit `usage` only when present in the response. No API key needed. Implement `abort()` using `AbortController`.
- **Acceptance**: Unit tests use a mock HTTP server. Text streaming, done event, abort, and missing-usage graceful handling are tested. The adapter respects `OLLAMA_HOST` when set.
- **Dependencies**: T-2, T-1

---

### T-7: Centralized store

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-2, US-13, NFR-1, NFR-3
- **Description**: Implement `src/store.ts`. Define `AgentStoreEntry` and `AppState` types as per the design. Implement the `Store` class with typed dispatch methods: `initAgent`, `updateAgentState`, `appendOutput`, `appendMessage`, `updateTokenUsage`, `setFocusedAgent`, `setLastError`. Output buffers are ring buffers capped at 10,000 lines -- evict oldest on overflow. Use Node.js `EventEmitter` for change notifications. Implement batched notifications: collect all dispatches and emit a single `change` event every 50-100ms using `setInterval`. Expose read-only selectors: `getAgent(id)`, `getAllAgents()`, `getFocusedAgentId()`, `getSessionCost()`.
- **Acceptance**: Unit tests: dispatch accumulates state correctly, output buffer evicts at 10,000 lines, batching fires at most once per 50ms window even with 100 rapid dispatches, selectors return current state.
- **Dependencies**: T-2, T-1

---

### T-8: AgentRunner with error boundary and retry logic

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-4, US-13, NFR-5
- **Description**: Implement `src/runner.ts`. The `AgentRunner` class takes `AgentConfig`, an `AgentProvider` instance, and a `Store` reference. `start()` begins the conversation loop: call `provider.send()`, consume the `AsyncIterable<StreamEvent>`, dispatch each event to the store, handle `tool_call` events by returning a stub tool result (Phase 3 will replace with real tool execution). Maintain `Message[]` conversation history. Implement restart logic: catch provider errors, check restart count (max 3) and time window (5 minutes), re-call `provider.send()` with preserved history if within limits, dispatch `state: 'error'` if limit exceeded. Handle rate limit events by applying exponential backoff (start 1s, max 60s, use `Retry-After` header value when present). Each runner is an isolated error boundary -- exceptions must not propagate to the caller.
- **Acceptance**: Integration tests with a mock provider that emits: normal stream, rate limit event, crash error. Verify: state transitions (starting -> running -> idle/done), restart fires up to 3 times, restart stops after 3 attempts and state becomes 'error', backoff delays are applied, conversation history is preserved across restarts.
- **Dependencies**: T-2, T-3, T-7

---

### T-9: Orchestrator

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-1, US-13, NFR-5
- **Description**: Implement `src/orchestrator.ts`. The `Orchestrator` class takes a validated `Config` and a `Store`. `start()` creates one `AgentProvider` and one `AgentRunner` per agent in the active team, initializes agent entries in the store, and starts all runners. Implement a provider factory that selects the correct adapter class based on `agent.config.provider`. Implement `stopAgent(id)` and `restartAgent(id)` for TUI keybinding commands. Track cumulative cost per agent and session total (using token counts from store, estimated against a hardcoded pricing table). Implement session persistence: serialize agent conversation histories to a local JSON file on state change; support `--resume` by loading and restoring them at startup.
- **Acceptance**: Integration tests: all agents start when orchestrator starts, `stopAgent` transitions agent to 'done', cost accumulation matches expected formula, session file is written after first message and restored on `--resume`.
- **Dependencies**: T-3, T-4, T-5, T-6, T-7, T-8

---

### T-10: TUI App root and keybinding handler

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-2, US-3
- **Description**: Implement `src/ui/App.tsx`. Root Ink component. Reads from store on each render cycle (subscribe to store `change` events, trigger re-render via `useState` or `useReducer`). Renders `StatusBar` at the bottom and either the split-pane grid of `AgentPane` components (overview mode) or a single full-screen `AgentPane` (focused mode). Implement keybinding handling via Ink's `useInput`: hjkl pane navigation, number keys for direct selection, Enter to focus, Escape to unfocus, `Ctrl-b` prefix for tmux-style commands (r = restart, x = stop, l = toggle logs, a = show all summary). Pass dispatch callbacks (restart, stop) down as props to avoid components importing from orchestrator directly.
- **Acceptance**: Ink snapshot tests for: 3-agent overview layout, focused single-agent layout, status bar visible in both modes. Keybinding unit tests: h/l/j/k change focused pane index, 1-9 jump to correct index, Enter enters focus mode, Escape exits, `Ctrl-b r` calls restart callback with correct agent id.
- **Dependencies**: T-7, T-2

---

### T-11: AgentPane TUI component

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-2, US-3, NFR-1, NFR-6
- **Description**: Implement `src/ui/AgentPane.tsx`. Renders a single agent's output. Props: `entry: AgentStoreEntry`, `isFocused: boolean`, `isExpanded: boolean`. Implement virtual scrolling: compute visible line window from `outputBuffer` based on pane height (from Ink's `useStdout`); render only visible lines plus 5-line overscan. Display state indicator using both a color (green = running, yellow = idle, gray = done, red = error) AND a text label -- never color alone (NFR-6). Render tool call events visually distinct from text (different color and `[TOOL: name]` prefix). Dim pane when not focused in overview mode. Handle terminal resize by re-computing the visible window within 100ms.
- **Acceptance**: Snapshot tests for each agent state. Virtual scroll test: a buffer of 500 lines with a 20-line pane renders exactly `visibleLines + overscan` lines. Tool call events render with `[TOOL:]` prefix. Resize test verifies window recomputes.
- **Dependencies**: T-7, T-2

---

### T-12: StatusBar TUI component

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-2, NFR-6
- **Description**: Implement `src/ui/StatusBar.tsx`. Props: `agents: AgentStoreEntry[]`. Renders a single-line bar at the bottom of the TUI showing: each agent's name and state indicator (color + text label per NFR-6), total input tokens, total output tokens, estimated total cost in USD. Cost is formatted as `$X.XXXX` (4 decimal places for sub-cent visibility). Token counts use thousands separators.
- **Acceptance**: Snapshot tests: 1-agent bar, 5-agent bar with mixed states. Verify no state is conveyed by color alone (each state has a text suffix: `[run]`, `[idle]`, `[done]`, `[err]`, `[wait]`).
- **Dependencies**: T-7, T-2

---

### T-13: InputBar TUI component

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-3
- **Description**: Implement `src/ui/InputBar.tsx`. Rendered only when an agent is focused. Uses Ink's `TextInput` component. On Enter, calls `onSubmit(message: string)` callback and clears the input. Displays a prompt like `[agent-name] > `. The callback in `App.tsx` dispatches a `user` message to the store and the runner picks it up on the next send cycle.
- **Acceptance**: Snapshot test showing input bar with agent name prefix. Submit test: onSubmit is called with input text, input clears after submit.
- **Dependencies**: T-10, T-7

---

### T-14: CLI entry point and command dispatch

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-1, NFR-2
- **Description**: Implement `src/index.ts`. Use commander (or yargs -- pick the lighter one) to define CLI commands: `up [-f config] [--resume] [--plain] [--team name]`, `validate [-f config]`, `init`. For `up`: call `loadConfig()`, on error print the validation error and exit 1. On success, create `Store`, create `Orchestrator`, mount the Ink app. For `validate`: call `loadConfig()`, print "Config valid" or errors. For `init`: write a starter `agents.yaml` template to the current directory. The `--plain` flag skips Ink and runs in non-interactive mode printing JSON events to stdout (NFR-6 screen reader support). Config loading and validation must complete before any async work, within 500ms (NFR-2).
- **Acceptance**: E2E test: `orkagent validate -f test-fixtures/valid.yaml` exits 0 and prints "Config valid". `orkagent validate -f test-fixtures/invalid.yaml` exits 1 and prints the YAML path of the error. `orkagent init` creates an `agents.yaml` file. `orkagent up` with missing config file exits 1 with a clear message.
- **Dependencies**: T-3, T-9, T-10, T-11, T-12, T-13

---

### T-15: Wire TUI to store and orchestrator in CLI entry

- **Status**: completed
- **Wired**: yes
- **Verified**: yes
- **Requirements**: US-1, US-2, US-3
- **Description**: Integration task. Connect all Phase 1 components so that `orkagent up` produces a running TUI. In `src/index.ts`, after `loadConfig()` succeeds: (1) create `Store`, (2) instantiate `Orchestrator(config, store)`, (3) render the Ink `App` component with store and orchestrator dispatch callbacks as props, (4) call `orchestrator.start()`. The `App` component subscribes to `store.on('change', ...)` and re-renders. The `InputBar` submit callback appends a user message to the agent's history and signals the runner to send it. Verify the full flow is reachable from a single `orkagent up` invocation.
- **Acceptance**: Running `orkagent up -f test-fixtures/valid-mock.yaml` (pointing at mock provider) launches the TUI, shows all agents in panes, status bar displays their states, typing a message and pressing Enter in focused mode sends it to the agent's runner and the response appears in the pane.
- **Dependencies**: T-14, T-9, T-10, T-11, T-12, T-13, T-7, T-8

---

### T-16: Phase 1 unit and integration test suite

- **Status**: completed
- **Wired**: n/a
- **Verified**: yes
- **Requirements**: US-1, US-2, US-3, US-4, US-13, NFR-1, NFR-2
- **Description**: Write comprehensive tests for all Phase 1 components. Cover: config loading (valid, invalid, missing file, missing API key), Zod schema edge cases, all three provider adapters (mock SDK/HTTP), store batching and ring buffer, runner restart logic and backoff, orchestrator lifecycle, TUI component snapshots (all agent states), keybinding behavior, CLI command exit codes. Use Vitest. Provider adapters use mock HTTP servers. TUI tests use `ink-testing-library`.
- **Acceptance**: `npm test` passes all tests. Coverage for `src/config.ts`, `src/store.ts`, `src/runner.ts` is above 80%. All provider adapters have at least one test for each StreamEvent type. TUI snapshot tests produce stable output.
- **Dependencies**: T-15

---

## Phase 2: Agent Communication

### T-17: EventBus implementation

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-5, US-6
- **Description**: Implement `src/eventbus.ts`. The `EventBus` class wraps `EventEmitter` with typed pub/sub keyed by event type string. Implement: `subscribe(eventType: string, agentId: string, handler: (event: StreamEvent) => void): () => void` (returns unsubscribe function), `publish(eventType: string, event: StreamEvent): void`, `unsubscribe(agentId: string)` to remove all subscriptions for a departing agent. Log at debug level when a message is published but has no subscribers, or when the target agent has already completed. The bus must not throw when publishing to an empty subscription set.
- **Acceptance**: Unit tests: subscribe + publish routes event to handler, unsubscribe prevents delivery, publishing to completed agent logs at debug and discards, no-op on zero subscribers.
- **Dependencies**: T-2, T-1

---

### T-18: Dependency graph validation and `depends_on` sequencing

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-5
- **Description**: Add circular dependency detection to `src/config.ts`. After Zod validation, run a topological sort (DFS-based cycle detection) on the `depends_on` graph. If a cycle is found, throw `ConfigValidationError` identifying all agents in the cycle. In `src/orchestrator.ts`, implement `depends_on` startup sequencing: an agent that lists `depends_on` agents is held in `pending` state and only started after all its dependencies reach `idle` or `done`. Subscribe to store state changes to trigger the check.
- **Acceptance**: Unit tests: config with A->B->C->A cycle is rejected with all three agent names in the error. Integration test: agent C with `depends_on: [A, B]` starts only after A and B reach idle/done state.
- **Dependencies**: T-3, T-9, T-17

---

### T-19: `watches` pub/sub wiring in runners

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-5, US-6
- **Description**: In `src/runner.ts`, integrate with `EventBus`. When a runner emits a `done` or `tool_result` event, publish it to the event bus using the agent's id as the event type. When an agent config has `watches: [agentA, agentB]`, subscribe to those agent IDs on the event bus at runner start. When a watched event arrives, inject it as a user-turn context message into this agent's conversation history and trigger a new `provider.send()` call. Unsubscribe from all event bus subscriptions in the runner's cleanup path.
- **Acceptance**: Integration test: two agents where agent-B watches agent-A. Agent-A completes and emits done. Agent-B receives the event within 100ms, a new user message appears in its history, and it triggers a new send.
- **Dependencies**: T-8, T-17, T-18

---

### T-20: `context_from` system prompt injection

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-5
- **Description**: In `src/orchestrator.ts`, before starting an agent that has `context_from: [agentA, agentB]`, wait for the referenced agents to reach `done` state, collect their final output from the store, and prepend it as additional system prompt content when creating the runner. The runner receives the augmented system prompt and includes it in the first `provider.send()` call.
- **Acceptance**: Integration test: agent-B with `context_from: [agent-A]`. Agent-A finishes with output "step 1 complete". Agent-B's first provider call includes "step 1 complete" in its system message.
- **Dependencies**: T-9, T-18, T-19

---

### T-21: Wire EventBus into Orchestrator startup

- **Status**: completed
- **Wired**: yes
- **Verified**: yes
- **Requirements**: US-5, US-6
- **Description**: Integration task. Instantiate `EventBus` in `src/orchestrator.ts` and pass it to each `AgentRunner` at creation. Ensure the bus is created once and shared across all runners. Verify the full communication loop is reachable from `orkagent up`: agent-A finishes, event flows through the bus to agent-B's runner, agent-B sends a new message to its provider.
- **Acceptance**: E2E test with a mock config where agent-B watches agent-A. After agent-A emits done, agent-B receives a context injection and makes a second provider call. Verified through store state inspection and mock provider call counts.
- **Dependencies**: T-17, T-18, T-19, T-20, T-9

---

### T-22: Phase 2 test suite

- **Status**: completed
- **Wired**: n/a
- **Verified**: yes
- **Requirements**: US-5, US-6
- **Description**: Write tests specific to Phase 2 communication features. Cover: cycle detection with various graph shapes (linear chain, diamond, cycle of 2, cycle of 3), depends_on sequencing (single dependency, multiple dependencies, chain), watches event delivery timing, context_from injection content, event bus no-op on empty subscribers, undelivered event debug logging.
- **Acceptance**: All Phase 2 tests pass. Cycle detection test cases include at least 5 different graph shapes. Event delivery timing test verifies events arrive within 150ms.
- **Dependencies**: T-21

---

## Phase 3: Tool Sandboxing

### T-23: Tool type definitions and ToolRegistry

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-7, US-8
- **Description**: Implement `src/tools/registry.ts`. Define `ToolDefinition` (name, description, inputSchema as JSON Schema), `ToolInvoker` (function type), and `ToolRegistry` class. The registry holds a map of name -> `{ definition, invoker }`. Implement `register(def, invoker)`, `get(name)`, `list()`. The registry is a singleton created once in the orchestrator and passed to runners. Plugin tools (Phase 4) will also call `register()`.
- **Acceptance**: Unit tests: register two tools, get each by name, list returns both, get unknown name returns undefined.
- **Dependencies**: T-2, T-1

---

### T-24: Built-in tools: file_read and file_write

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-8
- **Description**: Implement `src/tools/builtin/file.ts`. `file_read` takes `{ path: string }` and returns file contents as a string. `file_write` takes `{ path: string, content: string }` and writes the file. Both resolve paths relative to the agent's declared working directory. Both tools enforce a 30-second execution timeout. Return a structured result `{ output: string, isError: boolean }`.
- **Acceptance**: Unit tests: file_read returns file contents, file_read returns error result for missing file, file_write creates file with content, file_write returns error on permission denied (mock fs), 30-second timeout returns error result without hanging.
- **Dependencies**: T-23

---

### T-25: Built-in tool: shell

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-8, US-7
- **Description**: Implement `src/tools/builtin/shell.ts`. `shell` takes `{ command: string, cwd?: string }` and spawns the command using Node.js process APIs (using execFile to avoid shell injection -- no string interpolation into shell invocations). If the agent config declares `shell: { cwd: "./src" }`, validate that the resolved `cwd` does not escape the declared base path (reject path traversal like `../../etc`). Enforce 30-second timeout. Return `{ output: string, isError: boolean }` combining stdout and stderr.
- **Acceptance**: Unit tests: command executes and returns stdout, stderr is included in output, path traversal attempt returns error result, timeout kills process and returns error, cwd restriction is enforced.
- **Dependencies**: T-23

---

### T-26: Built-in tool: web_search

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-8
- **Description**: Implement `src/tools/builtin/web.ts`. `web_search` takes `{ query: string, num_results?: number }`. Use a simple HTTP fetch to a configurable search API (default: DuckDuckGo Instant Answer API or a stub that returns a placeholder in test mode). Return top N results as a formatted string. Enforce 30-second timeout. This is intentionally minimal -- the tool provides the interface; a real search backend can be plugged in via config.
- **Acceptance**: Unit tests: query returns formatted result string, timeout returns error result, `num_results` limits output count.
- **Dependencies**: T-23

---

### T-27: PermissionGuard

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-7, NFR-4
- **Description**: Implement `src/tools/permission.ts`. The `PermissionGuard` class takes the agent's declared `tools` allow-list. `check(agentId: string, toolName: string): 'allowed' | 'prompt'` returns `'allowed'` if the tool is in the allow-list, `'prompt'` otherwise. `requestApproval(agentId, toolName, inputSummary): Promise<'approve' | 'deny'>` dispatches an approval request to the store and awaits a user decision. Implement the store state for pending approvals: `{ id, agentId, toolName, inputSummary, resolve }`. Ensure permission enforcement happens at the orchestrator layer, not inside provider adapters.
- **Acceptance**: Unit tests: tool in allow-list returns 'allowed', tool not in list returns 'prompt', approval promise resolves to 'approve' when store approval is dispatched, denial resolves to 'deny'.
- **Dependencies**: T-23, T-7

---

### T-28: ApprovalPrompt TUI component

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-7
- **Description**: Implement `src/ui/ApprovalPrompt.tsx`. When `appState.pendingApprovals` has entries, render an overlay modal at the top of the TUI showing: agent name, tool name, truncated input summary. Y/N keybinding (y/n keys). On approval, dispatch `approveToolCall(id)` which resolves the pending promise in `PermissionGuard`. On denial, dispatch `denyToolCall(id)`. Display a checkbox "Add to agent allow-list for this session" -- if checked, add the tool to the agent's runtime allow-list.
- **Acceptance**: Snapshot test: approval modal renders with agent name, tool name, input summary. Keybinding test: `y` dispatches approval, `n` dispatches denial. Session allow-list test: approving with the checkbox adds the tool to agent's list so the next call is auto-approved.
- **Dependencies**: T-27, T-10, T-7

---

### T-29: SSH runner for remote tool invocation

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-14
- **Description**: Implement `src/tools/ssh.ts`. The `SSHRunner` class takes the `remote` config (`host`, `user`, `key`, `port`). `connect()` establishes an SSH connection using the `ssh2` package with key-based auth only (no password auth). `exec(command: string, cwd?: string)` runs a shell command on the remote host via the established channel. `readFile(path)` and `writeFile(path, content)` use SFTP. Handle connection drop during active tool call: return a tool error and attempt one reconnection. If reconnection fails, mark the agent as errored. SSH authentication failure does not retry.
- **Acceptance**: Unit tests using a mock SSH2 server: successful exec returns output, auth failure marks agent error immediately, connection drop during exec returns tool error and triggers one reconnect attempt, SFTP read/write succeed.
- **Dependencies**: T-23, T-1

---

### T-30: Cost guardrails

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-13
- **Description**: Extend `src/orchestrator.ts` with cost guardrail enforcement. After each `usage` event updates the store, check the agent's cumulative cost against its `max_cost` config. If exceeded, pause the agent (set state to `paused`, call `runner.pause()`). Add a `paused` approval prompt variant to `ApprovalPrompt` showing current cost and asking to continue or stop. Add session-wide cost limit check (summing all agent costs against `config.session.max_cost`). Add `runner.pause()` and `runner.resume()` methods that stop/restart the send loop.
- **Acceptance**: Integration tests: agent pauses when cost exceeds `max_cost`, session pauses all agents when `session.max_cost` is exceeded, approving resumes the agent, denying transitions agent to done.
- **Dependencies**: T-27, T-28, T-9, T-8

---

### T-31: Wire tool layer into runners

- **Status**: completed
- **Wired**: yes

- **Verified**: yes
- **Requirements**: US-7, US-8, US-14
- **Description**: Integration task. Connect the tool layer to `AgentRunner`. When the runner receives a `tool_call` event, route it through `PermissionGuard.check()`. If allowed, invoke the tool via `ToolRegistry` (for agents with a `remote` config, route through `SSHRunner`). If approval is needed, call `PermissionGuard.requestApproval()` and await the user's decision. Dispatch the `tool_result` or `tool_error` event back to the provider as the next message turn. Wire `ApprovalPrompt` into `App.tsx` so it renders when there are pending approvals in the store.
- **Acceptance**: E2E test with a config that has `tools: [file_read]`. Agent requests `file_write` (not in list) -- approval prompt appears in TUI. Approving executes the tool and the result appears in the agent's conversation. Denying returns a tool error to the agent. The `ApprovalPrompt` is reachable from the TUI when a pending approval exists in the store.
- **Dependencies**: T-23, T-24, T-25, T-26, T-27, T-28, T-29, T-30, T-8, T-9, T-10

---

### T-32: Phase 3 test suite

- **Status**: completed
- **Wired**: n/a
- **Verified**: yes
- **Requirements**: US-7, US-8, US-13, US-14
- **Description**: Write tests for Phase 3 components. Cover: PermissionGuard allow-list enforcement, approval flow end-to-end, tool timeout behavior (all three built-in tools), shell path restriction bypass attempts, SSH connection failure scenarios (auth failure, mid-call drop, reconnect), cost guardrail trigger and resume, session-wide cost limit, isolation between agents' working directories.
- **Acceptance**: All Phase 3 tests pass. Security-critical tests (path traversal, permission bypass attempt) are present and passing. SSH tests use a mock SSH server.
- **Dependencies**: T-31

---

## Phase 4: Plugin System

### T-33: Plugin manifest schema and Zod validation

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-9, US-10
- **Description**: Implement `src/plugins/manifest.ts`. Define and export the `PluginManifest` interface and `PluginManifestSchema` (Zod). The schema validates: `name` (non-empty string), `version` (semver format), `type` ('provider' | 'tool' | 'hook' | 'mixed'), `entry` (relative path string), optional `provides` object. Validate that `provides` entries match `type` -- e.g., a `type: 'tool'` plugin should have `provides.tools` entries.
- **Acceptance**: Unit tests: valid manifest passes, missing required fields fail with specific field names in error, invalid semver fails, type/provides mismatch fails.
- **Dependencies**: T-1, T-2

---

### T-34: Plugin loader

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-9
- **Description**: Implement `src/plugins/loader.ts`. `loadPlugins(pluginRefs: PluginRef[], toolRegistry: ToolRegistry, providerRegistry: Map): Promise<LoadedPlugin[]>`. For each plugin ref: resolve the module path (from `node_modules` by name, or local path if `path` is specified), import the module, validate the exported manifest against `PluginManifestSchema`, call `plugin.register({ toolRegistry, providerRegistry, hooks })` to let the plugin self-register. If loading fails at any step (missing module, invalid manifest, runtime error), log the error, add a warning to the store's status bar state, and continue with remaining plugins. Return an array of successfully loaded plugins.
- **Acceptance**: Unit tests: valid plugin module loads and registers its tools, missing module logs warning and is skipped, invalid manifest logs warning and is skipped, runtime error in `register()` is caught and logged.
- **Dependencies**: T-33, T-23, T-1

---

### T-35: Plugin sandbox enforcement

- **Status**: completed
- **Wired**: yes
- **Verified**: yes
- **Requirements**: US-10
- **Description**: Implement `src/plugins/sandbox.ts`. The `PluginSandbox` wraps the context object passed to `plugin.register()`. It provides a restricted API: tools can be registered, hooks can be registered, but raw provider SDK instances and API keys are never exposed. Implement `validateHook(hookName: string, handler: Function)`: reject hooks named `onPermissionChange` or any hook that attempts to modify agent config permissions at runtime (enforce via a deny-list of hook names). When a plugin-provided tool throws an unhandled exception, catch it in the tool invoker wrapper, log the stack trace, and return a tool error result without crashing.
- **Acceptance**: Unit tests: hook registration with a forbidden name is rejected and logs security warning, plugin tool exception is caught and returns error result, sandbox does not expose provider SDK or API keys.
- **Dependencies**: T-34, T-27

---

### T-36: Lifecycle hooks execution

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-9
- **Description**: Implement hook invocation in `src/runner.ts` and `src/orchestrator.ts`. Define hook types: `onAgentStart(agentId, config)`, `onMessage(agentId, message)`, `onToolCall(agentId, toolCall)`, `onError(agentId, error)`, `onAgentDone(agentId)`. Maintain a `HookRegistry` (map of hook name -> handler array). Invoke hooks at the appropriate points in the lifecycle, calling each registered handler in registration order. Catch exceptions from hook handlers without disrupting the agent lifecycle.
- **Acceptance**: Integration tests: register a mock hook for each lifecycle event, run an agent through a full cycle, verify each hook was called with the correct arguments in order. Exception in a hook handler does not crash the runner.
- **Dependencies**: T-34, T-35, T-8, T-9

---

### T-37: Wire plugin system into orchestrator startup

- **Status**: completed
- **Wired**: yes
- **Verified**: yes
- **Requirements**: US-9, US-10
- **Description**: Integration task. In `src/orchestrator.ts` `start()`, call `loadPlugins(config.plugins, toolRegistry, providerRegistry)` before creating any runners. Pass the loaded hooks to the `HookRegistry`. Verify that a plugin-provided tool is callable by agents that declare it in their `tools` allow-list. Verify that a plugin-provided provider can be specified in an agent's `provider` field. Ensure plugin load failures show a warning in the `StatusBar` but do not abort startup.
- **Acceptance**: E2E test with a local test plugin that registers a custom tool. An agent config declares that tool in its `tools` list. The agent successfully invokes the tool and gets a result. A plugin with a load error shows a warning in the status bar but other agents continue running. The `StatusBar` is updated to show the plugin warning when visible in the TUI.
- **Dependencies**: T-33, T-34, T-35, T-36, T-9, T-12

---

### T-38: Phase 4 test suite

- **Status**: completed
- **Wired**: n/a
- **Verified**: yes
- **Requirements**: US-9, US-10
- **Description**: Write tests for the plugin system. Cover: manifest validation (all valid and invalid cases), plugin loading from local path and node_modules (mocked), hook invocation order, hook exception isolation, sandbox rejection of forbidden hooks, sandbox exception wrapping for tool errors, provider plugin registration and usage, plugin load failure warning display.
- **Acceptance**: All Phase 4 tests pass. Security tests for sandbox bypass attempts are present and passing.
- **Dependencies**: T-37

---

## Phase 5: Forking & Template Marketplace

### T-39: Template manifest schema

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-11, US-12
- **Description**: Implement the `TemplateManifest` interface and Zod schema in `src/templates/manifest.ts`. Fields: `name`, `version` (semver), `description`, `author?`, `repository?`, `requiredEnvVars: string[]`, `dependencies.plugins?: Record<string, string>`. Validate that `requiredEnvVars` contains only env var names (uppercase letters, underscores, digits) and not actual key values (values matching API key patterns fail validation).
- **Acceptance**: Unit tests: valid manifest passes, missing description fails, a value in `requiredEnvVars` that looks like an actual API key (e.g., starts with `sk-`) fails validation.
- **Dependencies**: T-1, T-2

---

### T-40: `orkagent save` command

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-11, NFR-4
- **Description**: Implement `src/templates/save.ts`. `saveTemplate(name: string, configPath: string, outputDir: string)`: read `agents.yaml`, strip any inline API key values (scan for patterns like `sk-`, `ant-`, base64-encoded values), write a sanitized copy as `agents.yaml` in the template directory, generate a `template.yaml` manifest with the provided name, version `1.0.0`, detected `requiredEnvVars` (scan agent configs for provider fields and map to known env var names), and `dependencies.plugins` from the config's plugin list. Write both files to `outputDir/<name>/`.
- **Acceptance**: Unit tests: template directory is created with `agents.yaml` and `template.yaml`, API key values are stripped from the saved yaml, `requiredEnvVars` correctly identifies env vars for each provider, plugin dependencies are captured.
- **Dependencies**: T-39, T-3

---

### T-41: `orkagent publish` command

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-11
- **Description**: Implement `src/templates/publish.ts`. `publishTemplate(name: string, templateDir: string, remote: string)`: initialize a git repo in the template directory if not already one, stage all files, commit with message "release: <name> v<version>", create a version tag, and push with tags to the remote. Use the `simple-git` npm package or spawn git as a subprocess via execFile (to avoid shell injection). Capture and display git output. If the remote is not configured, prompt the user for a remote URL.
- **Acceptance**: Integration test with a temporary git repo: template files are committed and tagged, tag name matches version from manifest, push is invoked with the correct remote.
- **Dependencies**: T-40

---

### T-42: `orkagent fork` command

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-12
- **Description**: Implement `src/templates/fork.ts`. `forkTemplate(repoUrl: string, customName?: string, targetDir: string)`: clone the git repository into `targetDir`, read the cloned `template.yaml`, update the `name` field to `customName` or derive from the repo URL, write the updated manifest back. If `dependencies.plugins` has entries, list them and prompt the user to run `npm install <plugin-names>`. Print each required env var from `requiredEnvVars`.
- **Acceptance**: Integration test: clone succeeds, manifest name is updated, plugin dependency prompt lists correct packages, required env vars are printed.
- **Dependencies**: T-39, T-40

---

### T-43: `orkagent templates search` command

- **Status**: completed
- **Wired**: no
- **Verified**: yes
- **Requirements**: US-12
- **Description**: Implement `src/templates/search.ts`. `searchTemplates(query: string, registryUrl: string)`: fetch a JSON index file from the configured git registry URL (default: a hardcoded GitHub raw URL pointing to a community index). Parse the index (array of `{ name, description, repository, stars, updatedAt }`). Filter entries where name or description contains the query (case-insensitive). Print matching results formatted as a table: name, description, stars, last updated.
- **Acceptance**: Unit test with a mock index: query matches by name, query matches by description, case-insensitive match works, no matches prints "No templates found". Network error prints a user-friendly error.
- **Dependencies**: T-39, T-1

---

### T-44: Wire template commands into CLI entry

- **Status**: completed
- **Wired**: yes
- **Verified**: yes
- **Requirements**: US-11, US-12
- **Description**: Integration task. Add `save`, `publish`, `fork`, and `templates search` subcommands to `src/index.ts`. Each command is reachable from the `orkagent` binary. `save <name>` calls `saveTemplate`. `publish <name>` calls `publishTemplate`. `fork <repo-url> [--name name]` calls `forkTemplate`. `templates search <query>` calls `searchTemplates`.
- **Acceptance**: E2E tests: `orkagent save my-team` creates the template directory. `orkagent fork <test-repo-url>` clones and updates the manifest. `orkagent templates search researcher` returns results from a mock index. All commands print meaningful output on error.
- **Dependencies**: T-40, T-41, T-42, T-43, T-14

---

### T-45: Phase 5 test suite

- **Status**: completed
- **Wired**: n/a
- **Verified**: yes
- **Requirements**: US-11, US-12
- **Description**: Write tests for Phase 5 template features. Cover: save strips API keys and captures env vars, publish creates correct git commit and tag structure, fork updates manifest name and lists plugins, search filters correctly, CLI commands exit with correct codes on success and failure, template manifest validation edge cases.
- **Acceptance**: All Phase 5 tests pass. A test verifying that `save` never writes actual API key values to disk is present and passing.
- **Dependencies**: T-44

---

## Dependency Map

> Note: This diagram shows primary dependency chains. Each task's full
> dependency list is authoritative and may include additional cross-phase
> edges not shown here (e.g., T-31 also depends on T-8, T-9, T-10;
> T-20 also depends on T-9, T-18; T-36 also depends on T-8, T-9).

```
T-1 (scaffolding)
  └─> T-2 (types)
        ├─> T-3 (config)
        │     ├─> T-8 (runner) ─────────────────────────┐
        │     │     ├─> T-9 (orchestrator) ─────────────┤
        │     │     │     └─> T-14 (CLI entry)          │
        │     │     │           └─> T-15 (wire TUI)     │
        │     │     │                 └─> T-16 (P1 tests)│
        │     │     └─> T-18 (dep graph)                │
        │     └─> T-9                                   │
        ├─> T-4 (anthropic adapter) ──> T-9             │
        ├─> T-5 (openai adapter)    ──> T-9             │
        ├─> T-6 (ollama adapter)    ──> T-9             │
        ├─> T-7 (store)                                 │
        │     ├─> T-8                                   │
        │     ├─> T-10 (App.tsx)                        │
        │     │     ├─> T-11 (AgentPane)                │
        │     │     ├─> T-12 (StatusBar)                │
        │     │     └─> T-13 (InputBar)                 │
        │     └─> T-27 (permission guard)               │
        └─> T-17 (event bus)                            │
              ├─> T-18                                  │
              ├─> T-19 (watches)                        │
              │     ├─> T-20 (context_from) <── T-9,T-18│
              │     └─> T-21 (wire event bus)           │
              │           └─> T-22 (P2 tests)           │
              └─> T-22                                  │
                                                        │
T-23 (tool registry)                                    │
  ├─> T-24 (file tools)                                │
  ├─> T-25 (shell tool)                                │
  ├─> T-26 (web search)                                │
  ├─> T-27 (permission guard)                          │
  │     └─> T-28 (approval prompt)                     │
  │           └─> T-30 (cost guardrails) <── T-8,T-9   │
  └─> T-29 (SSH runner)                                │
        └─> T-31 (wire tools) <── T-8,T-9,T-10         │
              └─> T-32 (P3 tests)                      │
                                                        │
T-33 (plugin manifest)                                  │
  └─> T-34 (plugin loader)                             │
        ├─> T-35 (sandbox) <── T-27                    │
        │     └─> T-36 (hooks) <── T-8,T-9 ───────────┘
        │           └─> T-37 (wire plugins) <── T-9,T-12
        │                 └─> T-38 (P4 tests)
        └─> T-36

T-39 (template manifest)
  ├─> T-40 (save) <── T-3
  │     ├─> T-41 (publish)
  │     └─> T-42 (fork)
  ├─> T-43 (search)
  └─> T-44 (wire CLI) <── T-14
        └─> T-45 (P5 tests)
```
