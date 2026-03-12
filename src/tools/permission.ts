// PermissionGuard -- allow-list enforcement and approval dispatch
import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';

export class PermissionGuard {
  private allowList: Set<string>;

  constructor(
    private readonly store: Store,
    tools: string[],
  ) {
    this.allowList = new Set(tools);
  }

  check(agentId: string, toolName: string): 'allowed' | 'prompt' {
    void agentId; // reserved for future per-agent allow-lists
    return this.allowList.has(toolName) ? 'allowed' : 'prompt';
  }

  requestApproval(
    agentId: string,
    toolName: string,
    inputSummary: string,
  ): Promise<'approve' | 'deny'> {
    return new Promise((resolve) => {
      const approval = {
        id: randomUUID(),
        agentId,
        toolName,
        inputSummary,
        resolve,
      };
      this.store.addPendingApproval(approval);
    });
  }

  addToAllowList(toolName: string): void {
    this.allowList.add(toolName);
  }
}
