import OpenAI from 'openai';
import type { AgentProvider, Message, StreamEvent, ToolDefinition } from './types.js';

interface OpenAIAdapterOptions {
  apiKey: string;
  model: string;
  agentId: string;
}

export class OpenAIAdapter implements AgentProvider {
  private client: OpenAI;
  private model: string;
  private agentId: string;
  private controller: AbortController | null = null;

  constructor({ apiKey, model, agentId }: OpenAIAdapterOptions) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.agentId = agentId;
  }

  async *send(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent> {
    this.controller = new AbortController();

    const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map(m => {
      if (m.role === 'system') {
        return { role: 'system', content: m.content };
      }
      if (m.role === 'user') {
        return { role: 'user', content: m.content };
      }
      if (m.role === 'tool') {
        return {
          role: 'tool',
          content: m.content,
          tool_call_id: m.toolCallId ?? '',
        };
      }
      // assistant
      const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.content || null,
      };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
          },
        }));
      }
      return msg;
    });

    // accumulate tool call deltas by index -- OpenAI streams them incrementally
    const toolCallAccumulator: Record<
      number,
      { id: string; name: string; args: string }
    > = {};

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: oaiMessages,
          stream: true,
          stream_options: { include_usage: true },
          tools: tools?.map(t => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          })),
        },
        { signal: this.controller.signal },
      );

      for await (const chunk of stream) {
        const choice = chunk.choices[0];

        if (choice) {
          const delta = choice.delta;

          if (delta.content) {
            yield {
              type: 'text',
              agentId: this.agentId,
              timestamp: Date.now(),
              content: delta.content,
            };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccumulator[idx]) {
                toolCallAccumulator[idx] = {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  args: '',
                };
              }
              if (tc.id) toolCallAccumulator[idx].id = tc.id;
              if (tc.function?.name) toolCallAccumulator[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallAccumulator[idx].args += tc.function.arguments;
            }
          }

          if (choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls') {
            // flush any accumulated tool calls before emitting done
            for (const acc of Object.values(toolCallAccumulator)) {
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
            }

            const doneEvent: StreamEvent = {
              type: 'done',
              agentId: this.agentId,
              timestamp: Date.now(),
            };

            // usage comes on the final chunk (may be the same or a later one)
            if (chunk.usage) {
              doneEvent.usage = {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
              };
            }

            yield doneEvent;
          }
        } else if (chunk.usage) {
          // final chunk with usage only (choices is empty)
          // already emitted done above; attach usage if it arrived after
          yield {
            type: 'done',
            agentId: this.agentId,
            timestamp: Date.now(),
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            },
          };
        }
      }
    } catch (err: unknown) {
      if (err instanceof OpenAI.RateLimitError) {
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
      if (err instanceof OpenAI.APIUserAbortError) {
        return;
      }
      throw err;
    }
  }

  abort(): void {
    this.controller?.abort();
  }
}
