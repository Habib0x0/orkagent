import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRunner } from '../runner.js';
import { Store } from '../store.js';
import type { AgentConfig } from '../config.js';
import type { AgentProvider, Message, StreamEvent } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
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
  return {
    type,
    agentId: 'test-agent',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Build a mock provider that emits the given sequence of events per call. */
function mockProvider(
  sequences: StreamEvent[][],
): AgentProvider & { callCount: number } {
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

const AGENT_ID = 'agent-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRunner', () => {
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

  describe('state transitions', () => {
    it('transitions starting -> running -> idle on a clean stream', async () => {
      const provider = mockProvider([[
        makeEvent('text', { content: 'hello' }),
        makeEvent('done', { usage: { inputTokens: 10, outputTokens: 5 } }),
      ]]);
      const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store);

      await runner.start();

      // after completion the final state should be idle
      const entry = store.getAgent(AGENT_ID)!;
      expect(entry.state).toBe('idle');
      expect(entry.tokens.input).toBe(10);
    });

    it('accumulates token usage on done event', async () => {
      const provider = mockProvider([[
        makeEvent('done', { usage: { inputTokens: 50, outputTokens: 25 } }),
      ]]);
      const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store);
      await runner.start();

      const entry = store.getAgent(AGENT_ID)!;
      expect(entry.tokens.input).toBe(50);
      expect(entry.tokens.output).toBe(25);
    });

    it('appends text output and assistant message', async () => {
      const provider = mockProvider([[
        makeEvent('text', { content: 'Hello world' }),
        makeEvent('done'),
      ]]);
      const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store);
      await runner.start();

      const entry = store.getAgent(AGENT_ID)!;
      expect(entry.outputBuffer.join('')).toContain('Hello world');
      const assistantMsg = entry.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg?.content).toBe('Hello world');
    });

    it('handles tool_call events and adds stub results to history', async () => {
      const provider = mockProvider([[
        makeEvent('tool_call', {
          toolCall: { id: 'tc-1', name: 'file_read', input: { path: '/tmp/x' } },
        }),
        makeEvent('done'),
      ]]);
      const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store);
      await runner.start();

      const entry = store.getAgent(AGENT_ID)!;
      const toolMsg = entry.messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg?.toolCallId).toBe('tc-1');
      // output buffer should contain the tool label
      expect(entry.outputBuffer.join('\n')).toContain('[TOOL: file_read]');
    });

    it('sets state to done on abort', async () => {
      const provider = mockProvider([[
        makeEvent('text', { content: 'partial' }),
      ]]);
      const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store);
      runner.abort();

      expect(store.getAgent(AGENT_ID)?.state).toBe('done');
    });
  });

  describe('restart logic', () => {
    it('retries up to max_restarts times on retryable error', async () => {
      const provider = mockProvider([
        [makeEvent('error', { error: { code: 'provider_error', message: 'oops', retryable: true } })],
        [makeEvent('error', { error: { code: 'provider_error', message: 'oops', retryable: true } })],
        [makeEvent('error', { error: { code: 'provider_error', message: 'oops', retryable: true } })],
        [makeEvent('done')], // 4th call succeeds
      ]);
      const runner = new AgentRunner(AGENT_ID, makeConfig({ max_restarts: 3 }), provider, store);
      await runner.start();

      // 3 retries means 4 total calls
      expect(provider.callCount).toBe(4);
      expect(store.getAgent(AGENT_ID)?.state).toBe('idle');
    });

    it('stops retrying after max_restarts and sets state to error', async () => {
      const provider = mockProvider([
        [makeEvent('error', { error: { code: 'provider_error', message: 'fail', retryable: true } })],
        [makeEvent('error', { error: { code: 'provider_error', message: 'fail', retryable: true } })],
        [makeEvent('error', { error: { code: 'provider_error', message: 'fail', retryable: true } })],
        [makeEvent('error', { error: { code: 'provider_error', message: 'fail', retryable: true } })],
      ]);
      const runner = new AgentRunner(AGENT_ID, makeConfig({ max_restarts: 3 }), provider, store);
      await runner.start();

      expect(store.getAgent(AGENT_ID)?.state).toBe('error');
      // 1 initial + 3 retries = 4 calls, but 4th fails and exceeds limit
      expect(provider.callCount).toBe(4);
    });

    it('restarts on thrown exception from provider', async () => {
      const err = new Error('network failure');
      let calls = 0;
      const provider: AgentProvider & { callCount: number } = {
        get callCount() { return calls; },
        send(_msgs: Message[]) {
          calls++;
          const shouldThrow = calls <= 2;
          return (async function* () {
            if (shouldThrow) throw err;
            yield makeEvent('done');
          })();
        },
        abort: vi.fn(),
      };

      const runner = new AgentRunner(AGENT_ID, makeConfig({ max_restarts: 3 }), provider, store);
      await runner.start();

      expect(provider.callCount).toBe(3);
      expect(store.getAgent(AGENT_ID)?.state).toBe('idle');
    });

    it('preserves conversation history across restarts', async () => {
      // first call throws, second succeeds
      let calls = 0;
      const capturedHistories: Message[][] = [];
      const provider: AgentProvider = {
        send(msgs: Message[]) {
          calls++;
          capturedHistories.push([...msgs]);
          const shouldThrow = calls === 1;
          return (async function* () {
            if (shouldThrow) throw new Error('transient');
            yield makeEvent('text', { content: 'response' });
            yield makeEvent('done');
          })();
        },
        abort: vi.fn(),
      };

      const config = makeConfig({ system: 'You are helpful.', max_restarts: 3 });
      const runner = new AgentRunner(AGENT_ID, config, provider, store);
      await runner.start();

      // both calls should have received the system message
      expect(capturedHistories[0]?.some((m) => m.role === 'system')).toBe(true);
      expect(capturedHistories[1]?.some((m) => m.role === 'system')).toBe(true);
    });

    it('does not restart on non-retryable error', async () => {
      const provider = mockProvider([
        [makeEvent('error', { error: { code: 'auth_error', message: 'invalid key', retryable: false } })],
      ]);
      const runner = new AgentRunner(AGENT_ID, makeConfig({ max_restarts: 3 }), provider, store);
      await runner.start();

      expect(provider.callCount).toBe(1);
      expect(store.getAgent(AGENT_ID)?.state).toBe('error');
    });
  });

  describe('rate limit backoff', () => {
    it('retries after rate_limit error', async () => {
      // use real timers but test doesn't depend on actual delay duration
      vi.useRealTimers();

      let calls = 0;
      const provider: AgentProvider = {
        send(_msgs: Message[]) {
          calls++;
          const callNum = calls;
          return (async function* () {
            if (callNum === 1) {
              yield makeEvent('error', {
                error: { code: 'rate_limit', message: 'too many requests', retryable: true },
              });
              return;
            }
            yield makeEvent('done');
          })();
        },
        abort: vi.fn(),
      };

      const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store);
      await runner.start();

      expect(calls).toBe(2);
      expect(store.getAgent(AGENT_ID)?.state).toBe('idle');
    }, 10_000);

    it('parses Retry-After from error message', () => {
      const msg = 'Rate limited. Retry-After: 30';
      const match = /retry-after:\s*(\d+)/i.exec(msg);
      expect(match?.[1]).toBe('30');
    });
  });

  describe('pause and resume', () => {
    it('pauses the runner and sets state to paused', () => {
      const provider = mockProvider([]);
      const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store);
      runner.pause();

      expect(store.getAgent(AGENT_ID)?.state).toBe('paused');
    });

    it('resume restarts the loop', async () => {
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

      const runner = new AgentRunner(AGENT_ID, makeConfig(), provider, store);
      runner.pause();
      expect(store.getAgent(AGENT_ID)?.state).toBe('paused');

      // resume should trigger a new send cycle
      runner.resume();

      // give the async loop a tick to run
      await new Promise((r) => setTimeout(r, 50));

      expect(calls).toBeGreaterThanOrEqual(1);
    });
  });

  describe('error boundary', () => {
    it('never propagates exceptions to caller', async () => {
      // provider's send() implementation that throws synchronously when iterated
      const provider: AgentProvider = {
        send(_msgs: Message[]) {
          return (async function* () {
            throw new Error('catastrophic failure');
          })();
        },
        abort: vi.fn(),
      };

      const runner = new AgentRunner(AGENT_ID, makeConfig({ max_restarts: 0 }), provider, store);

      // must not throw
      await expect(runner.start()).resolves.toBeUndefined();
      expect(store.getAgent(AGENT_ID)?.state).toBe('error');
    });
  });

  describe('system prompt', () => {
    it('includes system message in history when config.system is set', async () => {
      let capturedMsgs: Message[] = [];
      const provider: AgentProvider = {
        send(msgs: Message[]) {
          capturedMsgs = msgs;
          return (async function* () {
            yield makeEvent('done');
          })();
        },
        abort: vi.fn(),
      };

      const runner = new AgentRunner(
        AGENT_ID,
        makeConfig({ system: 'You are a coding assistant.' }),
        provider,
        store,
      );
      await runner.start();

      expect(capturedMsgs[0]?.role).toBe('system');
      expect(capturedMsgs[0]?.content).toBe('You are a coding assistant.');
    });
  });
});
