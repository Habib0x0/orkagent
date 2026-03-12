import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../store.js';
import type { Message } from '../providers/types.js';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  describe('initAgent', () => {
    it('creates an entry with pending state', () => {
      store.initAgent('a1', 'coder');
      const entry = store.getAgent('a1');
      expect(entry).toBeDefined();
      expect(entry?.id).toBe('a1');
      expect(entry?.name).toBe('coder');
      expect(entry?.state).toBe('pending');
      expect(entry?.outputBuffer).toEqual([]);
      expect(entry?.messages).toEqual([]);
      expect(entry?.tokens).toEqual({ input: 0, output: 0 });
      expect(entry?.cost).toBe(0);
    });
  });

  describe('updateAgentState', () => {
    it('transitions agent state', () => {
      store.initAgent('a1', 'coder');
      store.updateAgentState('a1', 'running');
      expect(store.getAgent('a1')?.state).toBe('running');
    });

    it('is a no-op for unknown agent', () => {
      // should not throw
      store.updateAgentState('unknown', 'running');
    });
  });

  describe('appendOutput / ring buffer', () => {
    it('appends lines to outputBuffer', () => {
      store.initAgent('a1', 'coder');
      store.appendOutput('a1', 'hello\nworld');
      const buf = store.getAgent('a1')?.outputBuffer;
      expect(buf).toEqual(['hello', 'world']);
    });

    it('enforces 10,000 line cap by evicting oldest', () => {
      store.initAgent('a1', 'coder');
      // fill to exactly 10,000
      for (let i = 0; i < 10_000; i++) {
        store.appendOutput('a1', `line ${i}`);
      }
      expect(store.getAgent('a1')?.outputBuffer).toHaveLength(10_000);

      // add 5 more -- should evict 5 oldest
      for (let i = 0; i < 5; i++) {
        store.appendOutput('a1', `new ${i}`);
      }
      const buf = store.getAgent('a1')?.outputBuffer!;
      expect(buf).toHaveLength(10_000);
      // first entry should now be line 5, not line 0
      expect(buf[0]).toBe('line 5');
      // last entries should be the new ones
      expect(buf[buf.length - 1]).toBe('new 4');
    });

    it('evicts correctly when adding many lines at once', () => {
      store.initAgent('a1', 'coder');
      // pre-fill 9,999 lines
      for (let i = 0; i < 9_999; i++) {
        store.appendOutput('a1', `old ${i}`);
      }
      // add 5 lines in one call -- crosses boundary
      store.appendOutput('a1', 'a\nb\nc\nd\ne');
      const buf = store.getAgent('a1')?.outputBuffer!;
      expect(buf).toHaveLength(10_000);
    });
  });

  describe('appendMessage', () => {
    it('adds messages to conversation history', () => {
      store.initAgent('a1', 'coder');
      const msg: Message = { role: 'user', content: 'hello' };
      store.appendMessage('a1', msg);
      expect(store.getAgent('a1')?.messages).toHaveLength(1);
      expect(store.getAgent('a1')?.messages[0]).toEqual(msg);
    });

    it('accumulates multiple messages', () => {
      store.initAgent('a1', 'coder');
      store.appendMessage('a1', { role: 'user', content: 'q' });
      store.appendMessage('a1', { role: 'assistant', content: 'a' });
      expect(store.getAgent('a1')?.messages).toHaveLength(2);
    });
  });

  describe('updateTokenUsage', () => {
    it('accumulates token counts', () => {
      store.initAgent('a1', 'coder');
      store.updateTokenUsage('a1', 100, 200);
      store.updateTokenUsage('a1', 50, 75);
      const entry = store.getAgent('a1')!;
      expect(entry.tokens.input).toBe(150);
      expect(entry.tokens.output).toBe(275);
    });
  });

  describe('setFocusedAgent', () => {
    it('sets focused agent id', () => {
      store.initAgent('a1', 'coder');
      store.setFocusedAgent('a1');
      expect(store.getFocusedAgentId()).toBe('a1');
    });

    it('clears focused agent when set to null', () => {
      store.initAgent('a1', 'coder');
      store.setFocusedAgent('a1');
      store.setFocusedAgent(null);
      expect(store.getFocusedAgentId()).toBeNull();
    });
  });

  describe('setLastError', () => {
    it('records the last error message', () => {
      store.initAgent('a1', 'coder');
      store.setLastError('a1', 'something broke');
      expect(store.getAgent('a1')?.lastError).toBe('something broke');
    });
  });

  describe('selectors', () => {
    it('getAllAgents returns all entries', () => {
      store.initAgent('a1', 'coder');
      store.initAgent('a2', 'reviewer');
      const all = store.getAllAgents();
      expect(Object.keys(all)).toHaveLength(2);
      expect(all['a1']?.name).toBe('coder');
      expect(all['a2']?.name).toBe('reviewer');
    });

    it('getSessionCost returns 0 initially', () => {
      expect(store.getSessionCost()).toBe(0);
    });

    it('getFocusedAgentId returns null initially', () => {
      expect(store.getFocusedAgentId()).toBeNull();
    });
  });

  describe('batched change events', () => {
    it('emits a single change event per 50ms window even with 100 rapid dispatches', () => {
      const handler = vi.fn();
      store.on('change', handler);

      store.initAgent('a1', 'coder');
      // 100 rapid dispatches within the same tick
      for (let i = 0; i < 100; i++) {
        store.appendOutput('a1', `line ${i}`);
      }

      // no events fired yet -- timer hasn't run
      expect(handler).toHaveBeenCalledTimes(0);

      // advance time past one batch window
      vi.advanceTimersByTime(50);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not emit change when nothing is dirty', () => {
      const handler = vi.fn();
      store.on('change', handler);
      vi.advanceTimersByTime(200);
      expect(handler).toHaveBeenCalledTimes(0);
    });

    it('emits again if more changes happen after the first flush', () => {
      const handler = vi.fn();
      store.on('change', handler);
      store.initAgent('a1', 'coder');

      vi.advanceTimersByTime(50);
      expect(handler).toHaveBeenCalledTimes(1);

      store.updateAgentState('a1', 'running');
      vi.advanceTimersByTime(50);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('change event receives current state', () => {
      let captured: unknown;
      store.on('change', (s) => { captured = s; });
      store.initAgent('a1', 'coder');
      vi.advanceTimersByTime(50);
      expect((captured as { agents: Record<string, unknown> }).agents['a1']).toBeDefined();
    });
  });
});
