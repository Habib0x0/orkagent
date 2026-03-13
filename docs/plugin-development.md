# Plugin Development Guide

Plugins extend orkagent with custom tools and lifecycle hooks. They are loaded at startup before any agents run, and their registrations are available to all agents in the session.

---

## Overview

A plugin is a Node.js ES module that exports two optional fields:

- **`tools`**: An array of `{ definition, invoker }` pairs that register new tools.
- **`hooks`**: An object mapping lifecycle hook names to handler functions.

A plugin may export only tools, only hooks, or both.

Plugins are declared in `agents.yaml` under the `plugins` key:

```yaml
plugins:
  - name: my-plugin
    path: ./plugins/my-plugin.js
```

---

## Manifest Schema

Each plugin directory should contain a `plugin.yaml` manifest. This is validated by orkagent when loading plugins discovered by name (rather than local path). The manifest is enforced via Zod.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` (non-empty) | Yes | Plugin name. Should match the npm package name. |
| `version` | `string` (semver) | Yes | Plugin version. Must be valid semver (e.g., `1.0.0`, `2.1.0-beta.1`). |
| `type` | `"provider" \| "tool" \| "hook" \| "mixed"` | Yes | Declares what the plugin registers. Used to validate the `provides` block. |
| `entry` | `string` (non-empty) | Yes | Relative path to the plugin's main export file. |
| `provides` | `ProvidesConfig` | No | Lists what the plugin registers. Must match `type`. |

### `provides` Fields

| Field | Type | Valid for `type` | Description |
|-------|------|-----------------|-------------|
| `provides.tools` | `string[]` | `tool`, `mixed` | Tool names registered by this plugin. |
| `provides.providers` | `string[]` | `provider`, `mixed` | Provider names registered. |
| `provides.hooks` | `string[]` | `hook`, `mixed` | Hook names handled. |

A plugin of `type: tool` that declares `provides.hooks` will fail manifest validation.

**Example `plugin.yaml`:**

```yaml
name: orkagent-jira
version: 1.0.0
type: tool
entry: ./dist/index.js
provides:
  tools:
    - jira_create_issue
    - jira_search_issues
```

---

## Module Interface

The plugin entry file must export a `PluginModule` object. TypeScript types:

```typescript
interface PluginModule {
  tools?: Array<{
    definition: ToolDefinition;
    invoker: ToolInvoker;
  }>;
  hooks?: Partial<{
    onAgentStart: (agentId: string, config: AgentConfig) => void | Promise<void>;
    onMessage: (agentId: string, message: Message) => void | Promise<void>;
    onToolCall: (agentId: string, toolCall: ToolCall) => void | Promise<void>;
    onError: (agentId: string, error: { code: string; message: string; retryable: boolean }) => void | Promise<void>;
    onAgentDone: (agentId: string) => void | Promise<void>;
  }>;
}
```

---

## Registering Tools

### ToolDefinition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Tool name. Must be unique across all tools (built-in and plugin). |
| `description` | `string` | Yes | Human-readable description passed to the model so it knows when to call the tool. |
| `inputSchema` | `Record<string, unknown>` | Yes | JSON Schema object describing the tool's input parameters. |

### ToolInvoker

```typescript
type ToolInvoker = (input: unknown) => Promise<{
  id: string;
  output: string;
  isError: boolean;
}>;
```

The `id` field in the return value should be set to `''` (empty string) — the runner fills in the real call ID automatically.

### Example: Simple Tool Plugin

```javascript
// plugins/word-count.js

export const tools = [
  {
    definition: {
      name: 'word_count',
      description: 'Count the number of words in a string.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to count words in' },
        },
        required: ['text'],
      },
    },
    async invoker(input) {
      const { text } = input;
      const count = text.trim().split(/\s+/).filter(Boolean).length;
      return { id: '', output: String(count), isError: false };
    },
  },
];
```

Register it in `agents.yaml`:

```yaml
plugins:
  - name: word-count
    path: ./plugins/word-count.js

agents:
  editor:
    provider: ollama
    model: qwen2.5:0.5b
    tools:
      - word_count
```

The `word_count` tool is only called without an approval prompt for agents that include it in their `tools` allow-list. Other agents trigger an approval prompt.

---

## Lifecycle Hooks

Hooks let plugins observe and react to agent lifecycle events. Hooks are invoked in registration order. Hook exceptions are caught and logged — they never crash the agent.

### Available Hooks

| Hook name | Arguments | Fired when |
|-----------|-----------|------------|
| `onAgentStart` | `agentId: string, config: AgentConfig` | The agent starts its first send cycle. |
| `onMessage` | `agentId: string, message: Message` | The agent receives an assistant text chunk from the model. |
| `onToolCall` | `agentId: string, toolCall: ToolCall` | The agent's runner dispatches a tool call (before execution). |
| `onError` | `agentId: string, error: { code, message, retryable }` | A stream error event is received. |
| `onAgentDone` | `agentId: string` | The agent completes a full send cycle (reaches `idle`). |

### Forbidden Hook Names

The sandbox rejects registration of the following hook names with a security warning:

- `onPermissionChange`
- `onConfigMutate`
- `onAllowListModify`

These names are blocked because they could escalate tool permissions at runtime.

### Example: Logging Hook Plugin

```javascript
// plugins/audit-logger.js
import { appendFileSync } from 'fs';

const logPath = './orkagent-audit.log';

function log(entry) {
  appendFileSync(logPath, JSON.stringify({ ...entry, ts: Date.now() }) + '\n');
}

export const hooks = {
  onAgentStart(agentId, config) {
    log({ event: 'start', agentId, provider: config.provider, model: config.model });
  },

  onToolCall(agentId, toolCall) {
    log({ event: 'tool_call', agentId, tool: toolCall.name });
  },

  onError(agentId, error) {
    log({ event: 'error', agentId, code: error.code, message: error.message });
  },

  onAgentDone(agentId) {
    log({ event: 'done', agentId });
  },
};
```

```yaml
plugins:
  - name: audit-logger
    path: ./plugins/audit-logger.js
```

---

## Mixed Plugin (Tools + Hooks)

```javascript
// plugins/metrics.js

let callCounts = {};

export const tools = [
  {
    definition: {
      name: 'get_metrics',
      description: 'Return the current tool call count per agent.',
      inputSchema: { type: 'object', properties: {} },
    },
    async invoker(_input) {
      return { id: '', output: JSON.stringify(callCounts, null, 2), isError: false };
    },
  },
];

export const hooks = {
  onToolCall(agentId, toolCall) {
    const key = `${agentId}:${toolCall.name}`;
    callCounts[key] = (callCounts[key] ?? 0) + 1;
  },
};
```

Use `type: mixed` in the manifest:

```yaml
name: metrics
version: 1.0.0
type: mixed
entry: ./dist/index.js
provides:
  tools:
    - get_metrics
  hooks:
    - onToolCall
```

---

## Sandbox Security Rules

All plugin code runs through a `PluginSandbox` (`src/plugins/sandbox.ts`) that enforces the following:

**What plugins can do:**
- Register tools via `registerTool(definition, invoker)`
- Register allowed lifecycle hooks via `registerHook(name, handler)`

**What plugins cannot do:**
- Register forbidden hook names (`onPermissionChange`, `onConfigMutate`, `onAllowListModify`)
- Access raw provider SDK instances (`Anthropic`, `OpenAI`)
- Read API keys from the orchestrator
- Modify agent allow-lists directly

**Error isolation:** If a plugin-provided tool throws an unhandled exception, the sandbox catches it, logs the stack trace to stderr, and returns a tool error result to the model. The agent continues running.

**Important limitation:** Plugins run in-process. A deliberately malicious plugin with access to Node.js globals (`process`, `fs`, etc.) can bypass these controls. Only load plugins you trust or have audited.

---

## Loading Behavior

Plugins are loaded in the order they appear in the `plugins` array, before any agent runners start. If a plugin fails to load (missing module, invalid manifest, exception in the module body), orkagent logs a warning and continues. The warning appears in the status bar output as:

```
[plugin] warning: failed to load "<name>": <error message>
```

All remaining plugins continue to load. Agent startup proceeds after all plugins have been processed (loaded or skipped).

---

## TypeScript Plugin

For type safety, reference the source types directly (types are not yet published as a separate package):

```typescript
// plugins/my-plugin.ts
import type { ToolDefinition } from '../src/providers/types.js';
import type { ToolInvoker } from '../src/tools/registry.js';

const definition: ToolDefinition = {
  name: 'my_tool',
  description: 'Does something useful.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string' },
    },
    required: ['input'],
  },
};

const invoker: ToolInvoker = async (raw) => {
  const { input } = raw as { input: string };
  return { id: '', output: `processed: ${input}`, isError: false };
};

export const tools = [{ definition, invoker }];
```

Build the plugin to a `.js` file and reference the output path in `agents.yaml`:

```yaml
plugins:
  - name: my-plugin
    path: ./dist/plugins/my-plugin.js
```

---

## Configuration Access

The `config` field in the `PluginRef` is stored but not currently forwarded to the plugin module at load time. To pass runtime configuration to a plugin, use environment variables or a config file that the plugin reads at module load time:

```yaml
plugins:
  - name: my-plugin
    path: ./plugins/my-plugin.js
    # config field is stored but not yet passed to the module
```

```javascript
// read config from env instead
const API_URL = process.env.MY_PLUGIN_API_URL ?? 'https://default.example.com';
```
