// HookRegistry -- lifecycle hook registration and dispatch
// Implementation: T-36

import type { AgentConfig, AgentConfig as AgentCfg } from './config.js';
import type { Message, ToolCall } from './providers/types.js';

export type HookHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

export interface HookMap {
  onAgentStart: [agentId: string, config: AgentCfg];
  onMessage: [agentId: string, message: Message];
  onToolCall: [agentId: string, toolCall: ToolCall];
  onError: [agentId: string, error: { code: string; message: string; retryable: boolean }];
  onAgentDone: [agentId: string];
}

export type HookName = keyof HookMap;

export class HookRegistry {
  private handlers = new Map<HookName, HookHandler<unknown[]>[]>();

  register<K extends HookName>(name: K, handler: HookHandler<HookMap[K]>): void {
    let list = this.handlers.get(name);
    if (!list) {
      list = [];
      this.handlers.set(name, list);
    }
    list.push(handler as HookHandler<unknown[]>);
  }

  async invoke<K extends HookName>(name: K, ...args: HookMap[K]): Promise<void> {
    const list = this.handlers.get(name);
    if (!list) return;

    for (const handler of list) {
      try {
        await (handler as (...a: HookMap[K]) => void | Promise<void>)(...args);
      } catch (err) {
        // hook errors must not disrupt the agent lifecycle
        console.error(`[hooks] handler for "${name}" threw:`, err);
      }
    }
  }
}

// shared singleton -- consumers may also construct their own registry
export const globalHooks = new HookRegistry();
