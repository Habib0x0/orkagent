import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../store.js';
import { AgentRunner } from '../runner.js';
import type { AgentConfig } from '../config.js';
import type { AgentProvider, Message, StreamEvent } from '../providers/types.js';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  type: StreamEvent['type'],
  overrides: Partial<StreamEvent> = {},
): StreamEvent {
  return { type, agentId: 'test', timestamp: Date.now(), ...overrides };
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: 'ollama',
    model: 'llama3',
    max_restarts: 3,
    ...overrides,
  };
}

function makeConfig(agents: Record<string, Partial<AgentConfig>>): Config {
  return {
    version: 1,
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, overrides]) => [
        id,
        makeAgentConfig(overrides),
      ]),
    ),
  };
}

// A provider that captures what messages were sent on the first call.
function capturingProvider(
  captured: { messages: Message[] },
  events: StreamEvent[] = [],
): AgentProvider {
  let firstCall = true;
  return {
    send(msgs: Message[]) {
      if (firstCall) {
        firstCall = false;
        captured.messages = [...msgs];
      }
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    abort: vi.fn(),
  };
}

function simpleProvider(events: StreamEvent[]): AgentProvider {
  return {
    send(_msgs: Message[]) {
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    abort: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Minimal orchestrator that handles context_from injection.
// Mirrors the logic added in orchestrator.ts but is self-contained for tests.
// ---------------------------------------------------------------------------

class TestOrchestrator {
  private runners = new Map<string, AgentRunner>();
  private store: Store;
  private config: Config;
  private factory: (id: string) => AgentProvider;

  constructor(config: Config, store: Store, factory: (id: string) => AgentProvider) {
    this.config = config;
    this.store = store;
    this.factory = factory;
  }

  async start(): Promise<void> {
    // initialize all agents and runners first
    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      const provider = this.factory(agentId);
      const runner = new AgentRunner(agentId, agentConfig, provider, this.store);
      this.runners.set(agentId, runner);
      this.store.initAgent(agentId, agentId);
    }

    const startPromises = Array.from(this.runners.entries()).map(([agentId, runner]) => {
      const agentConfig = this.config.agents[agentId]!;
      const deps = agentConfig.depends_on ?? [];
      const contextSources = agentConfig.context_from ?? [];
      const allPreds = [...new Set([...deps, ...contextSources])];

      const launchRunner = async () => {
        if (contextSources.length > 0) {
          const parts = contextSources.map((srcId) => {
            const entry = this.store.getAgent(srcId);
            return entry ? entry.outputBuffer.join('\n') : '';
          }).filter((s) => s.length > 0);

          if (parts.length > 0) {
            const contextBlock = parts.join('\n\n');
            const history = runner.getHistory();
            const sysIdx = history.findIndex((m) => m.role === 'system');
            if (sysIdx >= 0) {
              history[sysIdx] = {
                ...history[sysIdx]!,
                content: `${history[sysIdx]!.content}\n\n${contextBlock}`,
              };
            } else {
              history.unshift({ role: 'system', content: contextBlock });
            }
          }
        }
        return runner.start();
      };

      if (allPreds.length === 0) {
        return launchRunner();
      }
      return this.waitForDeps(allPreds).then(launchRunner);
    });

    await Promise.all(startPromises);
  }

  private waitForDeps(depIds: string[]): Promise<void> {
    return new Promise((resolve) => {
      const ready = () =>
        depIds.every((id) => {
          const s = this.store.getAgent(id)?.state;
          return s === 'idle' || s === 'done';
        });

      if (ready()) {
        resolve();
        return;
      }

      const check = () => {
        if (ready()) {
          this.store.off('change', check);
          resolve();
        }
      };
      this.store.on('change', check);
    });
  }

  getRunners(): Map<string, AgentRunner> {
    return this.runners;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('context_from system prompt injection', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it('agent-B with context_from: [agent-A] includes agent-A output in its system message', async () => {
    const captured: { messages: Message[] } = { messages: [] };

    const config = makeConfig({
      'agent-a': {},
      'agent-b': { context_from: ['agent-a'] },
    });

    const providers = new Map<string, AgentProvider>([
      [
        'agent-a',
        simpleProvider([
          makeEvent('text', { agentId: 'agent-a', content: 'step 1 complete' }),
          makeEvent('done', { agentId: 'agent-a' }),
        ]),
      ],
      [
        'agent-b',
        capturingProvider(captured, [makeEvent('done', { agentId: 'agent-b' })]),
      ],
    ]);

    const orc = new TestOrchestrator(config, store, (id) => providers.get(id)!);
    await orc.start();

    const systemMsg = captured.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('step 1 complete');
  });

  it('agent without context_from starts normally without waiting', async () => {
    let started = false;

    const config = makeConfig({
      solo: {},
    });

    const providers = new Map<string, AgentProvider>([
      [
        'solo',
        {
          send(_msgs: Message[]) {
            started = true;
            return (async function* () {
              yield makeEvent('done', { agentId: 'solo' });
            })();
          },
          abort: vi.fn(),
        },
      ],
    ]);

    const orc = new TestOrchestrator(config, store, (id) => providers.get(id)!);
    await orc.start();

    expect(started).toBe(true);
    expect(store.getAgent('solo')?.state).toBe('done');
  });

  it('multiple context_from sources are combined into one system message', async () => {
    const captured: { messages: Message[] } = { messages: [] };

    const config = makeConfig({
      src1: {},
      src2: {},
      consumer: { context_from: ['src1', 'src2'] },
    });

    const providers = new Map<string, AgentProvider>([
      [
        'src1',
        simpleProvider([
          makeEvent('text', { agentId: 'src1', content: 'output from source one' }),
          makeEvent('done', { agentId: 'src1' }),
        ]),
      ],
      [
        'src2',
        simpleProvider([
          makeEvent('text', { agentId: 'src2', content: 'output from source two' }),
          makeEvent('done', { agentId: 'src2' }),
        ]),
      ],
      [
        'consumer',
        capturingProvider(captured, [makeEvent('done', { agentId: 'consumer' })]),
      ],
    ]);

    const orc = new TestOrchestrator(config, store, (id) => providers.get(id)!);
    await orc.start();

    const systemMsg = captured.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('output from source one');
    expect(systemMsg!.content).toContain('output from source two');
  });

  it('context_from appended to existing system prompt when agent has its own system field', async () => {
    const captured: { messages: Message[] } = { messages: [] };

    const config = makeConfig({
      producer: {},
      consumer: {
        system: 'You are a helpful assistant.',
        context_from: ['producer'],
      },
    });

    const providers = new Map<string, AgentProvider>([
      [
        'producer',
        simpleProvider([
          makeEvent('text', { agentId: 'producer', content: 'context data here' }),
          makeEvent('done', { agentId: 'producer' }),
        ]),
      ],
      [
        'consumer',
        capturingProvider(captured, [makeEvent('done', { agentId: 'consumer' })]),
      ],
    ]);

    const orc = new TestOrchestrator(config, store, (id) => providers.get(id)!);
    await orc.start();

    const systemMsg = captured.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    // original system prompt preserved
    expect(systemMsg!.content).toContain('You are a helpful assistant.');
    // context appended
    expect(systemMsg!.content).toContain('context data here');
  });
});
