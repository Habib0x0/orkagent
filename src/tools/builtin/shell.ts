// Built-in shell tool with path restriction enforcement
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { ToolRegistry } from '../registry.js';

const TIMEOUT_MS = 30_000;

function hasPathTraversal(p: string): boolean {
  // reject anything with .. segments
  const normalized = path.normalize(p);
  return normalized.includes('..');
}

export async function shell(
  input: unknown,
  baseCwd?: string,
): Promise<{ output: string; isError: boolean }> {
  const { command, cwd: inputCwd } = input as { command: string; cwd?: string };

  // determine effective working dir
  let effectiveCwd: string | undefined;
  if (inputCwd !== undefined) {
    if (hasPathTraversal(inputCwd)) {
      return { output: 'shell error: path traversal rejected', isError: true };
    }
    if (baseCwd) {
      const resolved = path.resolve(baseCwd, inputCwd);
      // make sure we haven't escaped the base path
      if (!resolved.startsWith(baseCwd)) {
        return { output: 'shell error: cwd escapes base path', isError: true };
      }
      effectiveCwd = resolved;
    } else {
      effectiveCwd = inputCwd;
    }
  } else if (baseCwd) {
    effectiveCwd = baseCwd;
  }

  // split into executable + args -- no shell string to avoid injection
  const parts = command.trim().split(/\s+/);
  const [executable, ...args] = parts;

  return new Promise((resolve) => {
    const proc = execFile(
      executable,
      args,
      { cwd: effectiveCwd, timeout: 0 /* we handle timeout manually */ },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        const combined = [stdout, stderr].filter(Boolean).join('');
        if (err && err.killed) {
          resolve({ output: 'shell error: process killed (timeout)', isError: true });
        } else if (err && !stdout && !stderr) {
          resolve({ output: `shell error: ${err.message}`, isError: true });
        } else {
          // return combined output even if exit code was non-zero
          resolve({ output: combined || '', isError: !!err });
        }
      },
    );

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);
  });
}

export function register(registry: ToolRegistry, baseCwd?: string): void {
  registry.register(
    {
      name: 'shell',
      description: 'Execute a shell command. Returns combined stdout and stderr.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
        },
        required: ['command'],
      },
    },
    async (input) => {
      const result = await shell(input, baseCwd);
      return { id: '', ...result };
    },
  );
}
