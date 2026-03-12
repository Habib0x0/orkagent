import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, ConfigValidationError } from '../config.js';
import { EventBus } from '../eventbus.js';
import { Store } from '../store.js';
import { AgentRunner } from '../runner.js';
import type { AgentConfig, Config } from '../config.js';
import type { AgentProvider, Message, StreamEvent } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpYaml(content: string): string {
  const p = join(tmpdir(), `phase2-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(p, content);
  return p;
}

function cleanup(paths: string[]) {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* gone */ }
  }
}

function makeEvent(
  type: StreamEvent['type'],
  agentId = 'test',
  overrides: Partial<StreamEvent> = {},
): StreamEvent {
  return { type, agentId, timestamp: Date.now(), ...overrides };
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
      Object.entries(agents).map(([id, overrides]) => [id, makeAgentConfig(overrides)]),
    ),
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

// Captures the messages passed to the first send() call
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

// Minimal orchestrator that wires context_from injection, mirroring orchestrator.ts
class TestOrchestrator {
  private runners = new Map<string, AgentRunner>();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly factory: (id: string) => AgentProvider,
  ) {}

  async start(): Promise<void> {
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

      if (allPreds.length === 0) return launchRunner();
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
      if (ready()) { resolve(); return; }
      const check = () => {
        if (ready()) { this.store.off('change', check); resolve(); }
      };
      this.store.on('change', check);
    });
  }
}

// ---------------------------------------------------------------------------
// Additional cycle detection graph shapes
// ---------------------------------------------------------------------------

describe('dependency graph -- additional cycle shapes', () => {
  const tmp: string[] = [];

  afterEach(() => {
    cleanup(tmp);
    tmp.length = 0;
  });

  it('rejects a four-node cycle A->B->C->D->A', () => {
    const p = makeTmpYaml(`
version: 1
agents:
  a:
    provider: ollama
    model: llama3
    depends_on: [b]
  b:
    provider: ollama
    model: llama3
    depends_on: [c]
  c:
    provider: ollama
    model: llama3
    depends_on: [d]
  d:
    provider: ollama
    model: llama3
    depends_on: [a]
`);
    tmp.push(p);
    expect(() => loadConfig(p)).toThrow(ConfigValidationError);
    let err: ConfigValidationError | null = null;
    try { loadConfig(p); } catch (e) { err = e as ConfigValidationError; }
    // at least one node from the cycle should appear in the error
    expect(err!.message).toMatch(/a|b|c|d/);
  });

  it('rejects a cycle with a non-participating node (E standalone, A->B->C->A)', () => {
    const p = makeTmpYaml(`
version: 1
agents:
  a:
    provider: ollama
    model: llama3
    depends_on: [b]
  b:
    provider: ollama
    model: llama3
    depends_on: [c]
  c:
    provider: ollama
    model: llama3
    depends_on: [a]
  e:
    provider: ollama
    model: llama3
`);
    tmp.push(p);
    expect(() => loadConfig(p)).toThrow(ConfigValidationError);
    let err: ConfigValidationError | null = null;
    try { loadConfig(p); } catch (e) { err = e as ConfigValidationError; }
    expect(err!.message).toMatch(/a|b|c/);
    // standalone agent e should not appear in the cycle issues
    // path format is "agents.<name>.depends_on" -- check for the exact agent segment
    const cycleAgents = err!.issues.map((i) => i.path);
    expect(cycleAgents.some((p) => /agents\.e\./.test(p))).toBe(false);
  });

  it('rejects a cycle where one node has multiple dependencies (C->A, C->B, B->C)', () => {
    // B->C creates the cycle; C also depends on A which is a DAG root
    const p = makeTmpYaml(`
version: 1
agents:
  a:
    provider: ollama
    model: llama3
  b:
    provider: ollama
    model: llama3
    depends_on: [c]
  c:
    provider: ollama
    model: llama3
    depends_on: [a, b]
`);
    tmp.push(p);
    expect(() => loadConfig(p)).toThrow(ConfigValidationError);
    let err: ConfigValidationError | null = null;
    try { loadConfig(p); } catch (e) { err = e as ConfigValidationError; }
    expect(err!.message).toMatch(/b|c/);
  });

  it('accepts a wide fan-in (E depends on A, B, C, D -- all roots)', () => {
    const p = makeTmpYaml(`
version: 1
agents:
  a:
    provider: ollama
    model: llama3
  b:
    provider: ollama
    model: llama3
  c:
    provider: ollama
    model: llama3
  d:
    provider: ollama
    model: llama3
  e:
    provider: ollama
    model: llama3
    depends_on: [a, b, c, d]
`);
    tmp.push(p);
    expect(() => loadConfig(p)).not.toThrow();
  });

  it('accepts a two-level chain where roots are shared (A->C, B->C, C->D)', () => {
    const p = makeTmpYaml(`
version: 1
agents:
  a:
    provider: ollama
    model: llama3
    depends_on: [c]
  b:
    provider: ollama
    model: llama3
    depends_on: [c]
  c:
    provider: ollama
    model: llama3
    depends_on: [d]
  d:
    provider: ollama
    model: llama3
`);
    tmp.push(p);
    expect(() => loadConfig(p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Event delivery timing
// ---------------------------------------------------------------------------

describe('EventBus event delivery timing', () => {
  it('delivers events within 150ms of publish', async () => {
    const bus = new EventBus();
    const received: number[] = [];

    bus.subscribe('text', 'agent-1', () => {
      received.push(Date.now());
    });

    const before = Date.now();
    bus.publish('text', makeEvent('text', 'agent-1', { content: 'hi' }));

    // give any async plumbing a chance to run
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    const elapsed = received[0]! - before;
    expect(elapsed).toBeLessThan(150);
  });

  it('delivers burst of events -- each within 150ms', async () => {
    const bus = new EventBus();
    const publishTimes: number[] = [];
    const receiveTimes: number[] = [];

    bus.subscribe('text', 'agent-burst', () => {
      receiveTimes.push(Date.now());
    });

    for (let i = 0; i < 5; i++) {
      publishTimes.push(Date.now());
      bus.publish('text', makeEvent('text', 'agent-burst', { content: `msg-${i}` }));
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(receiveTimes).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(receiveTimes[i]! - publishTimes[i]!).toBeLessThan(150);
    }
  });
});

// ---------------------------------------------------------------------------
// Agent publishes to bus but subscriber is already done
// ---------------------------------------------------------------------------

describe('EventBus -- late publish after subscriber is done', () => {
  let store: Store;
  let bus: EventBus;

  beforeEach(() => {
    store = new Store();
    bus = new EventBus();
  });

  afterEach(() => {
    store.destroy();
  });

  it('does not invoke handler after agent has unsubscribed via abort', async () => {
    store.initAgent('watcher', 'watcher');
    store.initAgent('source', 'source');

    const calls: string[] = [];
    const providerWatcher: AgentProvider = {
      send(_msgs: Message[]) {
        return (async function* () {
          yield makeEvent('done', 'watcher');
        })();
      },
      abort: vi.fn(),
    };

    const runner = new AgentRunner(
      'watcher',
      makeAgentConfig({ watches: ['source'] }),
      providerWatcher,
      store,
      undefined,
      bus,
    );

    // subscribe a manual handler so we can track if it fires
    bus.subscribe('source', 'manual-check', () => { calls.push('fired'); });

    await runner.start();
    // abort the runner -- this should call cleanupWatches internally
    runner.abort();

    // now publish on source -- the runner's watch handler should not fire
    bus.publish('source', makeEvent('done', 'source'));

    await new Promise((r) => setTimeout(r, 20));

    // the manual subscriber still fires (verifying publish works), but the
    // runner's internal watch handler was unsubscribed on abort
    expect(calls).toHaveLength(1); // manual subscriber received it
    // store state should reflect done from abort, not a second reaction
    expect(store.getAgent('watcher')?.state).toBe('done');
  });

  it('publish after unsubscribeAll does not deliver to removed subscriber', async () => {
    const bus2 = new EventBus();
    const received: StreamEvent[] = [];

    bus2.subscribe('topic', 'agent-x', (ev) => { received.push(ev); });
    bus2.unsubscribeAll('agent-x');

    // publish after unsubscribe -- handler must not fire
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    bus2.publish('topic', makeEvent('text', 'agent-x'));
    spy.mockRestore();

    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// context_from with empty output from source agent
// ---------------------------------------------------------------------------

describe('context_from -- empty output from source agent', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  afterEach(() => {
    store.destroy();
  });

  it('consumer runs normally when source agent produced no output', async () => {
    const captured: { messages: Message[] } = { messages: [] };

    const config = makeConfig({
      src: {},
      consumer: { context_from: ['src'] },
    });

    const providers = new Map<string, AgentProvider>([
      // source emits done but no text -- empty outputBuffer
      ['src', simpleProvider([makeEvent('done', 'src')])],
      ['consumer', capturingProvider(captured, [makeEvent('done', 'consumer')])],
    ]);

    const orc = new TestOrchestrator(config, store, (id) => providers.get(id)!);
    await orc.start();

    // consumer should have run
    expect(store.getAgent('consumer')?.state).toBe('idle');
    // no system message injected (nothing to inject from empty source)
    const systemMsg = captured.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeUndefined();
  });

  it('consumer with its own system prompt keeps it intact when source output is empty', async () => {
    const captured: { messages: Message[] } = { messages: [] };

    const config = makeConfig({
      emptySrc: {},
      consumer: {
        system: 'Original system prompt.',
        context_from: ['emptySrc'],
      },
    });

    const providers = new Map<string, AgentProvider>([
      ['emptySrc', simpleProvider([makeEvent('done', 'emptySrc')])],
      ['consumer', capturingProvider(captured, [makeEvent('done', 'consumer')])],
    ]);

    const orc = new TestOrchestrator(config, store, (id) => providers.get(id)!);
    await orc.start();

    const systemMsg = captured.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    // original system prompt should be preserved, not modified
    expect(systemMsg!.content).toBe('Original system prompt.');
  });
});
