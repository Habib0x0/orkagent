// AgentRunner -- single agent conversation loop with error boundary
// Implementation: T-8, T-19, T-31

import type { AgentConfig } from './config.js';
import type { AgentProvider, Message, StreamEvent, ToolCall, ToolResult } from './providers/types.js';
import type { Store } from './store.js';
import { HookRegistry } from './hooks.js';
import type { EventBus } from './eventbus.js';
import type { ToolRegistry } from './tools/registry.js';
import type { PermissionGuard } from './tools/permission.js';

const RESTART_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

interface RestartRecord {
  timestamp: number;
}

export class AgentRunner {
  private history: Message[] = [];
  private restarts: RestartRecord[] = [];
  private paused = false;
  private aborted = false;
  private running = false;
  // unsubscribe functions for watched agent event bus subscriptions
  private watchUnsubs: Array<() => void> = [];

  constructor(
    private readonly agentId: string,
    private readonly config: AgentConfig,
    private readonly provider: AgentProvider,
    private readonly store: Store,
    private readonly hooks: HookRegistry = new HookRegistry(),
    private readonly eventBus?: EventBus,
    private readonly toolRegistry?: ToolRegistry,
    private readonly permissionGuard?: PermissionGuard,
  ) {
    if (config.system) {
      this.history.push({ role: 'system', content: config.system });
    }
    // seed with a user message so providers that require one (e.g. LM Studio) work
    this.history.push({ role: 'user', content: 'Begin.' });
  }

  /** Begin the conversation loop. Never throws. */
  async start(): Promise<void> {
    this.setupWatches();
    try {
      this.store.updateAgentState(this.agentId, 'starting');
      await this.hooks.invoke('onAgentStart', this.agentId, this.config);
      await this.runLoop();
    } catch (err) {
      // top-level error boundary -- swallow so callers are never disrupted
      const msg = err instanceof Error ? err.message : String(err);
      this.store.setLastError(this.agentId, msg);
      this.store.updateAgentState(this.agentId, 'error');
    }
  }

  /** Subscribe to watched agent events on the event bus. */
  private setupWatches(): void {
    if (!this.eventBus || !this.config.watches?.length) return;

    for (const watchedId of this.config.watches) {
      const unsub = this.eventBus.subscribe(watchedId, this.agentId, (event) => {
        const content = `[watch:${watchedId}] ${event.type}: ${event.content ?? JSON.stringify(event.toolResult ?? event.usage ?? '')}`;
        this.sendUserMessage(content);
      });
      this.watchUnsubs.push(unsub);
    }
  }

  /** Cancel the in-flight request and mark done. */
  abort(): void {
    this.aborted = true;
    this.provider.abort();
    this.store.updateAgentState(this.agentId, 'done');
    this.cleanupWatches();
  }

  private cleanupWatches(): void {
    for (const unsub of this.watchUnsubs) {
      unsub();
    }
    this.watchUnsubs = [];
  }

  /** Stop sending new requests (for cost guardrails). */
  pause(): void {
    this.paused = true;
    this.store.updateAgentState(this.agentId, 'paused');
  }

  /** Resume sending after a pause. */
  resume(): void {
    this.paused = false;
    if (!this.aborted && !this.running) {
      this.runLoop().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.setLastError(this.agentId, msg);
        this.store.updateAgentState(this.agentId, 'error');
      });
    }
  }

  /** Expose history for session persistence (used by Orchestrator). */
  getHistory(): Message[] {
    return this.history;
  }

  /** Inject a user message and trigger a new send cycle. */
  sendUserMessage(content: string): void {
    this.history.push({ role: 'user', content });
    if (!this.paused && !this.aborted && !this.running) {
      this.runLoop().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.setLastError(this.agentId, msg);
        this.store.updateAgentState(this.agentId, 'error');
      });
    }
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    try {
      await this.doSend();
    } finally {
      this.running = false;
    }
  }

  private async doSend(backoffMs = 0): Promise<void> {
    if (this.aborted || this.paused) return;

    if (backoffMs > 0) {
      await delay(backoffMs);
    }
    if (this.aborted || this.paused) return;

    this.store.updateAgentState(this.agentId, 'running');

    // accumulate assistant text across text events before adding to history
    let assistantText = '';
    const pendingToolCalls: ToolCall[] = [];

    try {
      const stream = this.provider.send(this.history);

      for await (const event of stream) {
        if (this.aborted) return;

        switch (event.type) {
          case 'text': {
            const chunk = event.content ?? '';
            assistantText += chunk;
            this.store.appendOutput(this.agentId, chunk);
            if (chunk.length > 0) {
              const msg: Message = { role: 'assistant', content: chunk };
              await this.hooks.invoke('onMessage', this.agentId, msg);
            }
            break;
          }

          case 'tool_call': {
            if (event.toolCall) {
              pendingToolCalls.push(event.toolCall);
              this.store.appendOutput(
                this.agentId,
                `[TOOL: ${event.toolCall.name}]`,
              );
              await this.hooks.invoke('onToolCall', this.agentId, event.toolCall);
            }
            break;
          }

          case 'done': {
            // commit accumulated assistant message and execute tools
            const hadToolCalls = pendingToolCalls.length > 0;
            await this.flushAssistantTurn(assistantText, pendingToolCalls);
            assistantText = '';

            if (event.usage) {
              this.store.updateTokenUsage(
                this.agentId,
                event.usage.inputTokens,
                event.usage.outputTokens,
              );
            }

            // if the model made tool calls, continue the loop to process results
            if (hadToolCalls) {
              this.store.updateAgentState(this.agentId, 'running');
              await this.hooks.invoke('onAgentDone', this.agentId);
              this.eventBus?.publish(this.agentId, { ...event, agentId: this.agentId });
              // continue with tool results in history
              await this.doSend();
              return;
            }

            // no tool calls -- agent completed its turn
            this.store.updateAgentState(this.agentId, 'done');
            await this.hooks.invoke('onAgentDone', this.agentId);
            this.eventBus?.publish(this.agentId, { ...event, agentId: this.agentId });
            return;
          }

          case 'error': {
            if (event.error) {
              await this.hooks.invoke('onError', this.agentId, event.error);
            }
            await this.handleError(event);
            return;
          }

          // tool_result events from our own stubs -- publish so watchers see results
          case 'tool_result':
            this.eventBus?.publish(this.agentId, { ...event, agentId: this.agentId });
            break;
        }
      }

      // stream ended without a done event -- treat as done
      await this.flushAssistantTurn(assistantText, pendingToolCalls);
      this.store.updateAgentState(this.agentId, 'done');
    } catch (err) {
      // unexpected exception from provider
      const msg = err instanceof Error ? err.message : String(err);
      const canRestart = this.recordAndCheckRestart();
      if (canRestart) {
        this.store.updateAgentState(this.agentId, 'starting');
        await this.doSend();
      } else {
        this.store.setLastError(this.agentId, msg);
        this.store.updateAgentState(this.agentId, 'error');
      }
    }
  }

  private async handleError(event: StreamEvent): Promise<void> {
    const err = event.error;
    if (!err) return;

    if (err.code === 'rate_limit' && err.retryable) {
      const retryAfter = parseRetryAfter(err.message);
      const nextBackoff = retryAfter
        ? retryAfter * 1000
        : Math.min(BACKOFF_BASE_MS * 2 ** this.restarts.length, BACKOFF_MAX_MS);

      this.store.updateAgentState(this.agentId, 'starting');
      await this.doSend(nextBackoff);
      return;
    }

    if (err.retryable) {
      const canRestart = this.recordAndCheckRestart();
      if (canRestart) {
        this.store.updateAgentState(this.agentId, 'starting');
        await this.doSend();
        return;
      }
    }

    this.store.setLastError(this.agentId, err.message);
    this.store.updateAgentState(this.agentId, 'error');
  }

  /** Returns true if a restart is allowed, false if limit exceeded. */
  private recordAndCheckRestart(): boolean {
    const now = Date.now();
    const maxRestarts = this.config.max_restarts;

    // evict restarts outside the 5-min window
    this.restarts = this.restarts.filter(
      (r) => now - r.timestamp < RESTART_WINDOW_MS,
    );

    if (this.restarts.length >= maxRestarts) {
      return false;
    }

    this.restarts.push({ timestamp: now });
    return true;
  }

  /** Invoke a tool call, routing through permission guard if configured. */
  private async invokeToolCall(tc: ToolCall): Promise<ToolResult> {
    const entry = this.toolRegistry?.get(tc.name);

    // no registry or tool not found -- fall back to stub
    if (!entry) {
      return { id: tc.id, output: `[stub result for ${tc.name}]`, isError: false };
    }

    if (this.permissionGuard) {
      const decision = this.permissionGuard.check(this.agentId, tc.name);
      if (decision === 'prompt') {
        const inputSummary = JSON.stringify(tc.input);
        const approval = await this.permissionGuard.requestApproval(
          this.agentId,
          tc.name,
          inputSummary,
        );
        if (approval === 'deny') {
          return { id: tc.id, output: `[tool ${tc.name} denied by user]`, isError: true };
        }
      }
    }

    try {
      const result = await entry.invoker(tc.input);
      return { ...result, id: tc.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: tc.id, output: `[tool error] ${msg}`, isError: true };
    }
  }

  private async flushAssistantTurn(text: string, toolCalls: ToolCall[]): Promise<void> {
    if (text.length === 0 && toolCalls.length === 0) return;

    const msg: Message = { role: 'assistant', content: text };
    if (toolCalls.length > 0) {
      msg.toolCalls = toolCalls;
    }
    this.history.push(msg);
    this.store.appendMessage(this.agentId, msg);

    for (const tc of toolCalls) {
      const result = await this.invokeToolCall(tc);
      const toolMsg: Message = {
        role: 'tool',
        content: result.output,
        toolCallId: tc.id,
        toolResults: [result],
      };
      this.history.push(toolMsg);
      this.store.appendMessage(this.agentId, toolMsg);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse "Retry-After: N" seconds from an error message string. */
function parseRetryAfter(msg: string): number | null {
  const m = /retry-after:\s*(\d+)/i.exec(msg);
  if (!m || !m[1]) return null;
  const val = parseInt(m[1], 10);
  return isNaN(val) ? null : val;
}
