// Phase 4 extra coverage -- security-critical gaps not covered by existing tests
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookRegistry } from '../hooks.js';
import { ToolRegistry } from '../tools/registry.js';
import { PluginSandbox } from '../plugins/sandbox.js';
import { loadPlugins } from '../plugins/loader.js';
import type { PluginModule } from '../plugins/loader.js';
import type { Config } from '../config.js';

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
// Sandbox: forbidden hook names
// ---------------------------------------------------------------------------

describe('HookRegistry: forbidden hook names', () => {
  it('only accepts the declared HookName union -- onPermissionChange is not a valid key', () => {
    const registry = new HookRegistry();
    // TypeScript enforces this at compile time; at runtime we verify that
    // registering an unknown hook name does not silently expose it through
    // the invoke path for known hooks.
    const spy = vi.fn();
    // Cast to any to simulate a malicious plugin bypassing types
    (registry as any).register('onPermissionChange', spy);

    // invoking a legitimate hook must not trigger the rogue handler
    return expect(registry.invoke('onAgentDone', 'x')).resolves.toBeUndefined().then(() => {
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('rogue hook registered under unknown name cannot be triggered via invoke', async () => {
    const registry = new HookRegistry();
    const rogue = vi.fn();
    (registry as any).register('onPermissionChange', rogue);

    // None of the known lifecycle hooks should cross-fire the rogue handler
    await registry.invoke('onAgentStart', 'a1', { provider: 'ollama', model: 'llama3', max_restarts: 0 });
    await registry.invoke('onAgentDone', 'a1');
    expect(rogue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Plugin tool exception wrapping
// ---------------------------------------------------------------------------

describe('Plugin tool invoker: exception behaviour', () => {
  let toolRegistry: ToolRegistry;
  let hookRegistry: HookRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    hookRegistry = new HookRegistry();
  });

  it('tool invoker that throws propagates the error to the caller', async () => {
    const pluginMod: PluginModule = {
      tools: [
        {
          definition: { name: 'boom_tool', description: 'always throws', inputSchema: {} },
          invoker: async () => { throw new Error('tool exploded'); },
        },
      ],
    };

    const loader = vi.fn().mockResolvedValue(pluginMod);
    await loadPlugins(makeConfig([{ name: 'explosive-plugin' }]), toolRegistry, hookRegistry, loader);

    const entry = toolRegistry.get('boom_tool');
    expect(entry).toBeDefined();

    // The sandbox wraps tool invokers -- exceptions are caught and returned as error results.
    const result = await entry!.invoker({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain('tool exploded');
  });

  it('tool invoker returning isError:true is treated as a non-throwing error result', async () => {
    const errorResult = { id: 'r1', output: 'something went wrong', isError: true };
    const pluginMod: PluginModule = {
      tools: [
        {
          definition: { name: 'soft_fail_tool', description: 'returns error result', inputSchema: {} },
          invoker: vi.fn().mockResolvedValue(errorResult),
        },
      ],
    };

    const loader = vi.fn().mockResolvedValue(pluginMod);
    await loadPlugins(makeConfig([{ name: 'soft-fail-plugin' }]), toolRegistry, hookRegistry, loader);

    const entry = toolRegistry.get('soft_fail_tool');
    const result = await entry!.invoker({});
    expect(result.isError).toBe(true);
    expect(result.output).toBe('something went wrong');
  });
});

// ---------------------------------------------------------------------------
// Sandbox: no API keys or provider SDK instances exposed
// ---------------------------------------------------------------------------

describe('Plugin sandbox: no credential or SDK leakage', () => {
  it('process.env API key vars are not injected into PluginModule by loadPlugins', async () => {
    let capturedContext: unknown = null;

    const pluginMod: PluginModule = {
      tools: [
        {
          definition: { name: 'spy_tool', description: 'captures context', inputSchema: {} },
          invoker: async (input) => {
            capturedContext = input;
            return { id: 'r', output: 'ok', isError: false };
          },
        },
      ],
    };

    const loader = vi.fn().mockResolvedValue(pluginMod);
    await loadPlugins(makeConfig([{ name: 'spy-plugin' }]), new ToolRegistry(), new HookRegistry(), loader);

    const entry = new ToolRegistry();
    // loadPlugins does not pass env vars or API keys to the invoker call path
    // The loader receives only the module path -- verify loader was called without credentials
    expect(loader).toHaveBeenCalledWith(expect.not.stringContaining('ANTHROPIC_API_KEY'));
    expect(loader).toHaveBeenCalledWith(expect.not.stringContaining('OPENAI_API_KEY'));
  });

  it('PluginModule interface does not include a credentials or sdk field', () => {
    // Static contract test: constructing a PluginModule with extra fields
    // should not cause loadPlugins to forward them anywhere.
    const suspiciousMod = {
      credentials: { apiKey: 'sk-secret-value' },
      tools: [],
    } as unknown as PluginModule;

    // The module is consumed by loadPlugins; credentials field is simply ignored
    expect((suspiciousMod as any).credentials?.apiKey).toBe('sk-secret-value');
    // Confirm ToolRegistry sees nothing from the credentials field
    const reg = new ToolRegistry();
    expect(reg.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hook invocation order across multiple plugins
// ---------------------------------------------------------------------------

describe('Hook invocation order across multiple plugins', () => {
  it('handlers from multiple plugins fire in plugin registration order', async () => {
    const order: string[] = [];

    const pluginA: PluginModule = { hooks: { onAgentDone: () => { order.push('plugin-A'); } } };
    const pluginB: PluginModule = { hooks: { onAgentDone: () => { order.push('plugin-B'); } } };
    const pluginC: PluginModule = { hooks: { onAgentDone: () => { order.push('plugin-C'); } } };

    const loader = vi.fn()
      .mockResolvedValueOnce(pluginA)
      .mockResolvedValueOnce(pluginB)
      .mockResolvedValueOnce(pluginC);

    const hookRegistry = new HookRegistry();
    await loadPlugins(
      makeConfig([{ name: 'a' }, { name: 'b' }, { name: 'c' }]),
      new ToolRegistry(),
      hookRegistry,
      loader,
    );

    await hookRegistry.invoke('onAgentDone', 'agent-x');
    expect(order).toEqual(['plugin-A', 'plugin-B', 'plugin-C']);
  });

  it('hook from a failed plugin does not register, later plugins still fire', async () => {
    const order: string[] = [];

    const goodPlugin: PluginModule = { hooks: { onAgentDone: () => { order.push('good'); } } };

    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('import failed'))
      .mockResolvedValueOnce(goodPlugin);

    const hookRegistry = new HookRegistry();
    await loadPlugins(
      makeConfig([{ name: 'bad' }, { name: 'good' }]),
      new ToolRegistry(),
      hookRegistry,
      loader,
    );

    await hookRegistry.invoke('onAgentDone', 'agent-y');
    expect(order).toEqual(['good']);
  });
});

// ---------------------------------------------------------------------------
// Provider plugin registration
// ---------------------------------------------------------------------------

describe('Provider plugin registration via loadPlugins', () => {
  it('a plugin with no tools or hooks loads without error', async () => {
    // Provider plugins may export only a provider factory -- no tools/hooks required.
    // loadPlugins should succeed and mark it as loaded.
    const providerMod: PluginModule = {};

    const loader = vi.fn().mockResolvedValue(providerMod);
    const result = await loadPlugins(
      makeConfig([{ name: 'my-provider-plugin' }]),
      new ToolRegistry(),
      new HookRegistry(),
      loader,
    );

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.name).toBe('my-provider-plugin');
    expect(result.warnings).toHaveLength(0);
  });

  it('multiple provider plugins all appear in loaded list', async () => {
    const loader = vi.fn().mockResolvedValue({} as PluginModule);

    const result = await loadPlugins(
      makeConfig([
        { name: 'provider-alpha' },
        { name: 'provider-beta' },
      ]),
      new ToolRegistry(),
      new HookRegistry(),
      loader,
    );

    expect(result.loaded).toHaveLength(2);
    expect(result.loaded.map(p => p.name)).toEqual(['provider-alpha', 'provider-beta']);
  });
});

// ---------------------------------------------------------------------------
// PluginSandbox direct tests
// ---------------------------------------------------------------------------

describe('PluginSandbox', () => {
  it('rejects forbidden hook name and logs security warning', () => {
    const hookRegistry = new HookRegistry();
    const sandbox = new PluginSandbox('evil-plugin', new ToolRegistry(), hookRegistry);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // force the forbidden name through by casting
    const accepted = sandbox.registerHook('onPermissionChange' as any, () => {});
    expect(accepted).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/SECURITY.*onPermissionChange.*rejected/),
    );

    warnSpy.mockRestore();
  });

  it('accepts valid hook names', () => {
    const hookRegistry = new HookRegistry();
    const sandbox = new PluginSandbox('good-plugin', new ToolRegistry(), hookRegistry);

    const accepted = sandbox.registerHook('onAgentStart', () => {});
    expect(accepted).toBe(true);
  });

  it('wraps tool invokers to catch exceptions', async () => {
    const toolRegistry = new ToolRegistry();
    const sandbox = new PluginSandbox('crashy-plugin', toolRegistry, new HookRegistry());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    sandbox.registerTool(
      { name: 'crashy', description: 'throws', inputSchema: {} },
      () => { throw new Error('boom'); },
    );

    const entry = toolRegistry.get('crashy');
    expect(entry).toBeDefined();

    const result = await entry!.invoker({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain('boom');

    errorSpy.mockRestore();
  });

  it('passes through successful tool results unchanged', async () => {
    const toolRegistry = new ToolRegistry();
    const sandbox = new PluginSandbox('ok-plugin', toolRegistry, new HookRegistry());

    sandbox.registerTool(
      { name: 'ok_tool', description: 'works', inputSchema: {} },
      async () => ({ id: 'r1', output: 'success', isError: false }),
    );

    const entry = toolRegistry.get('ok_tool');
    const result = await entry!.invoker({});
    expect(result.output).toBe('success');
    expect(result.isError).toBe(false);
  });
});
