import Anthropic from '@anthropic-ai/sdk';
import type { AgentProvider, Message, StreamEvent, ToolDefinition } from './types.js';

interface AnthropicAdapterOptions {
  apiKey: string;
  model: string;
  agentId: string;
}

export class AnthropicAdapter implements AgentProvider {
  private client: Anthropic;
  private model: string;
  private agentId: string;
  private controller: AbortController | null = null;

  constructor({ apiKey, model, agentId }: AnthropicAdapterOptions) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.agentId = agentId;
  }

  async *send(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent> {
    this.controller = new AbortController();

    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const systemMsg = messages.find(m => m.role === 'system');

    // track partial tool call args accumulated across input_json_delta events
    const toolCallAccumulator: Record<number, { id: string; name: string; args: string }> = {};
    let inputTokens = 0;

    try {
      const stream = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 4096,
          system: systemMsg?.content,
          messages: anthropicMessages,
          tools: tools?.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
          })),
          stream: true,
        },
        { signal: this.controller.signal },
      );

      for await (const event of stream) {
        if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            toolCallAccumulator[event.index] = {
              id: event.content_block.id,
              name: event.content_block.name,
              args: '',
            };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield {
              type: 'text',
              agentId: this.agentId,
              timestamp: Date.now(),
              content: delta.text,
            };
          } else if (delta.type === 'input_json_delta') {
            const acc = toolCallAccumulator[event.index];
            if (acc) {
              acc.args += delta.partial_json;
            }
          }
        } else if (event.type === 'content_block_stop') {
          const acc = toolCallAccumulator[event.index];
          if (acc) {
            let input: unknown = {};
            try {
              input = acc.args ? JSON.parse(acc.args) : {};
            } catch {
              input = acc.args;
            }
            yield {
              type: 'tool_call',
              agentId: this.agentId,
              timestamp: Date.now(),
              toolCall: {
                id: acc.id,
                name: acc.name,
                input,
              },
            };
            delete toolCallAccumulator[event.index];
          }
        } else if (event.type === 'message_delta') {
          yield {
            type: 'done',
            agentId: this.agentId,
            timestamp: Date.now(),
            usage: {
              inputTokens,
              outputTokens: event.usage.output_tokens,
            },
          };
        }
        // message_stop is the last event but message_delta already emitted done
      }
    } catch (err: unknown) {
      if (err instanceof Anthropic.RateLimitError) {
        yield {
          type: 'error',
          agentId: this.agentId,
          timestamp: Date.now(),
          error: {
            code: 'rate_limit',
            message: err.message,
            retryable: true,
          },
        };
        return;
      }
      if (err instanceof Anthropic.APIUserAbortError) {
        // stream was cancelled by abort() -- just stop
        return;
      }
      throw err;
    }
  }

  abort(): void {
    this.controller?.abort();
  }
}
