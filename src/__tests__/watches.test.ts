import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRunner } from '../runner.js';
import { EventBus } from '../eventbus.js';
import { Store } from '../store.js';
import type { AgentConfig } from '../config.js';
import type { AgentProvider, Message, StreamEvent } from '../providers/types.js';

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
  agentId = 'test',
  overrides: Partial<StreamEvent> = {},
): StreamEvent {
  return { type, agentId, timestamp: Date.now(), ...overrides };
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

describe('watches pub/sub wiring', () => {
  let store: Store;
  let bus: EventBus;

  beforeEach(() => {
    store = new Store();
    store.initAgent('agent-a', 'Agent A');
    store.initAgent('agent-b', 'Agent B');
    bus = new EventBus();
  });

  afterEach(() => {
    store.destroy();
  });

  it('agent-B receives a user message when agent-A emits done', async () => {
    // agent-A: plain runner with no watches, uses eventBus
    const providerA = mockProvider([[
      makeEvent('text', 'agent-a', { content: 'hello from A' }),
      makeEvent('done', 'agent-a'),
    ]]);
    const runnerA = new AgentRunner(
      'agent-a',
      makeConfig(),
      providerA,
      store,
      undefined,
      bus,
    );

    // agent-B watches agent-a; its provider yields done immediately
    const capturedHistories: Message[][] = [];
    const providerB: AgentProvider = {
      send(msgs: Message[]) {
        capturedHistories.push([...msgs]);
        return (async function* () {
          yield makeEvent('done', 'agent-b');
        })();
      },
      abort: vi.fn(),
    };
    const runnerB = new AgentRunner(
      'agent-b',
      makeConfig({ watches: ['agent-a'] }),
      providerB,
      store,
      undefined,
      bus,
    );

    // start B first so it's subscribed before A fires
    const startB = runnerB.start();
    await runnerA.start();
    await startB;

    // give the async sendUserMessage loop a chance to run
    await new Promise((r) => setTimeout(r, 20));

    // B should have been called at least once after watching A's done event
    expect(capturedHistories.length).toBeGreaterThanOrEqual(1);
    // at least one of B's send calls should include a user message referencing agent-a
    const hasWatchMsg = capturedHistories.some((msgs) =>
      msgs.some((m) => m.role === 'user' && m.content.includes('agent-a')),
    );
    expect(hasWatchMsg).toBe(true);
  });

  it('unsubscribing on abort prevents further messages from arriving', async () => {
    const receivedMessages: string[] = [];
    const providerB: AgentProvider = {
      send(msgs: Message[]) {
        for (const m of msgs) {
          if (m.role === 'user') receivedMessages.push(m.content);
        }
        return (async function* () {
          yield makeEvent('done', 'agent-b');
        })();
      },
      abort: vi.fn(),
    };

    const runnerB = new AgentRunner(
      'agent-b',
      makeConfig({ watches: ['agent-a'] }),
      providerB,
      store,
      undefined,
      bus,
    );

    // start B, then immediately abort -- subscriptions should be cleaned up
    runnerB.start().catch(() => {});
    runnerB.abort();

    // now publish on agent-a's channel -- B should not react
    bus.publish('agent-a', makeEvent('done', 'agent-a'));

    // allow any async ticks to settle
    await new Promise((r) => setTimeout(r, 20));

    // no user messages from watches should have been injected after abort
    expect(receivedMessages.filter((m) => m.includes('agent-a'))).toHaveLength(0);
  });

  it('publishing to event bus when no subscribers is a no-op', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(() => {
      bus.publish('agent-a', makeEvent('done', 'agent-a'));
    }).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
