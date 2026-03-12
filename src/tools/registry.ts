// ToolRegistry -- tool registration and lookup
import type { ToolDefinition, ToolResult } from '../providers/types.js';

export type ToolInvoker = (input: unknown) => Promise<ToolResult>;

interface ToolEntry {
  definition: ToolDefinition;
  invoker: ToolInvoker;
}

export class ToolRegistry {
  private tools = new Map<string, ToolEntry>();

  register(definition: ToolDefinition, invoker: ToolInvoker): void {
    this.tools.set(definition.name, { definition, invoker });
  }

  get(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(e => e.definition);
  }
}
