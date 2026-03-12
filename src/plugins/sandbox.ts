// PluginSandbox -- security boundary for plugin context
// Implementation: T-35

import type { ToolDefinition, ToolResult } from '../providers/types.js';
import type { ToolInvoker } from '../tools/registry.js';
import type { HookRegistry, HookName, HookMap, HookHandler } from '../hooks.js';
import type { ToolRegistry } from '../tools/registry.js';

// hooks that plugins must never register -- they could escalate permissions
const FORBIDDEN_HOOKS = new Set<string>([
  'onPermissionChange',
  'onConfigMutate',
  'onAllowListModify',
]);

export class PluginSandbox {
  constructor(
    private readonly pluginName: string,
    private readonly toolRegistry: ToolRegistry,
    private readonly hookRegistry: HookRegistry,
  ) {}

  /** Register a tool with exception wrapping -- plugin tool errors never crash the host. */
  registerTool(definition: ToolDefinition, invoker: ToolInvoker): void {
    const wrappedInvoker: ToolInvoker = async (input: unknown): Promise<ToolResult> => {
      try {
        return await invoker(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sandbox] plugin "${this.pluginName}" tool "${definition.name}" threw:`, msg);
        return { id: '', output: `plugin tool error: ${msg}`, isError: true };
      }
    };
    this.toolRegistry.register(definition, wrappedInvoker);
  }

  /** Register a hook, rejecting forbidden names with a security warning. */
  registerHook<K extends HookName>(name: K, handler: HookHandler<HookMap[K]>): boolean {
    if (FORBIDDEN_HOOKS.has(name as string)) {
      console.warn(
        `[sandbox] SECURITY: plugin "${this.pluginName}" attempted to register forbidden hook "${name}" -- rejected`,
      );
      return false;
    }
    this.hookRegistry.register(name, handler);
    return true;
  }
}
