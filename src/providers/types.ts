/**
 * Shared type contracts for all provider adapters and the runtime core.
 * Every other module imports from here -- no implementation logic, types only.
 */

/** Lifecycle states an agent can be in at any point during a session. */
export type AgentState = 'pending' | 'starting' | 'running' | 'idle' | 'done' | 'error' | 'paused';

/** A single event emitted from a provider's streaming response. */
export interface StreamEvent {
  /** Discriminant field for the event kind. */
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'done';
  /** ID of the agent that owns this stream -- injected by the runner, not the provider. */
  agentId: string;
  /** Unix timestamp (ms) when this event was created. */
  timestamp: number;
  /** Plain text content for 'text' events. */
  content?: string;
  /** Populated for 'tool_call' events. */
  toolCall?: ToolCall;
  /** Populated for 'tool_result' events. */
  toolResult?: ToolResult;
  /** Token counts, emitted once per API turn (usually on 'done'). */
  usage?: { inputTokens: number; outputTokens: number };
  /** Populated for 'error' events. */
  error?: { code: string; message: string; retryable: boolean };
}

/** A single turn in the conversation history. */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For 'tool' role messages: links this result back to a specific tool call. */
  toolCallId?: string;
  /** For 'assistant' role messages: tool calls the model requested. */
  toolCalls?: ToolCall[];
  /** For 'tool' role messages: results returned to the model. */
  toolResults?: ToolResult[];
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** JSON-decoded input arguments as provided by the model. */
  input: unknown;
}

/** The result of executing a tool, returned to the model as context. */
export interface ToolResult {
  id: string;
  output: string;
  isError: boolean;
}

/** Declaration of a tool that can be offered to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's input parameters. */
  inputSchema: Record<string, unknown>;
}

/** Contract that every provider adapter must satisfy. */
export interface AgentProvider {
  /**
   * Send a message sequence to the model and stream back events.
   * Implementations must be safe to call multiple times (e.g., on restart).
   */
  send(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent>;
  /** Cancel any in-flight request for this provider instance. */
  abort(): void;
}
