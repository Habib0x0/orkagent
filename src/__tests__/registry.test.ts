import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition } from '../providers/types.js';

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'returns the input',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

const greetTool: ToolDefinition = {
  name: 'greet',
  description: 'says hello',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
};

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const reg = new ToolRegistry();
    const invoker = vi.fn().mockResolvedValue({ id: '1', output: 'hi', isError: false });
    reg.register(echoTool, invoker);
    const entry = reg.get('echo');
    expect(entry).toBeDefined();
    expect(entry!.definition).toBe(echoTool);
    expect(entry!.invoker).toBe(invoker);
  });

  it('returns undefined for unknown tool', () => {
    const reg = new ToolRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('list returns all registered definitions', () => {
    const reg = new ToolRegistry();
    reg.register(echoTool, vi.fn());
    reg.register(greetTool, vi.fn());
    const list = reg.list();
    expect(list).toHaveLength(2);
    expect(list.map(d => d.name)).toContain('echo');
    expect(list.map(d => d.name)).toContain('greet');
  });

  it('list returns empty array when nothing registered', () => {
    const reg = new ToolRegistry();
    expect(reg.list()).toEqual([]);
  });

  it('registering same name twice overwrites the previous entry', () => {
    const reg = new ToolRegistry();
    const first = vi.fn();
    const second = vi.fn();
    reg.register(echoTool, first);
    reg.register(echoTool, second);
    expect(reg.get('echo')!.invoker).toBe(second);
    expect(reg.list()).toHaveLength(1);
  });

  it('invoker is callable and returns ToolResult', async () => {
    const reg = new ToolRegistry();
    const result = { id: 'x', output: 'ok', isError: false };
    reg.register(echoTool, async () => result);
    const entry = reg.get('echo')!;
    await expect(entry.invoker({ text: 'hi' })).resolves.toEqual(result);
  });
});
