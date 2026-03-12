// Built-in web_search tool
import type { ToolRegistry } from '../registry.js';

const TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('web_search timed out')), ms),
    ),
  ]);
}

const isTest = process.env['NODE_ENV'] === 'test' || process.env['WEB_SEARCH_STUB'] === '1';

async function performSearch(query: string, numResults: number): Promise<string> {
  if (isTest) {
    // stub results for test mode -- no real network calls
    const results = Array.from({ length: numResults }, (_, i) => {
      const n = i + 1;
      return `${n}. [Result ${n}] Stub result for "${query}" - https://example.com/result-${n}`;
    });
    return results.join('\n');
  }

  // real implementation placeholder
  return `web_search: real search not yet implemented (query: ${query})`;
}

export async function webSearch(
  input: unknown,
): Promise<{ output: string; isError: boolean }> {
  const { query, num_results } = input as { query: string; num_results?: number };
  const count = Math.min(num_results ?? 5, 10);

  try {
    const output = await withTimeout(performSearch(query, count), TIMEOUT_MS);
    return { output, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `web_search error: ${msg}`, isError: true };
  }
}

export function register(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'web_search',
      description: 'Search the web for information.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          num_results: { type: 'number', description: 'Number of results (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
    async (input) => {
      const result = await webSearch(input);
      return { id: '', ...result };
    },
  );
}
