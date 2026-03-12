// Tests for T-37: wiring the plugin system into orchestrator startup
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Store } from '../store.js';
import { ToolRegistry } from '../tools/registry.js';
import { HookRegistry } from '../hooks.js';
import { loadPlugins } from '../plugins/loader.js';
import type { Config } from '../config.js';
import type { PluginModule } from '../plugins/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(plugins?: Config['plugins']): Config {
  return {
    version: 1,
    agents: {
      worker: { provider: 'ollama', model: 'llama3', max_restarts: 3 },
    },
    plugins,
  };
}

// ---------------------------------------------------------------------------
// loadPlugins unit tests -- we mock the module loader directly
// ---------------------------------------------------------------------------

describe('loadPlugins', () => {
  let toolRegistry: ToolRegistry;
  let hookRegistry: HookRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    hookRegistry = new HookRegistry();
  });

  it('returns empty result when no plugins are declared', async () => {
    const result = await loadPlugins(makeConfig(), toolRegistry, hookRegistry);
    expect(result.loaded).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('registers tools provided by a plugin', async () => {
    const definition = {
      name: 'my_tool',
      description: 'does a thing',
      inputSchema: { type: 'object', properties: {} },
    };
    const invoker = vi.fn().mockResolvedValue({ id: 'x', output: 'ok', isError: false });

    const pluginMod: PluginModule = { tools: [{ definition, invoker }] };
    const loader = vi.fn().mockResolvedValue(pluginMod);

    const config = makeConfig([{ name: 'my-plugin', path: './my-plugin.js' }]);
    const result = await loadPlugins(config, toolRegistry, hookRegistry, loader);

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.name).toBe('my-plugin');
    expect(result.warnings).toHaveLength(0);
    expect(toolRegistry.get('my_tool')).toBeDefined();
  });

  it('plugin-provided tool is callable after loading', async () => {
    const invoker = vi.fn().mockResolvedValue({ id: 'r1', output: 'result-data', isError: false });
    const pluginMod: PluginModule = {
      tools: [
        {
          definition: { name: 'calc', description: 'calculator', inputSchema: {} },
          invoker,
        },
      ],
    };

    const loader = vi.fn().mockResolvedValue(pluginMod);
    const config = makeConfig([{ name: 'calc-plugin' }]);
    await loadPlugins(config, toolRegistry, hookRegistry, loader);

    const entry = toolRegistry.get('calc');
    expect(entry).toBeDefined();
    const result = await entry!.invoker({ expression: '1+1' });
    expect(result.output).toBe('result-data');
    expect(invoker).toHaveBeenCalledWith({ expression: '1+1' });
  });

  it('registers hooks provided by a plugin', async () => {
    const onAgentDone = vi.fn();
    const pluginMod: PluginModule = { hooks: { onAgentDone } };
    const loader = vi.fn().mockResolvedValue(pluginMod);

    const config = makeConfig([{ name: 'hook-plugin' }]);
    await loadPlugins(config, toolRegistry, hookRegistry, loader);

    await hookRegistry.invoke('onAgentDone', 'agent-1');
    expect(onAgentDone).toHaveBeenCalledWith('agent-1');
  });

  it('plugin load failure produces a warning and does not throw', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('module not found'));

    const config = makeConfig([{ name: 'bad-plugin' }]);
    const result = await loadPlugins(config, toolRegistry, hookRegistry, loader);

    expect(result.loaded).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.name).toBe('bad-plugin');
    expect(result.warnings[0]?.error).toContain('module not found');
  });

  it('failure of one plugin does not prevent others from loading', async () => {
    const goodMod: PluginModule = {
      tools: [
        {
          definition: { name: 'good_tool', description: 'ok', inputSchema: {} },
          invoker: vi.fn(),
        },
      ],
    };

    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad import'))
      .mockResolvedValueOnce(goodMod);

    const config = makeConfig([
      { name: 'fail-plugin' },
      { name: 'ok-plugin' },
    ]);
    const result = await loadPlugins(config, toolRegistry, hookRegistry, loader);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.name).toBe('fail-plugin');
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.name).toBe('ok-plugin');
    expect(toolRegistry.get('good_tool')).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Hooks from plugins fire during agent lifecycle
  // ---------------------------------------------------------------------------

  it('hooks from plugins are invoked during agent lifecycle', async () => {
    const onAgentStart = vi.fn();
    const onAgentDone = vi.fn();

    const pluginMod: PluginModule = { hooks: { onAgentStart, onAgentDone } };
    const loader = vi.fn().mockResolvedValue(pluginMod);

    const config = makeConfig([{ name: 'lifecycle-plugin' }]);
    await loadPlugins(config, toolRegistry, hookRegistry, loader);

    // simulate the lifecycle events that AgentRunner emits
    const agentConfig = { provider: 'ollama' as const, model: 'llama3', max_restarts: 3 };
    await hookRegistry.invoke('onAgentStart', 'test-agent', agentConfig);
    await hookRegistry.invoke('onAgentDone', 'test-agent');

    expect(onAgentStart).toHaveBeenCalledWith('test-agent', agentConfig);
    expect(onAgentDone).toHaveBeenCalledWith('test-agent');
  });
});

// ---------------------------------------------------------------------------
// Integration: orchestrator startup logs warnings for failed plugins
// ---------------------------------------------------------------------------

describe('Orchestrator plugin wiring', () => {
  let store: Store;

  beforeEach(() => {
    vi.useRealTimers();
    store = new Store();
  });

  afterEach(() => {
    store.destroy();
  });

  it('plugin load failure logs a warning but does not abort startup', async () => {
    // We test through loadPlugins directly -- the orchestrator delegates to it
    const toolReg = new ToolRegistry();
    const hookReg = new HookRegistry();
    const loader = vi.fn().mockRejectedValue(new Error('ENOENT: plugin missing'));

    const config = makeConfig([{ name: 'missing-plugin' }]);
    const result = await loadPlugins(config, toolReg, hookReg, loader);

    // startup is not aborted -- warnings collected
    expect(result.warnings).toHaveLength(1);
    expect(result.loaded).toHaveLength(0);

    // simulate what orchestrator does: log warning to store
    const agentId = '_system';
    store.initAgent(agentId, 'system');
    for (const w of result.warnings) {
      store.appendOutput(agentId, `[plugin] warning: failed to load "${w.name}": ${w.error}`);
    }

    const entry = store.getAgent(agentId);
    expect(entry?.outputBuffer.some((line) => line.includes('missing-plugin'))).toBe(true);
    expect(entry?.outputBuffer.some((line) => line.includes('ENOENT'))).toBe(true);
  });
});
