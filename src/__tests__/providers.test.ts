import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, StreamEvent } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

// ---------------------------------------------------------------------------
// AnthropicAdapter
// ---------------------------------------------------------------------------

describe('AnthropicAdapter', () => {
  // We mock the SDK so no real HTTP calls happen.
  // Each test builds a fake stream of RawMessageStreamEvent objects.

  const makeStream = (events: object[]) => {
    return (async function* () {
      for (const e of events) yield e;
    })();
  };

  const messages: Message[] = [{ role: 'user', content: 'hello' }];

  beforeEach(() => {
    vi.resetModules();
  });

  it('maps text delta to StreamEvent type=text', async () => {
    vi.doMock('@anthropic-ai/sdk', () => {
      const fakeStream = makeStream([
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello world' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ]);
      const MockAnthropic: any = function () {};
      MockAnthropic.prototype.messages = {
        create: vi.fn().mockResolvedValue(fakeStream),
      };
      MockAnthropic.RateLimitError = class RateLimitError extends Error {
        constructor() { super('rate limit'); }
      };
      MockAnthropic.APIUserAbortError = class APIUserAbortError extends Error {
        constructor() { super('aborted'); }
      };
      return { default: MockAnthropic };
    });

    const { AnthropicAdapter } = await import('../providers/anthropic.js');
    const adapter = new AnthropicAdapter({ apiKey: 'test', model: 'claude-3', agentId: 'agent-1' });
    const events = await collect(adapter.send(messages));

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].content).toBe('hello world');
    expect(textEvents[0].agentId).toBe('agent-1');
  });

  it('maps tool call to StreamEvent type=tool_call', async () => {
    vi.doMock('@anthropic-ai/sdk', () => {
      const fakeStream = makeStream([
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tc-1', name: 'file_read' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"foo.txt"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      ]);
      const MockAnthropic: any = function () {};
      MockAnthropic.prototype.messages = {
        create: vi.fn().mockResolvedValue(fakeStream),
      };
      MockAnthropic.RateLimitError = class RateLimitError extends Error {};
      MockAnthropic.APIUserAbortError = class APIUserAbortError extends Error {};
      return { default: MockAnthropic };
    });

    const { AnthropicAdapter } = await import('../providers/anthropic.js');
    const adapter = new AnthropicAdapter({ apiKey: 'test', model: 'claude-3', agentId: 'agent-1' });
    const events = await collect(adapter.send(messages));

    const toolEvents = events.filter(e => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].toolCall?.name).toBe('file_read');
    expect(toolEvents[0].toolCall?.input).toEqual({ path: 'foo.txt' });
    expect(toolEvents[0].toolCall?.id).toBe('tc-1');
  });

  it('maps message_delta to StreamEvent type=done with usage', async () => {
    vi.doMock('@anthropic-ai/sdk', () => {
      const fakeStream = makeStream([
        { type: 'message_start', message: { usage: { input_tokens: 20 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } },
      ]);
      const MockAnthropic: any = function () {};
      MockAnthropic.prototype.messages = {
        create: vi.fn().mockResolvedValue(fakeStream),
      };
      MockAnthropic.RateLimitError = class RateLimitError extends Error {};
      MockAnthropic.APIUserAbortError = class APIUserAbortError extends Error {};
      return { default: MockAnthropic };
    });

    const { AnthropicAdapter } = await import('../providers/anthropic.js');
    const adapter = new AnthropicAdapter({ apiKey: 'test', model: 'claude-3', agentId: 'agent-1' });
    const events = await collect(adapter.send(messages));

    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].usage).toEqual({ inputTokens: 20, outputTokens: 15 });
  });

  it('emits retryable error event on 429', async () => {
    vi.doMock('@anthropic-ai/sdk', () => {
      class RateLimitError extends Error {
        constructor() { super('rate limit exceeded'); }
      }
      const MockAnthropic: any = function () {};
      MockAnthropic.prototype.messages = {
        create: vi.fn().mockRejectedValue(new RateLimitError()),
      };
      MockAnthropic.RateLimitError = RateLimitError;
      MockAnthropic.APIUserAbortError = class APIUserAbortError extends Error {};
      return { default: MockAnthropic };
    });

    const { AnthropicAdapter } = await import('../providers/anthropic.js');
    const adapter = new AnthropicAdapter({ apiKey: 'test', model: 'claude-3', agentId: 'agent-1' });
    const events = await collect(adapter.send(messages));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error?.code).toBe('rate_limit');
    expect(events[0].error?.retryable).toBe(true);
  });

  it('abort cancels the stream', async () => {
    vi.doMock('@anthropic-ai/sdk', () => {
      class APIUserAbortError extends Error {
        constructor() { super('aborted'); this.name = 'APIUserAbortError'; }
      }
      const MockAnthropic: any = function () {};
      MockAnthropic.prototype.messages = {
        create: vi.fn().mockRejectedValue(new APIUserAbortError()),
      };
      MockAnthropic.RateLimitError = class RateLimitError extends Error {};
      MockAnthropic.APIUserAbortError = APIUserAbortError;
      return { default: MockAnthropic };
    });

    const { AnthropicAdapter } = await import('../providers/anthropic.js');
    const adapter = new AnthropicAdapter({ apiKey: 'test', model: 'claude-3', agentId: 'agent-1' });
    adapter.abort();
    const events = await collect(adapter.send(messages));
    // abort should produce no events
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAIAdapter
// ---------------------------------------------------------------------------

describe('OpenAIAdapter', () => {
  const makeStream = (chunks: object[]) => {
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  };

  const messages: Message[] = [{ role: 'user', content: 'hello' }];

  beforeEach(() => {
    vi.resetModules();
  });

  it('maps delta.content to StreamEvent type=text', async () => {
    vi.doMock('openai', () => {
      const stream = makeStream([
        { choices: [{ delta: { content: 'hi there' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: null },
      ]);
      const MockOpenAI: any = function () {};
      MockOpenAI.prototype.chat = {
        completions: { create: vi.fn().mockResolvedValue(stream) },
      };
      MockOpenAI.RateLimitError = class RateLimitError extends Error {};
      MockOpenAI.APIUserAbortError = class APIUserAbortError extends Error {};
      return { default: MockOpenAI };
    });

    const { OpenAIAdapter } = await import('../providers/openai.js');
    const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-4o', agentId: 'agent-2' });
    const events = await collect(adapter.send(messages));

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].content).toBe('hi there');
    expect(textEvents[0].agentId).toBe('agent-2');
  });

  it('maps delta.tool_calls to StreamEvent type=tool_call', async () => {
    vi.doMock('openai', () => {
      const stream = makeStream([
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'shell', arguments: '{"cmd' } }],
            },
            finish_reason: null,
            index: 0,
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '":"ls"}' } }],
            },
            finish_reason: null,
            index: 0,
          }],
        },
        {
          choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
          usage: { prompt_tokens: 5, completion_tokens: 10 },
        },
      ]);
      const MockOpenAI: any = function () {};
      MockOpenAI.prototype.chat = {
        completions: { create: vi.fn().mockResolvedValue(stream) },
      };
      MockOpenAI.RateLimitError = class RateLimitError extends Error {};
      MockOpenAI.APIUserAbortError = class APIUserAbortError extends Error {};
      return { default: MockOpenAI };
    });

    const { OpenAIAdapter } = await import('../providers/openai.js');
    const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-4o', agentId: 'agent-2' });
    const events = await collect(adapter.send(messages));

    const toolEvents = events.filter(e => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].toolCall?.name).toBe('shell');
    expect(toolEvents[0].toolCall?.input).toEqual({ cmd: 'ls' });
    expect(toolEvents[0].toolCall?.id).toBe('call-1');
  });

  it('maps finish_reason=stop to StreamEvent type=done with usage', async () => {
    vi.doMock('openai', () => {
      const stream = makeStream([
        {
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        },
      ]);
      const MockOpenAI: any = function () {};
      MockOpenAI.prototype.chat = {
        completions: { create: vi.fn().mockResolvedValue(stream) },
      };
      MockOpenAI.RateLimitError = class RateLimitError extends Error {};
      MockOpenAI.APIUserAbortError = class APIUserAbortError extends Error {};
      return { default: MockOpenAI };
    });

    const { OpenAIAdapter } = await import('../providers/openai.js');
    const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-4o', agentId: 'agent-2' });
    const events = await collect(adapter.send(messages));

    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    const withUsage = doneEvents.find(e => e.usage);
    expect(withUsage?.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  it('emits retryable error event on 429', async () => {
    vi.doMock('openai', () => {
      class RateLimitError extends Error {
        constructor() { super('rate limit'); }
      }
      const MockOpenAI: any = function () {};
      MockOpenAI.prototype.chat = {
        completions: { create: vi.fn().mockRejectedValue(new RateLimitError()) },
      };
      MockOpenAI.RateLimitError = RateLimitError;
      MockOpenAI.APIUserAbortError = class APIUserAbortError extends Error {};
      return { default: MockOpenAI };
    });

    const { OpenAIAdapter } = await import('../providers/openai.js');
    const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-4o', agentId: 'agent-2' });
    const events = await collect(adapter.send(messages));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error?.code).toBe('rate_limit');
    expect(events[0].error?.retryable).toBe(true);
  });

  it('abort cancels the stream', async () => {
    vi.doMock('openai', () => {
      class APIUserAbortError extends Error {
        constructor() { super('aborted'); }
      }
      const MockOpenAI: any = function () {};
      MockOpenAI.prototype.chat = {
        completions: { create: vi.fn().mockRejectedValue(new APIUserAbortError()) },
      };
      MockOpenAI.RateLimitError = class RateLimitError extends Error {};
      MockOpenAI.APIUserAbortError = APIUserAbortError;
      return { default: MockOpenAI };
    });

    const { OpenAIAdapter } = await import('../providers/openai.js');
    const adapter = new OpenAIAdapter({ apiKey: 'test', model: 'gpt-4o', agentId: 'agent-2' });
    adapter.abort();
    const events = await collect(adapter.send(messages));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OllamaAdapter
// ---------------------------------------------------------------------------

describe('OllamaAdapter', () => {
  const messages: Message[] = [{ role: 'user', content: 'hello' }];

  // Build a mock fetch that streams NDJSON lines
  function mockFetch(lines: string[], status = 200) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line + '\n'));
        }
        controller.close();
      },
    });
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 429 ? 'Too Many Requests' : 'OK',
      text: () => Promise.resolve('rate limited'),
      body: stream,
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', undefined);
    delete process.env.OLLAMA_HOST;
  });

  it('maps message.content to StreamEvent type=text', async () => {
    const lines = [
      JSON.stringify({ model: 'llama3', created_at: '', message: { role: 'assistant', content: 'Hello!' }, done: false }),
      JSON.stringify({ model: 'llama3', created_at: '', done: true, prompt_eval_count: 5, eval_count: 3 }),
    ];
    vi.stubGlobal('fetch', mockFetch(lines));

    const { OllamaAdapter } = await import('../providers/ollama.js');
    const adapter = new OllamaAdapter({ model: 'llama3', agentId: 'agent-3' });
    const events = await collect(adapter.send(messages));

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].content).toBe('Hello!');
    expect(textEvents[0].agentId).toBe('agent-3');
  });

  it('maps done=true to StreamEvent type=done', async () => {
    const lines = [
      JSON.stringify({ model: 'llama3', created_at: '', done: true, prompt_eval_count: 10, eval_count: 4 }),
    ];
    vi.stubGlobal('fetch', mockFetch(lines));

    const { OllamaAdapter } = await import('../providers/ollama.js');
    const adapter = new OllamaAdapter({ model: 'llama3', agentId: 'agent-3' });
    const events = await collect(adapter.send(messages));

    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it('emits done without usage when token counts are absent', async () => {
    const lines = [
      JSON.stringify({ model: 'llama3', created_at: '', done: true }),
    ];
    vi.stubGlobal('fetch', mockFetch(lines));

    const { OllamaAdapter } = await import('../providers/ollama.js');
    const adapter = new OllamaAdapter({ model: 'llama3', agentId: 'agent-3' });
    const events = await collect(adapter.send(messages));

    const doneEvents = events.filter(e => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].usage).toBeUndefined();
  });

  it('emits retryable error on 429', async () => {
    vi.stubGlobal('fetch', mockFetch([], 429));

    const { OllamaAdapter } = await import('../providers/ollama.js');
    const adapter = new OllamaAdapter({ model: 'llama3', agentId: 'agent-3' });
    const events = await collect(adapter.send(messages));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error?.code).toBe('rate_limit');
    expect(events[0].error?.retryable).toBe(true);
  });

  it('abort cancels the stream', async () => {
    // fetch will throw AbortError when signal fires
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const { OllamaAdapter } = await import('../providers/ollama.js');
    const adapter = new OllamaAdapter({ model: 'llama3', agentId: 'agent-3' });
    adapter.abort();
    const events = await collect(adapter.send(messages));
    expect(events).toHaveLength(0);
  });

  it('respects OLLAMA_HOST env var', async () => {
    process.env.OLLAMA_HOST = 'http://custom-host:11434';
    const lines = [
      JSON.stringify({ model: 'llama3', created_at: '', done: true }),
    ];
    const fakeFetch = mockFetch(lines);
    vi.stubGlobal('fetch', fakeFetch);

    const { OllamaAdapter } = await import('../providers/ollama.js');
    const adapter = new OllamaAdapter({ model: 'llama3', agentId: 'agent-3' });
    await collect(adapter.send(messages));

    expect(fakeFetch).toHaveBeenCalledWith(
      'http://custom-host:11434/api/chat',
      expect.any(Object),
    );
  });
});
