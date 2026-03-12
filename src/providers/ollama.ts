import type { AgentProvider, Message, StreamEvent, ToolDefinition } from './types.js';

interface OllamaAdapterOptions {
  model: string;
  agentId: string;
  baseUrl?: string;
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChunk {
  model: string;
  created_at: string;
  message?: OllamaChatMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaAdapter implements AgentProvider {
  private model: string;
  private agentId: string;
  private baseUrl: string;
  private controller: AbortController | null = null;

  constructor({ model, agentId, baseUrl }: OllamaAdapterOptions) {
    this.model = model;
    this.agentId = agentId;
    // env var takes precedence over constructor arg, which beats the default
    this.baseUrl = process.env.OLLAMA_HOST ?? baseUrl ?? 'http://localhost:11434';
  }

  async *send(messages: Message[], _tools?: ToolDefinition[]): AsyncIterable<StreamEvent> {
    this.controller = new AbortController();

    const ollamaMessages: OllamaChatMessage[] = messages
      .filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      }));

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: ollamaMessages,
          stream: true,
        }),
        signal: this.controller.signal,
      });
    } catch (err: unknown) {
      if (isAbortError(err)) return;
      throw err;
    }

    if (!res.ok) {
      if (res.status === 429) {
        yield {
          type: 'error',
          agentId: this.agentId,
          timestamp: Date.now(),
          error: {
            code: 'rate_limit',
            message: `HTTP 429: ${await res.text()}`,
            retryable: true,
          },
        };
        return;
      }
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body from Ollama');

    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (err: unknown) {
          if (isAbortError(err)) return;
          throw err;
        }

        const { done, value } = result;
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        // last element may be partial -- keep it in the buffer
        buf = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaChunk;
          try {
            chunk = JSON.parse(trimmed) as OllamaChunk;
          } catch {
            continue;
          }

          if (chunk.message?.content) {
            yield {
              type: 'text',
              agentId: this.agentId,
              timestamp: Date.now(),
              content: chunk.message.content,
            };
          }

          if (chunk.done) {
            const doneEvent: StreamEvent = {
              type: 'done',
              agentId: this.agentId,
              timestamp: Date.now(),
            };

            // only emit usage when Ollama includes it (not all versions do)
            if (chunk.prompt_eval_count !== undefined && chunk.eval_count !== undefined) {
              doneEvent.usage = {
                inputTokens: chunk.prompt_eval_count,
                outputTokens: chunk.eval_count,
              };
            }

            yield doneEvent;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  abort(): void {
    this.controller?.abort();
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.includes('aborted'))
  );
}
