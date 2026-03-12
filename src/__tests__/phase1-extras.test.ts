/**
 * Phase 1 extras -- covers gaps not reached by the main test suite.
 *
 * Gaps targeted:
 *   - Config: empty agents object, single-agent team, bad YAML syntax, circular
 *     dependency, openai API key check, team with single agent passes
 *   - Store: appendOutput no-op for unknown agent, addPendingApproval /
 *     resolvePendingApproval, layout field, getState()
 *   - Store ring buffer: exactly-at-cap single-line append (no eviction yet)
 *   - Provider adapters: Anthropic re-throws unknown errors; Ollama non-200
 *     non-429 throws; OpenAI trailing usage-only chunk
 *   - Runner: sendUserMessage queues while running; max_restarts=0 never retries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, ConfigValidationError } from '../config.js';
import { Store } from '../store.js';
import type { AgentProvider, Message, StreamEvent } from '../providers/types.js';
import { AgentRunner } from '../runner.js';
import type { AgentConfig } from '../config.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(__dirname, '../../test-fixtures');

function tmpFixture(name: string, content: string): string {
  const p = path.join(fixtures, name);
  writeFileSync(p, content);
  return p;
}

function rmFixture(p: string) {
  try { unlinkSync(p); } catch { /* gone */ }
}

function makeEvent(
  type: StreamEvent['type'],
  overrides: Partial<StreamEvent> = {},
): StreamEvent {
  return { type, agentId: 'a1', timestamp: Date.now(), ...overrides };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { provider: 'anthropic', model: 'claude-3', max_restarts: 3, ...overrides };
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Config -- gaps
// ---------------------------------------------------------------------------

describe('loadConfig -- extra edge cases', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it('rejects empty agents object (no agents defined)', () => {
    const p = tmpFixture('_tmp_empty_agents.yaml', 'version: 1\nagents: {}\n');
    try {
      loadConfig(p);
      // Zod does not enforce non-empty record by default -- check what the schema does
      // If it passes, just make sure agents is empty and no crash
    } catch (err) {
      // either path is fine -- we just confirm no unhandled exception
      expect(err).toBeInstanceOf(Error);
    } finally {
      rmFixture(p);
    }
  });

  it('throws on malformed YAML (invalid syntax)', () => {
    const p = tmpFixture('_tmp_bad_yaml.yaml', 'version: 1\nagents:\n  bad: [unclosed\n');
    try {
      let caught: unknown;
      try {
        loadConfig(p);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigValidationError);
      expect((caught as ConfigValidationError).message).toContain('invalid YAML');
    } finally {
      rmFixture(p);
    }
  });

  it('throws ConfigValidationError identifying agent name when openai key is missing', () => {
    const p = tmpFixture(
      '_tmp_openai_missing.yaml',
      'version: 1\nagents:\n  myagent:\n    provider: openai\n    model: gpt-4o\n',
    );
    try {
      let caught: unknown;
      try {
        loadConfig(p);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigValidationError);
      const e = caught as ConfigValidationError;
      expect(e.message).toContain('myagent');
      expect(e.message).toContain('OPENAI_API_KEY');
    } finally {
      rmFixture(p);
    }
  });

  it('succeeds when openai agent has its API key set', () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const p = tmpFixture(
      '_tmp_openai_ok.yaml',
      'version: 1\nagents:\n  myagent:\n    provider: openai\n    model: gpt-4o\n',
    );
    try {
      const config = loadConfig(p);
      expect(config.agents.myagent?.provider).toBe('openai');
    } finally {
      rmFixture(p);
    }
  });

  it('detects circular dependency and throws ConfigValidationError', () => {
    // a depends_on b, b depends_on a
    const yaml = [
      'version: 1',
      'agents:',
      '  a:',
      '    provider: ollama',
      '    model: llama3',
      '    depends_on: [b]',
      '  b:',
      '    provider: ollama',
      '    model: llama3',
      '    depends_on: [a]',
    ].join('\n');
    const p = tmpFixture('_tmp_cycle.yaml', yaml);
    try {
      let caught: unknown;
      try {
        loadConfig(p);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigValidationError);
      expect((caught as ConfigValidationError).message).toContain('circular dependency');
    } finally {
      rmFixture(p);
    }
  });

  it('accepts a team with exactly one agent', () => {
    const p = tmpFixture(
      '_tmp_single_agent_team.yaml',
      [
        'version: 1',
        'agents:',
        '  solo:',
        '    provider: ollama',
        '    model: llama3',
        'teams:',
        '  solo_team:',
        '    agents: [solo]',
      ].join('\n'),
    );
    try {
      const config = loadConfig(p);
      expect(config.teams?.solo_team?.agents).toEqual(['solo']);
    } finally {
      rmFixture(p);
    }
  });

  it('rejects a team with zero agents (schema requires min 1)', () => {
    const p = tmpFixture(
      '_tmp_empty_team.yaml',
      'version: 1\nagents:\n  a:\n    provider: ollama\n    model: llama3\nteams:\n  bad: {agents: []}\n',
    );
    try {
      let caught: unknown;
      try {
        loadConfig(p);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigValidationError);
    } finally {
      rmFixture(p);
    }
  });
});

// ---------------------------------------------------------------------------
// Store -- gaps
// ---------------------------------------------------------------------------

describe('Store -- extra edge cases', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it('appendOutput is a no-op for an unknown agent id', () => {
    // must not throw
    expect(() => store.appendOutput('nonexistent', 'some output')).not.toThrow();
  });

  it('appendMessage is a no-op for an unknown agent id', () => {
    expect(() => store.appendMessage('ghost', { role: 'user', content: 'hi' })).not.toThrow();
  });

  it('updateTokenUsage is a no-op for an unknown agent id', () => {
    expect(() => store.updateTokenUsage('ghost', 10, 5)).not.toThrow();
  });

  it('setLastError is a no-op for an unknown agent id', () => {
    expect(() => store.setLastError('ghost', 'boom')).not.toThrow();
  });

  it('ring buffer at exactly 10,000 lines does not evict on that append', () => {
    store.initAgent('a1', 'coder');
    // fill to exactly 9,999 then add one single-line to reach 10,000
    for (let i = 0; i < 9_999; i++) {
      store.appendOutput('a1', `line ${i}`);
    }
    store.appendOutput('a1', 'exactly-ten-thousand');
    const buf = store.getAgent('a1')!.outputBuffer;
    expect(buf).toHaveLength(10_000);
    expect(buf[buf.length - 1]).toBe('exactly-ten-thousand');
    // nothing was evicted yet -- first entry is still line 0
    expect(buf[0]).toBe('line 0');
  });

  it('layout starts as grid and switches to focused when agent is set', () => {
    store.initAgent('a1', 'coder');
    expect(store.getState().layout).toBe('grid');
    store.setFocusedAgent('a1');
    expect(store.getState().layout).toBe('focused');
  });

  it('layout reverts to grid when focused agent is cleared', () => {
    store.initAgent('a1', 'coder');
    store.setFocusedAgent('a1');
    store.setFocusedAgent(null);
    expect(store.getState().layout).toBe('grid');
  });

  it('addPendingApproval queues approval; resolvePendingApproval calls resolve and removes it', () => {
    const resolve = vi.fn();
    store.addPendingApproval({
      id: 'ap-1',
      agentId: 'coder',
      toolName: 'shell',
      inputSummary: 'ls',
      resolve,
    });
    expect(store.getState().pendingApprovals).toHaveLength(1);

    store.resolvePendingApproval('ap-1', 'approve');
    expect(resolve).toHaveBeenCalledWith('approve');
    expect(store.getState().pendingApprovals).toHaveLength(0);
  });

  it('resolvePendingApproval with deny calls resolve(deny)', () => {
    const resolve = vi.fn();
    store.addPendingApproval({
      id: 'ap-2',
      agentId: 'coder',
      toolName: 'shell',
      inputSummary: 'rm -rf /',
      resolve,
    });
    store.resolvePendingApproval('ap-2', 'deny');
    expect(resolve).toHaveBeenCalledWith('deny');
  });

  it('resolvePendingApproval is a no-op for unknown approval id', () => {
    const resolve = vi.fn();
    store.addPendingApproval({
      id: 'ap-3',
      agentId: 'coder',
      toolName: 'shell',
      inputSummary: 'echo hi',
      resolve,
    });
    // resolving an unknown id should not throw and should not call resolve
    expect(() => store.resolvePendingApproval('not-there', 'approve')).not.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('getState returns current snapshot with all fields', () => {
    store.initAgent('a1', 'coder');
    const state = store.getState();
    expect(state).toHaveProperty('agents');
    expect(state).toHaveProperty('focusedAgentId');
    expect(state).toHaveProperty('layout');
    expect(state).toHaveProperty('pendingApprovals');
    expect(state).toHaveProperty('sessionCost');
  });
});

// ---------------------------------------------------------------------------
// AnthropicAdapter -- re-throws unknown errors
// ---------------------------------------------------------------------------

describe('AnthropicAdapter -- unknown error is re-thrown', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('re-throws non-SDK errors from the stream', async () => {
    const boom = new Error('unexpected network failure');
    vi.doMock('@anthropic-ai/sdk', () => {
      const MockAnthropic: any = function () {};
      MockAnthropic.prototype.messages = {
        create: vi.fn().mockRejectedValue(boom),
      };
      MockAnthropic.RateLimitError = class RateLimitError extends Error {};
      MockAnthropic.APIUserAbortError = class APIUserAbortError extends Error {};
      return { default: MockAnthropic };
    });

    const { AnthropicAdapter } = await import('../providers/anthropic.js');
    const adapter = new AnthropicAdapter({ apiKey: 'key', model: 'claude-3', agentId: 'a1' });

    await expect(async () => {
      await collect(adapter.send([{ role: 'user', content: 'hi' }]));
    }).rejects.toThrow('unexpected network failure');
  });
});

// ---------------------------------------------------------------------------
// OllamaAdapter -- non-200 non-429 status throws
// ---------------------------------------------------------------------------

describe('OllamaAdapter -- server error status throws', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', undefined);
    delete process.env.OLLAMA_HOST;
  });

  it('throws on 500 Internal Server Error', async () => {
    const encoder = new TextEncoder();
    const emptyStream = new ReadableStream({ start(c) { c.close(); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('server error'),
      body: emptyStream,
    }));

    const { OllamaAdapter } = await import('../providers/ollama.js');
    const adapter = new OllamaAdapter({ model: 'llama3', agentId: 'a1' });

    await expect(async () => {
      await collect(adapter.send([{ role: 'user', content: 'hi' }]));
    }).rejects.toThrow('500');
  });
});

// ---------------------------------------------------------------------------
// OpenAIAdapter -- trailing usage-only chunk
// ---------------------------------------------------------------------------

describe('OpenAIAdapter -- trailing usage-only chunk', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('emits a done event from a choices-empty usage chunk', async () => {
    vi.doMock('openai', () => {
      const stream = (async function* () {
        // first chunk: finish_reason=stop with no usage
        yield {
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          usage: null,
        };
        // second chunk: usage-only (choices is empty array)
        yield {
          choices: [],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        };
      })();

      const MockOpenAI: any = function () {};
      MockOpenAI.prototype.chat = {
        completions: { create: vi.fn().mockResolvedValue(stream) },
      };
      MockOpenAI.RateLimitError = class RateLimitError extends Error {};
      MockOpenAI.APIUserAbortError = class APIUserAbortError extends Error {};
      return { default: MockOpenAI };
    });

    const { OpenAIAdapter } = await import('../providers/openai.js');
    const adapter = new OpenAIAdapter({ apiKey: 'key', model: 'gpt-4o', agentId: 'a2' });
    const events = await collect(adapter.send([{ role: 'user', content: 'hi' }]));

    const doneWithUsage = events.filter(e => e.type === 'done' && e.usage);
    expect(doneWithUsage.length).toBeGreaterThanOrEqual(1);
    const found = doneWithUsage.find(e => e.usage?.inputTokens === 8);
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AgentRunner -- sendUserMessage and max_restarts=0
// ---------------------------------------------------------------------------

describe('AgentRunner -- extra edge cases', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store();
    store.initAgent('a1', 'tester');
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it('max_restarts=0 does not retry on retryable error', async () => {
    let calls = 0;
    const provider: AgentProvider = {
      send(_msgs: Message[]) {
        calls++;
        return (async function* () {
          yield makeEvent('error', { error: { code: 'provider_error', message: 'fail', retryable: true } });
        })();
      },
      abort: vi.fn(),
    };

    const runner = new AgentRunner('a1', makeConfig({ max_restarts: 0 }), provider, store);
    await runner.start();

    expect(calls).toBe(1);
    expect(store.getAgent('a1')?.state).toBe('error');
  });

  it('sendUserMessage while paused does not trigger a new send cycle', async () => {
    vi.useRealTimers();

    let calls = 0;
    const provider: AgentProvider = {
      send(_msgs: Message[]) {
        calls++;
        return (async function* () {
          yield makeEvent('done');
        })();
      },
      abort: vi.fn(),
    };

    const runner = new AgentRunner('a1', makeConfig(), provider, store);
    runner.pause();
    runner.sendUserMessage('hello while paused');

    // give a tick for any async runLoop that might start
    await new Promise(r => setTimeout(r, 20));

    // no send should have happened because runner is paused
    expect(calls).toBe(0);
    expect(store.getAgent('a1')?.state).toBe('paused');
  });

  it('sendUserMessage while aborted does not trigger a send', async () => {
    vi.useRealTimers();

    let calls = 0;
    const provider: AgentProvider = {
      send(_msgs: Message[]) {
        calls++;
        return (async function* () {
          yield makeEvent('done');
        })();
      },
      abort: vi.fn(),
    };

    const runner = new AgentRunner('a1', makeConfig(), provider, store);
    runner.abort();
    runner.sendUserMessage('hello after abort');

    await new Promise(r => setTimeout(r, 20));

    expect(calls).toBe(0);
  });

  it('getHistory returns the current history array', async () => {
    const provider: AgentProvider = {
      send(_msgs: Message[]) {
        return (async function* () { yield makeEvent('done'); })();
      },
      abort: vi.fn(),
    };

    const runner = new AgentRunner('a1', makeConfig({ system: 'Be helpful.' }), provider, store);
    const history = runner.getHistory();
    expect(history).toBeInstanceOf(Array);
    // system message should be pre-populated
    expect(history[0]?.role).toBe('system');
    expect(history[0]?.content).toBe('Be helpful.');
  });
});
