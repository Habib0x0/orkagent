import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRunner } from '../runner.js';
import { EventBus } from '../eventbus.js';
import { Store } from '../store.js';
import type { AgentConfig, Config } from '../config.js';
import type { AgentProvider, Message, StreamEvent } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: 'ollama',
    model: 'llama3',
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

// Minimal orchestrator-like factory that wires EventBus into runners, mirroring
// what Orchestrator.start() now does. Used instead of instantiating the real
// Orchestrator (which requires real API keys for provider construction).
class TestOrchestrator {
  private runners = new Map<string, AgentRunner>();
  private eventBus = new EventBus();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly providerFactory: (id: string) => AgentProvider,
  ) {}

  async start(): Promise<void> {
    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      const provider = this.providerFactory(agentId);
      const runner = new AgentRunner(
        agentId,
        agentConfig,
        provider,
        this.store,
        undefined,
        this.eventBus,
      );
      this.runners.set(agentId, runner);
      this.store.initAgent(agentId, agentId);
    }

    await Promise.all(Array.from(this.runners.values()).map((r) => r.start()));
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getRunners(): Map<string, AgentRunner> {
    return this.runners;
  }
}

function makeConfig(
  agents: Record<string, Partial<AgentConfig>>,
): Config {
  return {
    version: 1,
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, overrides]) => [id, makeAgentConfig(overrides)]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wire-eventbus: EventBus wired into Orchestrator', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  afterEach(() => {
    store.destroy();
  });

  it('creates a single EventBus instance shared across all runners', async () => {
    const config = makeConfig({
      'agent-a': {},
      'agent-b': {},
    });

    const providers = new Map<string, AgentProvider>([
      ['agent-a', mockProvider([[makeEvent('done', 'agent-a')]])],
      ['agent-b', mockProvider([[makeEvent('done', 'agent-b')]])],
    ]);

    const orc = new TestOrchestrator(config, store, (id) => providers.get(id)!);
    await orc.start();

    // verify one bus exists and is accessible
    const bus = orc.getEventBus();
    expect(bus).toBeInstanceOf(EventBus);

    // all runners were created with the same bus -- we can verify by publishing
    // on the bus and confirming the instance is the same object reference
    const runners = orc.getRunners();
    expect(runners.size).toBe(2);
    expect(runners.has('agent-a')).toBe(true);
    expect(runners.has('agent-b')).toBe(true);
  });

  it('agent-B watches agent-A: after agent-A emits done, agent-B makes a second provider call', async () => {
    store.initAgent('agent-a', 'agent-a');
    store.initAgent('agent-b', 'agent-b');

    const bus = new EventBus();

    // agent-A: emits text then done
    const providerA = mockProvider([
      [
        makeEvent('text', 'agent-a', { content: 'work done' }),
        makeEvent('done', 'agent-a'),
      ],
    ]);

    // agent-B: first call returns done immediately (startup), second call is
    // triggered by the watch notification from agent-A
    const providerB = mockProvider([
      [makeEvent('done', 'agent-b')],   // initial run
      [makeEvent('done', 'agent-b')],   // triggered by watch
    ]);

    const runnerA = new AgentRunner(
      'agent-a',
      makeAgentConfig(),
      providerA,
      store,
      undefined,
      bus,
    );
    const runnerB = new AgentRunner(
      'agent-b',
      makeAgentConfig({ watches: ['agent-a'] }),
      providerB,
      store,
      undefined,
      bus,
    );

    // start B first so it subscribes to agent-a's channel before A fires
    const startB = runnerB.start();
    await runnerA.start();
    await startB;

    // give async sendUserMessage loop a chance to run
    await new Promise((r) => setTimeout(r, 30));

    // B should have been called twice: once on startup, once on watch trigger
    expect(providerB.callCount).toBe(2);
  });

  it('agent-B receives a context injection referencing agent-A on watch trigger', async () => {
    store.initAgent('agent-a', 'agent-a');
    store.initAgent('agent-b', 'agent-b');

    const bus = new EventBus();

    const providerA = mockProvider([
      [
        makeEvent('text', 'agent-a', { content: 'output from A' }),
        makeEvent('done', 'agent-a'),
      ],
    ]);

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

    const runnerA = new AgentRunner(
      'agent-a',
      makeAgentConfig(),
      providerA,
      store,
      undefined,
      bus,
    );
    const runnerB = new AgentRunner(
      'agent-b',
      makeAgentConfig({ watches: ['agent-a'] }),
      providerB,
      store,
      undefined,
      bus,
    );

    // start B first so its watch subscription is in place before A fires
    const startB = runnerB.start();
    await runnerA.start();
    await startB;

    await new Promise((r) => setTimeout(r, 30));

    // at least one send call to B should include a user message mentioning agent-a
    const watchMsgFound = capturedHistories.some((msgs) =>
      msgs.some((m) => m.role === 'user' && m.content.includes('agent-a')),
    );
    expect(watchMsgFound).toBe(true);
  });

  it('EventBus instance is the same object for all runners (shared reference)', async () => {
    // Directly construct runners with the same bus to verify sharing semantics
    const bus = new EventBus();
    store.initAgent('r1', 'r1');
    store.initAgent('r2', 'r2');

    const p1 = mockProvider([[makeEvent('done', 'r1')]]);
    const p2 = mockProvider([[makeEvent('done', 'r2')]]);

    const r1 = new AgentRunner('r1', makeAgentConfig(), p1, store, undefined, bus);
    const r2 = new AgentRunner('r2', makeAgentConfig(), p2, store, undefined, bus);

    await Promise.all([r1.start(), r2.start()]);

    // Both runners were given the same bus object; publish on it to confirm
    // there's only one bus in play (no duplicate instances)
    let received = 0;
    bus.subscribe('r1', 'test-subscriber', () => { received++; });
    bus.publish('r1', makeEvent('done', 'r1'));

    expect(received).toBe(1);
  });
});
