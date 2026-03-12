import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookRegistry } from '../hooks.js';
import { AgentRunner } from '../runner.js';
import { Store } from '../store.js';
import type { AgentConfig } from '../config.js';
import type { AgentProvider, Message, StreamEvent } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers shared across tests
// ---------------------------------------------------------------------------

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
  return { type, agentId: 'test-agent', timestamp: Date.now(), ...overrides };
}

function mockProvider(sequences: StreamEvent[][]): AgentProvider & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    send(_msgs: Message[]) {
      const events = sequences[callCount] ?? [];
      callCount++;
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    abort: vi.fn(),
  };
}

const AGENT_ID = 'agent-hooks';

// ---------------------------------------------------------------------------
// HookRegistry unit tests
// ---------------------------------------------------------------------------

describe('HookRegistry', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('calls a registered handler with correct args', async () => {
    const fn = vi.fn();
    registry.register('onAgentDone', fn);
    await registry.invoke('onAgentDone', 'my-agent');
    expect(fn).toHaveBeenCalledWith('my-agent');
  });

  it('calls multiple handlers in registration order', async () => {
    const order: number[] = [];
    registry.register('onAgentDone', () => { order.push(1); });
    registry.register('onAgentDone', () => { order.push(2); });
    registry.register('onAgentDone', () => { order.push(3); });
    await registry.invoke('onAgentDone', 'a');
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not throw when no handlers are registered', async () => {
    await expect(registry.invoke('onAgentDone', 'x')).resolves.toBeUndefined();
  });

  it('catches handler exceptions and continues calling remaining handlers', async () => {
    const second = vi.fn();
    registry.register('onAgentDone', () => { throw new Error('boom'); });
    registry.register('onAgentDone', second);
    await expect(registry.invoke('onAgentDone', 'a')).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledOnce();
  });

  it('awaits async handlers', async () => {
    let resolved = false;
    registry.register('onAgentDone', async () => {
      await new Promise((r) => setTimeout(r, 0));
      resolved = true;
    });
    await registry.invoke('onAgentDone', 'a');
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: hooks fire during agent lifecycle
// ---------------------------------------------------------------------------

describe('AgentRunner lifecycle hooks', () => {
  let store: Store;
  let hooks: HookRegistry;

  beforeEach(() => {
    vi.useRealTimers();
    store = new Store();
    store.initAgent(AGENT_ID, 'tester');
    hooks = new HookRegistry();
  });

  afterEach(() => {
    store.destroy();
  });

  it('fires onAgentStart when runner.start() begins', async () => {
    const fn = vi.fn();
    hooks.register('onAgentStart', fn);

    const provider = mockProvider([[makeEvent('done')]]);
    const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store, hooks);
    await runner.start();

    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({ model: 'claude-3' }));
  });

  it('fires onMessage for each text event', async () => {
    const fn = vi.fn();
    hooks.register('onMessage', fn);

    const provider = mockProvider([[
      makeEvent('text', { content: 'hello' }),
      makeEvent('text', { content: ' world' }),
      makeEvent('done'),
    ]]);
    const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store, hooks);
    await runner.start();

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0]).toEqual([AGENT_ID, expect.objectContaining({ role: 'assistant', content: 'hello' })]);
    expect(fn.mock.calls[1]).toEqual([AGENT_ID, expect.objectContaining({ role: 'assistant', content: ' world' })]);
  });

  it('fires onToolCall for each tool_call event', async () => {
    const fn = vi.fn();
    hooks.register('onToolCall', fn);

    const tc = { id: 'tc-1', name: 'file_read', input: { path: '/tmp/x' } };
    const provider = mockProvider([[
      makeEvent('tool_call', { toolCall: tc }),
      makeEvent('done'),
    ]]);
    const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store, hooks);
    await runner.start();

    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(AGENT_ID, tc);
  });

  it('fires onError for error events', async () => {
    const fn = vi.fn();
    hooks.register('onError', fn);

    const errPayload = { code: 'auth_error', message: 'invalid key', retryable: false };
    const provider = mockProvider([[makeEvent('error', { error: errPayload })]]);
    const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store, hooks);
    await runner.start();

    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(AGENT_ID, errPayload);
  });

  it('fires onAgentDone when done event is received', async () => {
    const fn = vi.fn();
    hooks.register('onAgentDone', fn);

    const provider = mockProvider([[makeEvent('done')]]);
    const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store, hooks);
    await runner.start();

    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(AGENT_ID);
  });

  it('fires hooks in order: onAgentStart -> onMessage -> onToolCall -> onAgentDone', async () => {
    const order: string[] = [];
    hooks.register('onAgentStart', () => { order.push('start'); });
    hooks.register('onMessage', () => { order.push('message'); });
    hooks.register('onToolCall', () => { order.push('tool'); });
    hooks.register('onAgentDone', () => { order.push('done'); });

    const tc = { id: 'tc-2', name: 'shell', input: {} };
    const provider = mockProvider([[
      makeEvent('text', { content: 'hi' }),
      makeEvent('tool_call', { toolCall: tc }),
      makeEvent('done'),
    ]]);
    const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store, hooks);
    await runner.start();

    expect(order).toEqual(['start', 'message', 'tool', 'done']);
  });

  it('exception in a hook handler does not crash the runner', async () => {
    hooks.register('onMessage', () => { throw new Error('hook explodes'); });
    hooks.register('onAgentDone', () => { throw new Error('done explodes'); });

    const provider = mockProvider([[
      makeEvent('text', { content: 'hi' }),
      makeEvent('done'),
    ]]);
    const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store, hooks);

    // must not throw, and state must still settle
    await expect(runner.start()).resolves.toBeUndefined();
    expect(store.getAgent(AGENT_ID)?.state).toBe('idle');
  });

  it('multiple handlers for the same hook are called in registration order', async () => {
    const log: string[] = [];
    hooks.register('onAgentStart', () => { log.push('A'); });
    hooks.register('onAgentStart', () => { log.push('B'); });
    hooks.register('onAgentStart', () => { log.push('C'); });

    const provider = mockProvider([[makeEvent('done')]]);
    const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store, hooks);
    await runner.start();

    expect(log).toEqual(['A', 'B', 'C']);
  });
});
