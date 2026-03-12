import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRunner } from '../runner.js';
import { Store } from '../store.js';
import { ToolRegistry } from '../tools/registry.js';
import { PermissionGuard } from '../tools/permission.js';
import type { AgentConfig } from '../config.js';
import type { AgentProvider, Message, StreamEvent, ToolResult } from '../providers/types.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: 'anthropic',
    model: 'claude-3',
    max_restarts: 3,
    ...overrides,
  };
}

function makeEvent(
  type: StreamEvent['type'],
  overrides: Partial<StreamEvent> = {},
): StreamEvent {
  return {
    type,
    agentId: 'test-agent',
    timestamp: Date.now(),
    ...overrides,
  };
}

function mockProvider(sequences: StreamEvent[][]): AgentProvider {
  let callCount = 0;
  return {
    send(_messages: Message[]) {
      const events = sequences[callCount] ?? [];
      callCount++;
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    abort: vi.fn(),
  };
}

function makeRegistry(): ToolRegistry {
  return new ToolRegistry();
}

const AGENT_ID = 'agent-1';

describe('wire-tools: tool layer integration in AgentRunner', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store();
    store.initAgent(AGENT_ID, 'tester');
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it('auto-executes a tool in the allow-list without approval prompt', async () => {
    const registry = makeRegistry();
    const invoker = vi.fn().mockResolvedValue({ id: '', output: 'file contents', isError: false } as ToolResult);
    registry.register(
      { name: 'file_read', description: 'read a file', inputSchema: {} },
      invoker,
    );
    const guard = new PermissionGuard(store, ['file_read']);

    const provider = mockProvider([[
      makeEvent('tool_call', {
        toolCall: { id: 'tc-1', name: 'file_read', input: { path: '/tmp/test.txt' } },
      }),
      makeEvent('done'),
    ]]);

    const runner = new AgentRunner(
      AGENT_ID,
      makeConfig({ tools: ['file_read'] }),
      provider,
      store,
      undefined,
      undefined,
      registry,
      guard,
    );
    await runner.start();

    // invoker should have been called, no approval should be pending
    expect(invoker).toHaveBeenCalledOnce();
    expect(store.getState().pendingApprovals).toHaveLength(0);
  });

  it('triggers approval flow for tool NOT in the allow-list', async () => {
    vi.useRealTimers();

    const registry = makeRegistry();
    const invoker = vi.fn().mockResolvedValue({ id: '', output: 'search results', isError: false } as ToolResult);
    registry.register(
      { name: 'web_search', description: 'search the web', inputSchema: {} },
      invoker,
    );
    // allow-list does NOT include web_search
    const guard = new PermissionGuard(store, ['file_read']);

    const provider = mockProvider([[
      makeEvent('tool_call', {
        toolCall: { id: 'tc-2', name: 'web_search', input: { query: 'vitest' } },
      }),
      makeEvent('done'),
    ]]);

    const runner = new AgentRunner(
      AGENT_ID,
      makeConfig(),
      provider,
      store,
      undefined,
      undefined,
      registry,
      guard,
    );

    // start the runner but don't await -- it will suspend on approval
    const runPromise = runner.start();

    // wait briefly for the approval to appear in the store
    await new Promise((r) => setTimeout(r, 20));

    const state = store.getState();
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0]?.toolName).toBe('web_search');

    // approve it so the runner can finish
    store.resolvePendingApproval(state.pendingApprovals[0]!.id, 'approve');

    await runPromise;
    expect(invoker).toHaveBeenCalledOnce();
  });

  it('replaces stub with real tool result in conversation history', async () => {
    const registry = makeRegistry();
    registry.register(
      { name: 'file_read', description: 'read a file', inputSchema: {} },
      async () => ({ id: '', output: 'real file content', isError: false }),
    );
    const guard = new PermissionGuard(store, ['file_read']);

    const provider = mockProvider([[
      makeEvent('tool_call', {
        toolCall: { id: 'tc-3', name: 'file_read', input: { path: '/tmp/real.txt' } },
      }),
      makeEvent('done'),
    ]]);

    const runner = new AgentRunner(
      AGENT_ID,
      makeConfig(),
      provider,
      store,
      undefined,
      undefined,
      registry,
      guard,
    );
    await runner.start();

    const history = runner.getHistory();
    const toolMsg = history.find((m) => m.role === 'tool' && m.toolCallId === 'tc-3');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toBe('real file content');
    // should NOT be the old stub text
    expect(toolMsg?.content).not.toContain('[stub result for');
  });

  it('returns isError: true in history when tool execution throws', async () => {
    const registry = makeRegistry();
    registry.register(
      { name: 'shell', description: 'run shell', inputSchema: {} },
      async () => { throw new Error('command not found'); },
    );
    const guard = new PermissionGuard(store, ['shell']);

    const provider = mockProvider([[
      makeEvent('tool_call', {
        toolCall: { id: 'tc-4', name: 'shell', input: { command: 'bad-cmd' } },
      }),
      makeEvent('done'),
    ]]);

    const runner = new AgentRunner(
      AGENT_ID,
      makeConfig(),
      provider,
      store,
      undefined,
      undefined,
      registry,
      guard,
    );
    await runner.start();

    const history = runner.getHistory();
    const toolMsg = history.find((m) => m.role === 'tool' && m.toolCallId === 'tc-4');
    expect(toolMsg).toBeDefined();

    const result = toolMsg?.toolResults?.[0];
    expect(result?.isError).toBe(true);
    expect(result?.output).toContain('command not found');
  });

  it('falls back to stub when no registry is provided', async () => {
    // no registry, no guard -- original behaviour
    const provider = mockProvider([[
      makeEvent('tool_call', {
        toolCall: { id: 'tc-5', name: 'file_read', input: { path: '/tmp/x' } },
      }),
      makeEvent('done'),
    ]]);

    const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store);
    await runner.start();

    const history = runner.getHistory();
    const toolMsg = history.find((m) => m.role === 'tool' && m.toolCallId === 'tc-5');
    expect(toolMsg?.content).toContain('[stub result for file_read]');
  });

  it('returns denied result when user denies approval', async () => {
    vi.useRealTimers();

    const registry = makeRegistry();
    const invoker = vi.fn().mockResolvedValue({ id: '', output: 'should not run', isError: false } as ToolResult);
    registry.register(
      { name: 'web_search', description: 'search the web', inputSchema: {} },
      invoker,
    );
    const guard = new PermissionGuard(store, []); // nothing auto-allowed

    const provider = mockProvider([[
      makeEvent('tool_call', {
        toolCall: { id: 'tc-6', name: 'web_search', input: { query: 'hack' } },
      }),
      makeEvent('done'),
    ]]);

    const runner = new AgentRunner(
      AGENT_ID,
      makeConfig(),
      provider,
      store,
      undefined,
      undefined,
      registry,
      guard,
    );

    const runPromise = runner.start();

    await new Promise((r) => setTimeout(r, 20));

    const state = store.getState();
    store.resolvePendingApproval(state.pendingApprovals[0]!.id, 'deny');

    await runPromise;

    // invoker must not have been called
    expect(invoker).not.toHaveBeenCalled();

    const history = runner.getHistory();
    const toolMsg = history.find((m) => m.role === 'tool' && m.toolCallId === 'tc-6');
    const result = toolMsg?.toolResults?.[0];
    expect(result?.isError).toBe(true);
    expect(result?.output).toContain('denied');
  });
});
