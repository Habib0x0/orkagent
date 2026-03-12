import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, ConfigValidationError } from '../config.js';
import { Store } from '../store.js';
import { AgentRunner } from '../runner.js';
import type { AgentProvider, Message, StreamEvent } from '../providers/types.js';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpYaml(content: string): string {
  const p = join(tmpdir(), `depgraph-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(p, content);
  return p;
}

function cleanup(paths: string[]) {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* gone */ }
  }
}

function ollamaAgent(extra = '') {
  return `provider: ollama\n    model: llama3\n${extra}`;
}

function makeEvent(
  type: StreamEvent['type'],
  overrides: Partial<StreamEvent> = {},
): StreamEvent {
  return { type, agentId: 'test', timestamp: Date.now(), ...overrides };
}

function mockProvider(events: StreamEvent[]): AgentProvider {
  return {
    send(_msgs: Message[]) {
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    abort: vi.fn(),
  };
}

// Minimal Config builder for orchestrator sequencing tests
function makeConfig(
  agents: Record<string, { deps?: string[] }>,
): Config {
  return {
    version: 1,
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, { deps }]) => [
        id,
        {
          provider: 'ollama' as const,
          model: 'llama3',
          max_restarts: 3,
          ...(deps ? { depends_on: deps } : {}),
        },
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Cycle detection -- config.ts
// ---------------------------------------------------------------------------

describe('dependency graph validation (config.ts)', () => {
  const tmp: string[] = [];

  afterEach(() => {
    cleanup(tmp);
    tmp.length = 0;
  });

  it('rejects A->B->C->A cycle, error mentions all three agents', () => {
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
`);
    tmp.push(p);

    expect(() => loadConfig(p)).toThrow(ConfigValidationError);

    let err: ConfigValidationError | null = null;
    try { loadConfig(p); } catch (e) { err = e as ConfigValidationError; }

    expect(err!.message).toMatch(/a/);
    expect(err!.message).toMatch(/b/);
    expect(err!.message).toMatch(/c/);
    // issues array should include entries for each agent in the cycle
    const cycleAgents = err!.issues.map((i) => i.path);
    expect(cycleAgents.some((p) => p.includes('a'))).toBe(true);
    expect(cycleAgents.some((p) => p.includes('b'))).toBe(true);
    expect(cycleAgents.some((p) => p.includes('c'))).toBe(true);
  });

  it('accepts a linear chain A->B->C (no cycle)', () => {
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
`);
    tmp.push(p);
    expect(() => loadConfig(p)).not.toThrow();
  });

  it('accepts a diamond: C depends on A and B, both depend on D', () => {
    const p = makeTmpYaml(`
version: 1
agents:
  c:
    provider: ollama
    model: llama3
    depends_on: [a, b]
  a:
    provider: ollama
    model: llama3
    depends_on: [d]
  b:
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

  it('rejects a self-loop (A depends on itself)', () => {
    const p = makeTmpYaml(`
version: 1
agents:
  a:
    provider: ollama
    model: llama3
    depends_on: [a]
`);
    tmp.push(p);
    expect(() => loadConfig(p)).toThrow(ConfigValidationError);
    let err: ConfigValidationError | null = null;
    try { loadConfig(p); } catch (e) { err = e as ConfigValidationError; }
    expect(err!.message).toMatch(/a/);
  });

  it('rejects a two-node cycle A->B->A', () => {
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
    depends_on: [a]
`);
    tmp.push(p);
    expect(() => loadConfig(p)).toThrow(ConfigValidationError);
    let err: ConfigValidationError | null = null;
    try { loadConfig(p); } catch (e) { err = e as ConfigValidationError; }
    expect(err!.message).toMatch(/a/);
    expect(err!.message).toMatch(/b/);
  });

  it('rejects a cycle in a disconnected subgraph (X->Y->Z->X, D standalone)', () => {
    const p = makeTmpYaml(`
version: 1
agents:
  x:
    provider: ollama
    model: llama3
    depends_on: [y]
  y:
    provider: ollama
    model: llama3
    depends_on: [z]
  z:
    provider: ollama
    model: llama3
    depends_on: [x]
  d:
    provider: ollama
    model: llama3
`);
    tmp.push(p);
    expect(() => loadConfig(p)).toThrow(ConfigValidationError);
    let err: ConfigValidationError | null = null;
    try { loadConfig(p); } catch (e) { err = e as ConfigValidationError; }
    expect(err!.message).toMatch(/x|y|z/);
  });

  it('accepts a config with no depends_on at all', () => {
    const p = makeTmpYaml(`
version: 1
agents:
  a:
    provider: ollama
    model: llama3
  b:
    provider: ollama
    model: llama3
`);
    tmp.push(p);
    expect(() => loadConfig(p)).not.toThrow();
  });

  it('accepts a fan-out (A is depended on by B and C independently)', () => {
    const p = makeTmpYaml(`
version: 1
agents:
  a:
    provider: ollama
    model: llama3
  b:
    provider: ollama
    model: llama3
    depends_on: [a]
  c:
    provider: ollama
    model: llama3
    depends_on: [a]
`);
    tmp.push(p);
    expect(() => loadConfig(p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// depends_on startup sequencing -- orchestrator
// ---------------------------------------------------------------------------

describe('depends_on startup sequencing', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
    vi.useFakeTimers();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it('starts C only after A and B reach idle/done', async () => {
    // We test sequencing by tracking the order in which runners' start() is called.
    // Dep agents (A, B) complete synchronously. C should not start before them.

    const startOrder: string[] = [];

    // Build config: C depends on A and B
    const config = makeConfig({ a: {}, b: {}, c: { deps: ['a', 'b'] } });

    // Set up store entries manually (normally done in orchestrator.start)
    store.initAgent('a', 'a');
    store.initAgent('b', 'b');
    store.initAgent('c', 'c');

    // Simulate A reaching idle
    store.updateAgentState('a', 'idle');
    // Simulate B reaching idle -- but do it after a microtask so the store
    // emits change events, which is what waitForDeps listens to.

    // Use the actual waitForDeps logic by building runners directly
    const runners = new Map<string, { start: () => Promise<void> }>();

    for (const id of ['a', 'b', 'c']) {
      const provider = mockProvider([
        makeEvent('done', { agentId: id }),
      ]);
      const agentConfig = config.agents[id]!;
      const runner = new AgentRunner(id, agentConfig, provider, store);
      runners.set(id, runner);
    }

    // waitForDeps implementation (mirrors orchestrator)
    const waitForDeps = (depIds: string[]): Promise<void> =>
      new Promise((resolve) => {
        const ready = () =>
          depIds.every((id) => {
            const s = store.getAgent(id)?.state;
            return s === 'idle' || s === 'done';
          });
        if (ready()) { resolve(); return; }
        const check = () => {
          if (ready()) { store.off('change', check); resolve(); }
        };
        store.on('change', check);
      });

    // Launch all three, C waits for deps
    const runA = runners.get('a')!.start().then(() => { startOrder.push('a'); });
    const runB = runners.get('b')!.start().then(() => { startOrder.push('b'); });

    const runC = waitForDeps(['a', 'b']).then(() => {
      startOrder.push('c-started');
      return runners.get('c')!.start();
    });

    // Advance fake timers to flush store batch interval
    await vi.runAllTimersAsync();
    await Promise.all([runA, runB, runC]);

    // C must have started only after A and B completed
    const cIdx = startOrder.indexOf('c-started');
    const aIdx = startOrder.indexOf('a');
    const bIdx = startOrder.indexOf('b');
    expect(cIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });

  it('starts an agent with no depends_on immediately without waiting', async () => {
    const config = makeConfig({ solo: {} });
    store.initAgent('solo', 'solo');

    const provider = mockProvider([makeEvent('done', { agentId: 'solo' })]);
    const runner = new AgentRunner('solo', config.agents['solo']!, provider, store);

    let started = false;
    const p = runner.start().then(() => { started = true; });
    await vi.runAllTimersAsync();
    await p;
    expect(started).toBe(true);
  });

  it('does not start C if dependencies remain pending', async () => {
    // Use real timers here so we can await the promise resolution naturally
    vi.useRealTimers();

    store.destroy();
    store = new Store();

    store.initAgent('a', 'a');
    store.initAgent('c', 'c');

    const waitForDeps = (depIds: string[]): Promise<void> =>
      new Promise((resolve) => {
        const ready = () =>
          depIds.every((id) => {
            const s = store.getAgent(id)?.state;
            return s === 'idle' || s === 'done';
          });
        if (ready()) { resolve(); return; }
        const check = () => {
          if (ready()) { store.off('change', check); resolve(); }
        };
        store.on('change', check);
      });

    let resolved = false;
    const depPromise = waitForDeps(['a']).then(() => { resolved = true; });

    // A is still pending -- wait a couple batch intervals to be sure
    await new Promise((r) => setTimeout(r, 150));
    expect(resolved).toBe(false);

    // satisfy the dep
    store.updateAgentState('a', 'idle');
    // wait for the batch interval (50ms) + a bit extra
    await new Promise((r) => setTimeout(r, 100));
    await depPromise;

    expect(resolved).toBe(true);
  });
});
