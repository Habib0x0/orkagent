import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../eventbus.js';
import type { StreamEvent } from '../providers/types.js';

function makeEvent(agentId = 'agent-1'): StreamEvent {
  return { type: 'text', agentId, timestamp: Date.now(), content: 'hello' };
}

describe('EventBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe('text', 'agent-1', handler);
    const event = makeEvent();
    bus.publish('text', event);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('returns an unsubscribe function that stops delivery', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsub = bus.subscribe('text', 'agent-1', handler);
    unsub();
    bus.publish('text', makeEvent());
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not throw when publishing with no subscribers', () => {
    const bus = new EventBus();
    expect(() => bus.publish('text', makeEvent())).not.toThrow();
  });

  it('logs at debug level when publishing with no subscribers', () => {
    const bus = new EventBus();
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    bus.publish('text', makeEvent());
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('unsubscribeAll removes all subscriptions for an agent', () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe('text', 'agent-1', h1);
    bus.subscribe('done', 'agent-1', h2);

    bus.unsubscribeAll('agent-1');

    bus.publish('text', makeEvent());
    bus.publish('done', { ...makeEvent(), type: 'done' });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('unsubscribeAll does not affect other agents', () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe('text', 'agent-1', h1);
    bus.subscribe('text', 'agent-2', h2);

    bus.unsubscribeAll('agent-1');

    bus.publish('text', makeEvent('agent-2'));
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('supports multiple subscribers on the same event type', () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe('text', 'agent-1', h1);
    bus.subscribe('text', 'agent-2', h2);
    bus.publish('text', makeEvent());
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('unsubscribeAll is a no-op for unknown agentId', () => {
    const bus = new EventBus();
    expect(() => bus.unsubscribeAll('ghost')).not.toThrow();
  });
});
