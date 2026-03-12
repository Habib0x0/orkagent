// EventBus -- typed pub/sub for inter-agent communication
import { EventEmitter } from 'node:events';
import type { StreamEvent } from './providers/types.js';

type Handler = (event: StreamEvent) => void;

export class EventBus {
  private emitter = new EventEmitter();
  // agentId -> list of { eventType, handler } pairs, for bulk unsubscribe
  private agentSubs = new Map<string, Array<{ eventType: string; handler: Handler }>>();

  subscribe(eventType: string, agentId: string, handler: Handler): () => void {
    this.emitter.on(eventType, handler);

    if (!this.agentSubs.has(agentId)) {
      this.agentSubs.set(agentId, []);
    }
    this.agentSubs.get(agentId)!.push({ eventType, handler });

    return () => {
      this.emitter.off(eventType, handler);
      const subs = this.agentSubs.get(agentId);
      if (subs) {
        const idx = subs.findIndex(s => s.handler === handler && s.eventType === eventType);
        if (idx !== -1) subs.splice(idx, 1);
      }
    };
  }

  publish(eventType: string, event: StreamEvent): void {
    const listenerCount = this.emitter.listenerCount(eventType);
    if (listenerCount === 0) {
      console.debug(`[EventBus] publish '${eventType}' with no subscribers`);
      return;
    }
    this.emitter.emit(eventType, event);
  }

  unsubscribeAll(agentId: string): void {
    const subs = this.agentSubs.get(agentId);
    if (!subs) return;

    for (const { eventType, handler } of subs) {
      this.emitter.off(eventType, handler);
    }
    this.agentSubs.delete(agentId);
  }
}
