import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../store.js';
import { AgentRunner } from '../runner.js';
import { computeCost } from '../orchestrator.js';
import type { AgentConfig, Config } from '../config.js';
import type { AgentProvider, Message, StreamEvent } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  type: StreamEvent['type'],
  overrides: Partial<StreamEvent> = {},
): StreamEvent {
  return {
    type,
    agentId: 'test',
    timestamp: Date.now(),
    ...overrides,
  };
}

function mockProvider(sequences: StreamEvent[][]): AgentProvider & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
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

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: 'ollama',
    model: 'llama3',
    max_restarts: 3,
    ...overrides,
  };
}

// Minimal orchestrator-like class that wires up cost guardrails the same way
// as the real Orchestrator, but accepts injected providers and runners.
class CostGuardrailOrchestrator {
  private runners = new Map<string, AgentRunner>();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {
    this.store.on('change', () => this.checkCostLimits());
  }

  addRunner(agentId: string, runner: AgentRunner): void {
    this.runners.set(agentId, runner);
  }

  private checkCostLimits(): void {
    let sessionTotal = 0;

    for (const [agentId, entry] of Object.entries(this.store.getAllAgents())) {
      const agentConfig = this.config.agents[agentId];
      if (!agentConfig) continue;

      const cost = computeCost(
        agentConfig.provider,
        agentConfig.model,
        entry.tokens.input,
        entry.tokens.output,
      );
      entry.cost = cost;
      sessionTotal += cost;

      if (agentConfig.max_cost !== undefined && cost > agentConfig.max_cost) {
        const runner = this.runners.get(agentId);
        if (runner && entry.state !== 'paused' && entry.state !== 'done') {
          runner.pause();
        }
      }
    }

    const sessionMaxCost = this.config.session?.max_cost;
    if (sessionMaxCost !== undefined && sessionTotal > sessionMaxCost) {
      for (const [agentId, runner] of this.runners.entries()) {
        const entry = this.store.getAgent(agentId);
        if (entry && entry.state !== 'paused' && entry.state !== 'done') {
          runner.pause();
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests: computeCost correctness
// ---------------------------------------------------------------------------

describe('cost calculation', () => {
  it('returns zero for ollama (local model)', () => {
    expect(computeCost('ollama', 'llama3', 100_000, 50_000)).toBe(0);
  });

  it('calculates per-token cost for a known model', () => {
    // gpt-4o-mini: $0.15/M input, $0.60/M output
    const cost = computeCost('openai', 'gpt-4o-mini', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.75, 5);
  });

  it('scales linearly with token count', () => {
    const half = computeCost('openai', 'gpt-4o', 500_000, 0);
    const full = computeCost('openai', 'gpt-4o', 1_000_000, 0);
    expect(full).toBeCloseTo(half * 2, 10);
  });

  it('sums input and output costs correctly', () => {
    // claude-3-haiku: $0.25/M input, $1.25/M output
    const cost = computeCost('anthropic', 'claude-3-haiku', 2_000_000, 1_000_000);
    // 0.25 * 2 + 1.25 * 1 = 1.75
    expect(cost).toBeCloseTo(1.75, 5);
  });

  it('uses fallback pricing for unknown model', () => {
    // fallback: $3/M input, $15/M output
    const cost = computeCost('anthropic', 'claude-unknown-xyz', 1_000_000, 0);
    expect(cost).toBeCloseTo(3, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: agent-level max_cost guardrail
// ---------------------------------------------------------------------------

describe('agent max_cost guardrail', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it('pauses agent when cost exceeds max_cost', async () => {
    const agentId = 'expensive-agent';
    // gpt-4o: $5/M input, $15/M output -- 1M input tokens = $5
    const config: Config = {
      version: 1,
      agents: {
        [agentId]: makeAgentConfig({
          provider: 'openai',
          model: 'gpt-4o',
          max_cost: 1.0, // $1 limit -- 1M input tokens will cost $5, exceeding this
        }),
      },
    };

    store.initAgent(agentId, agentId);
    const provider = mockProvider([[makeEvent('done', { usage: { inputTokens: 1_000_000, outputTokens: 0 } })]]);
    const agentConfig = config.agents[agentId]!;
    const runner = new AgentRunner(agentId, agentConfig, provider, store);

    const orc = new CostGuardrailOrchestrator(config, store);
    orc.addRunner(agentId, runner);

    await runner.start();

    // flush the batched store change event
    vi.advanceTimersByTime(100);

    expect(store.getAgent(agentId)?.state).toBe('paused');
  });

  it('does not pause agent when cost is within max_cost', async () => {
    const agentId = 'cheap-agent';
    // ollama is free, so cost will always be 0
    const config: Config = {
      version: 1,
      agents: {
        [agentId]: makeAgentConfig({
          provider: 'ollama',
          model: 'llama3',
          max_cost: 1.0,
        }),
      },
    };

    store.initAgent(agentId, agentId);
    const provider = mockProvider([[makeEvent('done', { usage: { inputTokens: 999_999, outputTokens: 0 } })]]);
    const agentConfig = config.agents[agentId]!;
    const runner = new AgentRunner(agentId, agentConfig, provider, store);

    const orc = new CostGuardrailOrchestrator(config, store);
    orc.addRunner(agentId, runner);

    await runner.start();
    vi.advanceTimersByTime(100);

    // ollama cost is 0 -- should remain idle, not paused
    expect(store.getAgent(agentId)?.state).toBe('idle');
  });

  it('does not pause agent when no max_cost is configured', async () => {
    const agentId = 'uncapped-agent';
    const config: Config = {
      version: 1,
      agents: {
        [agentId]: makeAgentConfig({
          provider: 'openai',
          model: 'gpt-4o',
          // no max_cost
        }),
      },
    };

    store.initAgent(agentId, agentId);
    const provider = mockProvider([[makeEvent('done', { usage: { inputTokens: 10_000_000, outputTokens: 0 } })]]);
    const agentConfig = config.agents[agentId]!;
    const runner = new AgentRunner(agentId, agentConfig, provider, store);

    const orc = new CostGuardrailOrchestrator(config, store);
    orc.addRunner(agentId, runner);

    await runner.start();
    vi.advanceTimersByTime(100);

    expect(store.getAgent(agentId)?.state).toBe('idle');
  });

  it('sets agent state to paused (not done or error)', async () => {
    const agentId = 'guarded-agent';
    const config: Config = {
      version: 1,
      agents: {
        [agentId]: makeAgentConfig({
          provider: 'openai',
          model: 'gpt-4o',
          max_cost: 0.001, // very low threshold
        }),
      },
    };

    store.initAgent(agentId, agentId);
    // 100k input tokens at gpt-4o rates = $0.50 >> $0.001 limit
    const provider = mockProvider([[makeEvent('done', { usage: { inputTokens: 100_000, outputTokens: 0 } })]]);
    const agentConfig = config.agents[agentId]!;
    const runner = new AgentRunner(agentId, agentConfig, provider, store);

    const orc = new CostGuardrailOrchestrator(config, store);
    orc.addRunner(agentId, runner);

    await runner.start();
    vi.advanceTimersByTime(100);

    const state = store.getAgent(agentId)?.state;
    expect(state).toBe('paused');
    expect(state).not.toBe('done');
    expect(state).not.toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Tests: session-wide max_cost guardrail
// ---------------------------------------------------------------------------

describe('session max_cost guardrail', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it('pauses all agents when session max_cost is exceeded', async () => {
    // two cheap agents -- each costs a bit, together they exceed the session limit
    // Use gpt-4o-mini: $0.15/M input, $0.60/M output
    // 500k input tokens each = $0.075 each = $0.15 total
    // session limit = $0.10 -- together they exceed it
    const config: Config = {
      version: 1,
      agents: {
        alpha: makeAgentConfig({ provider: 'openai', model: 'gpt-4o-mini' }),
        beta: makeAgentConfig({ provider: 'openai', model: 'gpt-4o-mini' }),
      },
      session: { max_cost: 0.10 },
    };

    store.initAgent('alpha', 'alpha');
    store.initAgent('beta', 'beta');

    const orc = new CostGuardrailOrchestrator(config, store);

    const providerAlpha = mockProvider([[makeEvent('done', { usage: { inputTokens: 500_000, outputTokens: 0 } })]]);
    const providerBeta = mockProvider([[makeEvent('done', { usage: { inputTokens: 500_000, outputTokens: 0 } })]]);

    const runnerAlpha = new AgentRunner('alpha', config.agents['alpha']!, providerAlpha, store);
    const runnerBeta = new AgentRunner('beta', config.agents['beta']!, providerBeta, store);

    orc.addRunner('alpha', runnerAlpha);
    orc.addRunner('beta', runnerBeta);

    await runnerAlpha.start();
    await runnerBeta.start();

    vi.advanceTimersByTime(100);

    // both agents should be paused due to session limit
    expect(store.getAgent('alpha')?.state).toBe('paused');
    expect(store.getAgent('beta')?.state).toBe('paused');
  });

  it('does not pause agents when session cost is within session max_cost', async () => {
    // ollama is free -- session cost stays 0
    const config: Config = {
      version: 1,
      agents: {
        alpha: makeAgentConfig({ provider: 'ollama', model: 'llama3' }),
        beta: makeAgentConfig({ provider: 'ollama', model: 'llama3' }),
      },
      session: { max_cost: 100.0 },
    };

    store.initAgent('alpha', 'alpha');
    store.initAgent('beta', 'beta');

    const orc = new CostGuardrailOrchestrator(config, store);

    const providerAlpha = mockProvider([[makeEvent('done', { usage: { inputTokens: 100_000, outputTokens: 0 } })]]);
    const providerBeta = mockProvider([[makeEvent('done', { usage: { inputTokens: 100_000, outputTokens: 0 } })]]);

    const runnerAlpha = new AgentRunner('alpha', config.agents['alpha']!, providerAlpha, store);
    const runnerBeta = new AgentRunner('beta', config.agents['beta']!, providerBeta, store);

    orc.addRunner('alpha', runnerAlpha);
    orc.addRunner('beta', runnerBeta);

    await runnerAlpha.start();
    await runnerBeta.start();

    vi.advanceTimersByTime(100);

    expect(store.getAgent('alpha')?.state).toBe('idle');
    expect(store.getAgent('beta')?.state).toBe('idle');
  });

  it('session guardrail is not applied when session.max_cost is not configured', async () => {
    const config: Config = {
      version: 1,
      agents: {
        alpha: makeAgentConfig({ provider: 'openai', model: 'gpt-4o' }),
      },
      // no session block
    };

    store.initAgent('alpha', 'alpha');

    const orc = new CostGuardrailOrchestrator(config, store);

    // 10M tokens at gpt-4o rates = $50 -- would exceed any reasonable session limit
    const provider = mockProvider([[makeEvent('done', { usage: { inputTokens: 10_000_000, outputTokens: 0 } })]]);
    const runner = new AgentRunner('alpha', config.agents['alpha']!, provider, store);
    orc.addRunner('alpha', runner);

    await runner.start();
    vi.advanceTimersByTime(100);

    expect(store.getAgent('alpha')?.state).toBe('idle');
  });

  it('session cost is the sum of all agent costs', async () => {
    // verify the math: two agents each consuming tokens
    // gpt-4o-mini: $0.15/M input
    // agent A: 1M input = $0.15
    // agent B: 2M input = $0.30
    // total = $0.45 -- exceeds $0.40 session limit
    const config: Config = {
      version: 1,
      agents: {
        agentA: makeAgentConfig({ provider: 'openai', model: 'gpt-4o-mini' }),
        agentB: makeAgentConfig({ provider: 'openai', model: 'gpt-4o-mini' }),
      },
      session: { max_cost: 0.40 },
    };

    store.initAgent('agentA', 'agentA');
    store.initAgent('agentB', 'agentB');

    const orc = new CostGuardrailOrchestrator(config, store);

    const providerA = mockProvider([[makeEvent('done', { usage: { inputTokens: 1_000_000, outputTokens: 0 } })]]);
    const providerB = mockProvider([[makeEvent('done', { usage: { inputTokens: 2_000_000, outputTokens: 0 } })]]);

    const runnerA = new AgentRunner('agentA', config.agents['agentA']!, providerA, store);
    const runnerB = new AgentRunner('agentB', config.agents['agentB']!, providerB, store);

    orc.addRunner('agentA', runnerA);
    orc.addRunner('agentB', runnerB);

    await runnerA.start();
    await runnerB.start();

    vi.advanceTimersByTime(100);

    // combined cost exceeds $0.40 -- both should be paused
    const stateA = store.getAgent('agentA')?.state;
    const stateB = store.getAgent('agentB')?.state;
    expect(stateA).toBe('paused');
    expect(stateB).toBe('paused');
  });
});
