// Built-in file tools: file_read and file_write
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolRegistry } from '../registry.js';

const TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Operation timed out')), ms),
    ),
  ]);
}

export async function fileRead(
  workingDir: string,
  input: unknown,
): Promise<{ output: string; isError: boolean }> {
  const { path: filePath } = input as { path: string };
  const resolved = path.resolve(workingDir, filePath);

  try {
    const contents = await withTimeout(fs.readFile(resolved, 'utf-8'), TIMEOUT_MS);
    return { output: contents, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `file_read error: ${msg}`, isError: true };
  }
}

export async function fileWrite(
  workingDir: string,
  input: unknown,
): Promise<{ output: string; isError: boolean }> {
  const { path: filePath, content } = input as { path: string; content: string };
  const resolved = path.resolve(workingDir, filePath);

  try {
    await withTimeout(
      fs.mkdir(path.dirname(resolved), { recursive: true }).then(() =>
        fs.writeFile(resolved, content, 'utf-8'),
      ),
      TIMEOUT_MS,
    );
    return { output: `wrote ${resolved}`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `file_write error: ${msg}`, isError: true };
  }
}

export function register(registry: ToolRegistry, workingDir: string): void {
  registry.register(
    {
      name: 'file_read',
      description: 'Read a file from disk. Path is relative to the agent working directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
    async (input) => {
      const result = await fileRead(workingDir, input);
      return { id: '', ...result };
    },
  );

  registry.register(
    {
      name: 'file_write',
      description: 'Write content to a file. Creates parent directories as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
    async (input) => {
      const result = await fileWrite(workingDir, input);
      return { id: '', ...result };
    },
  );
}
