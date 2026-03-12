import { EventEmitter } from 'node:events';
import type { AgentState, Message } from './providers/types.js';

export interface AgentStoreEntry {
  id: string;
  name: string;
  state: AgentState;
  outputBuffer: string[];   // ring buffer, max 10,000 lines
  messages: Message[];
  tokens: { input: number; output: number };
  cost: number;
  lastError?: string;
}

export interface PendingApproval {
  id: string;
  agentId: string;
  toolName: string;
  inputSummary: string;
  resolve: (decision: 'approve' | 'deny') => void;
}

export interface AppState {
  agents: Record<string, AgentStoreEntry>;
  focusedAgentId: string | null;
  layout: 'grid' | 'focused';
  pendingApprovals: PendingApproval[];
  sessionCost: number;
}

const OUTPUT_BUFFER_MAX = 10_000;
const BATCH_INTERVAL_MS = 50;

export class Store extends EventEmitter {
  private state: AppState = {
    agents: {},
    focusedAgentId: null,
    layout: 'grid',
    pendingApprovals: [],
    sessionCost: 0,
  };

  private dirty = false;
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    super();
    this.timer = setInterval(() => {
      if (this.dirty) {
        this.dirty = false;
        this.emit('change', this.state);
      }
    }, BATCH_INTERVAL_MS);
    // don't block process exit
    if (this.timer.unref) this.timer.unref();
  }

  destroy() {
    clearInterval(this.timer);
  }

  private markDirty() {
    this.dirty = true;
  }

  // -- mutations --

  initAgent(id: string, name: string): void {
    this.state.agents[id] = {
      id,
      name,
      state: 'pending',
      outputBuffer: [],
      messages: [],
      tokens: { input: 0, output: 0 },
      cost: 0,
    };
    this.markDirty();
  }

  updateAgentState(id: string, state: AgentState): void {
    const entry = this.state.agents[id];
    if (!entry) return;
    entry.state = state;
    this.markDirty();
  }

  appendOutput(id: string, text: string): void {
    const entry = this.state.agents[id];
    if (!entry) return;
    const lines = text.split('\n');
    for (const line of lines) {
      entry.outputBuffer.push(line);
    }
    // evict oldest lines if over the cap
    if (entry.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      entry.outputBuffer.splice(0, entry.outputBuffer.length - OUTPUT_BUFFER_MAX);
    }
    this.markDirty();
  }

  appendMessage(id: string, message: Message): void {
    const entry = this.state.agents[id];
    if (!entry) return;
    entry.messages.push(message);
    this.markDirty();
  }

  updateTokenUsage(id: string, input: number, output: number): void {
    const entry = this.state.agents[id];
    if (!entry) return;
    entry.tokens.input += input;
    entry.tokens.output += output;
    // update session total -- recalculate from all agents
    this.state.sessionCost = Object.values(this.state.agents).reduce(
      (sum, a) => sum + a.cost,
      0,
    );
    this.markDirty();
  }

  setFocusedAgent(id: string | null): void {
    this.state.focusedAgentId = id;
    this.state.layout = id !== null ? 'focused' : 'grid';
    this.markDirty();
  }

  setLastError(id: string, error: string): void {
    const entry = this.state.agents[id];
    if (!entry) return;
    entry.lastError = error;
    this.markDirty();
  }

  addPendingApproval(approval: PendingApproval): void {
    this.state.pendingApprovals.push(approval);
    this.markDirty();
  }

  resolvePendingApproval(approvalId: string, decision: 'approve' | 'deny'): void {
    const idx = this.state.pendingApprovals.findIndex((a) => a.id === approvalId);
    if (idx === -1) return;
    const [approval] = this.state.pendingApprovals.splice(idx, 1);
    approval.resolve(decision);
    this.markDirty();
  }

  // -- selectors --

  getAgent(id: string): AgentStoreEntry | undefined {
    return this.state.agents[id];
  }

  getAllAgents(): Record<string, AgentStoreEntry> {
    return this.state.agents;
  }

  getFocusedAgentId(): string | null {
    return this.state.focusedAgentId;
  }

  getSessionCost(): number {
    return this.state.sessionCost;
  }

  getState(): Readonly<AppState> {
    return this.state;
  }
}
