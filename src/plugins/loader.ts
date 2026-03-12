// Plugin loader -- discover, validate, and load plugins
// Implementation: T-34, T-37

import type { Config } from '../config.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { HookRegistry, HookName, HookMap, HookHandler } from '../hooks.js';

export interface LoadedPlugin {
  name: string;
}

export interface PluginModule {
  // tools: array of { definition, invoker } pairs
  tools?: Array<{
    definition: import('../providers/types.js').ToolDefinition;
    invoker: import('../tools/registry.js').ToolInvoker;
  }>;
  // hooks: map from hook name to handler
  hooks?: Partial<{ [K in HookName]: HookHandler<HookMap[K]> }>;
}

export interface PluginLoadResult {
  loaded: LoadedPlugin[];
  warnings: Array<{ name: string; error: string }>;
}

// loadPlugins loads all plugins declared in config.plugins.
// Failures are collected and returned as warnings -- they do not throw.
export async function loadPlugins(
  config: Config,
  toolRegistry: ToolRegistry,
  hookRegistry: HookRegistry,
  // optional module loader -- defaults to dynamic import; override in tests
  moduleLoader: (path: string) => Promise<unknown> = (p) => import(p),
): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], warnings: [] };

  if (!config.plugins || config.plugins.length === 0) {
    return result;
  }

  for (const ref of config.plugins) {
    try {
      const entryPath = ref.path ?? ref.name;
      const mod = (await moduleLoader(entryPath)) as PluginModule;

      if (mod.tools) {
        for (const { definition, invoker } of mod.tools) {
          toolRegistry.register(definition, invoker);
        }
      }

      if (mod.hooks) {
        for (const [hookName, handler] of Object.entries(mod.hooks) as Array<
          [HookName, HookHandler<HookMap[HookName]>]
        >) {
          // cast needed because Object.entries loses the key/value correlation
          hookRegistry.register(hookName, handler as HookHandler<HookMap[typeof hookName]>);
        }
      }

      result.loaded.push({ name: ref.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.warnings.push({ name: ref.name, error: message });
    }
  }

  return result;
}
