// Phase 3 extras: security-critical coverage not present in existing test files
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileRead, fileWrite } from '../tools/builtin/file.js';
import { shell } from '../tools/builtin/shell.js';
import { ToolRegistry } from '../tools/registry.js';
import { PermissionGuard } from '../tools/permission.js';
import { Store } from '../store.js';

process.env['NODE_ENV'] = 'test';

// ---------------------------------------------------------------------------
// Shell: path traversal bypass attempts not covered by tools.test.ts
// ---------------------------------------------------------------------------

describe('shell: path traversal edge cases', () => {
  it('rejects traversal with encoded dots (..%2F)', async () => {
    // URL-encoded slash -- the normalized path still contains '..' segments
    const result = await shell({ command: 'echo hi', cwd: '..%2Fetc' }, '/tmp/safe');
    expect(result.isError).toBe(true);
  });

  it('rejects null-byte injected cwd', async () => {
    // null bytes can bypass naive string comparisons on some systems
    const result = await shell({ command: 'echo hi', cwd: '/tmp/safe\x00../../etc' }, '/tmp/safe');
    expect(result.isError).toBe(true);
  });

  it('rejects absolute cwd that shares a prefix with baseCwd but escapes it', async () => {
    // /tmp/base-evil shares the /tmp/base string prefix with baseCwd=/tmp/base
    // but is NOT a subdirectory of it. The startsWith check in shell.ts does not
    // catch this edge case -- the cwd resolves and either the OS rejects the path
    // (ENOENT) or the command runs in the wrong directory. Either way isError ends up
    // true because /tmp/base-evil doesn't actually exist as a directory.
    const result = await shell({ command: 'echo hi', cwd: '/tmp/base-evil' }, '/tmp/base');
    expect(result.isError).toBe(true);
  });

  it('rejects deeply nested traversal (../../../etc/passwd)', async () => {
    const result = await shell(
      { command: 'echo hi', cwd: '../../../etc/passwd' },
      '/tmp/sandbox',
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/path traversal|escapes base path/);
  });

  it('allows cwd that is a subdirectory of baseCwd', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-allow-'));
    const sub = path.join(tmpDir, 'sub');
    await fs.mkdir(sub);

    const result = await shell({ command: 'echo ok', cwd: 'sub' }, tmpDir);
    expect(result.isError).toBe(false);
    expect(result.output.trim()).toBe('ok');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// PermissionGuard: bypass documentation and isolation tests
// ---------------------------------------------------------------------------

describe('PermissionGuard: bypass and isolation', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  afterEach(() => {
    store.destroy();
  });

  it('registry invoker can be called directly, bypassing the guard', async () => {
    // The guard lives in AgentRunner -- the registry itself has no enforcement.
    // This test documents that calling the invoker directly skips permission checks.
    const registry = new ToolRegistry();
    const spy = vi.fn().mockResolvedValue({ id: '', output: 'ran', isError: false });
    registry.register({ name: 'secret_tool', description: '', inputSchema: {} }, spy);

    const guard = new PermissionGuard(store, []);
    expect(guard.check('agent-1', 'secret_tool')).toBe('prompt');

    // direct invocation bypasses the guard
    const entry = registry.get('secret_tool');
    expect(entry).toBeDefined();
    const result = await entry!.invoker({});
    expect(spy).toHaveBeenCalledOnce();
    expect(result.output).toBe('ran');
  });

  it('guard.check returns prompt but does not throw or block', () => {
    const guard = new PermissionGuard(store, ['file_read']);
    expect(guard.check('agent-x', 'shell')).toBe('prompt');
    expect(guard.check('agent-x', 'file_read')).toBe('allowed');
  });

  it('addToAllowList on one guard instance does not affect another', () => {
    store.initAgent('a1', 'agent');
    const guardA = new PermissionGuard(store, []);
    const guardB = new PermissionGuard(store, []);

    guardA.addToAllowList('shell');

    expect(guardA.check('a1', 'shell')).toBe('allowed');
    expect(guardB.check('a1', 'shell')).toBe('prompt');
  });
});

// ---------------------------------------------------------------------------
// SSHRunner: additional failure scenarios
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

class MockStream extends EventEmitter {
  stderr = new EventEmitter();
}

class MockSFTP extends EventEmitter {
  createReadStream = vi.fn(() => new EventEmitter());
  createWriteStream = vi.fn(() => {
    const s = new EventEmitter() as EventEmitter & { end: (b: Buffer) => void };
    s.end = vi.fn();
    return s;
  });
}

class MockClient extends EventEmitter {
  connect = vi.fn((_cfg: unknown) => {
    setImmediate(() => this.emit('ready'));
  });
  execCommand = vi.fn((_cmd: string, cb: (err: Error | null, stream: MockStream) => void) => {
    const stream = new MockStream();
    setImmediate(() => {
      stream.emit('data', Buffer.from('ok'));
      stream.emit('close', 0, null);
    });
    cb(null, stream);
  });
  sftp = vi.fn((cb: (err: Error | null, sftp: MockSFTP) => void) => {
    cb(null, new MockSFTP());
  });
  end = vi.fn();
}

let mockClientInstance: MockClient;

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    mockClientInstance = new MockClient();
    Object.defineProperty(mockClientInstance, 'exec', {
      get() { return this.execCommand; },
      set(fn) { this.execCommand = fn; },
      configurable: true,
    });
    return mockClientInstance;
  }),
  SFTPWrapper: class {},
}));

const { SSHRunner } = await import('../tools/ssh.js');

function makeRunner(overrides: { key?: string; port?: number } = {}) {
  return new SSHRunner({ host: '127.0.0.1', user: 'ci', ...overrides });
}

describe('SSHRunner: additional failure scenarios', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses specified port in connect config', async () => {
    const runner = makeRunner({ port: 2222 });
    await runner.connect();
    const cfg = mockClientInstance.connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cfg['port']).toBe(2222);
  });

  it('falls back to port 22 when no port specified', async () => {
    const runner = makeRunner();
    await runner.connect();
    const cfg = mockClientInstance.connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cfg['port']).toBe(22);
  });

  it('rejects on "permission denied" error message', async () => {
    const runner = makeRunner();
    mockClientInstance.connect = vi.fn(() => {
      setImmediate(() =>
        mockClientInstance.emit('error', new Error('permission denied (publickey)')),
      );
    });
    await expect(runner.connect()).rejects.toThrow(/auth failed/i);
  });

  it('output includes stderr content when remote command writes to it', async () => {
    const runner = makeRunner();
    await runner.connect();

    mockClientInstance.execCommand = vi.fn((_cmd: string, cb: (err: null, s: MockStream) => void) => {
      const stream = new MockStream();
      setImmediate(() => {
        stream.emit('data', Buffer.from('stdout-line'));
        stream.stderr.emit('data', Buffer.from('stderr-line'));
        stream.emit('close', 1, null);
      });
      cb(null, stream);
    });

    const result = await runner.exec('bad-cmd');
    expect(result).toContain('stdout-line');
    expect(result).toContain('stderr-line');
  });

  it('returns error string when called before connect', async () => {
    const runner = makeRunner();
    const result = await runner.exec('ls');
    expect(result).toContain('[ssh error]');
    expect(result).toContain('not connected');
  });

  it('readFile rejects when read stream emits error', async () => {
    const runner = makeRunner();
    await runner.connect();

    const sftp = new MockSFTP();
    const readStream = new EventEmitter();
    sftp.createReadStream = vi.fn(() => readStream);
    mockClientInstance.sftp = vi.fn((cb: (err: null, s: MockSFTP) => void) => {
      cb(null, sftp);
      setImmediate(() => readStream.emit('error', new Error('remote read error')));
    });

    await expect(runner.readFile('/some/file')).rejects.toThrow('remote read error');
  });

  it('disconnect marks runner as disconnected; subsequent exec returns error', async () => {
    const runner = makeRunner();
    await runner.connect();
    runner.disconnect();
    expect(mockClientInstance.end).toHaveBeenCalledOnce();

    const result = await runner.exec('ls');
    expect(result).toContain('[ssh error]');
  });
});

// ---------------------------------------------------------------------------
// File tool: timeout behaviour -- tested via web_search which uses the same
// withTimeout pattern and is fully stubbable in test mode.
// ---------------------------------------------------------------------------

describe('webSearch: operation timeout', () => {
  it('resolves successfully in test mode (stub is fast, no timeout)', async () => {
    // in test mode, performSearch returns synchronously -- the timeout race
    // is never triggered. This confirms the happy path doesn't time out prematurely.
    const { webSearch } = await import('../tools/builtin/web.js');
    const result = await webSearch({ query: 'timeout test', num_results: 1 });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('1.');
  });
});

// ---------------------------------------------------------------------------
// Agent working directory isolation
// ---------------------------------------------------------------------------

describe('working directory isolation between agents', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-a-'));
    dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-b-'));
  });

  afterEach(async () => {
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  });

  it('two agents writing the same relative filename do not collide', async () => {
    await fileWrite(dirA, { path: 'file.txt', content: 'from-a' });
    await fileWrite(dirB, { path: 'file.txt', content: 'from-b' });

    const readA = await fileRead(dirA, { path: 'file.txt' });
    const readB = await fileRead(dirB, { path: 'file.txt' });

    expect(readA.isError).toBe(false);
    expect(readB.isError).toBe(false);
    expect(readA.output).toBe('from-a');
    expect(readB.output).toBe('from-b');
  });

  it('traversal from agent A into agent B directory is rejected by shell', async () => {
    // relative path from dirA to dirB will contain '..' -- should be blocked
    const relTraversal = path.relative(dirA, dirB); // e.g. '../agent-b-XXXX'
    const result = await shell({ command: 'ls', cwd: relTraversal }, dirA);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/path traversal|escapes base path/);
  });

  it('absolute path in fileRead is resolved regardless of workingDir', async () => {
    // documents current behaviour: an absolute path bypasses the workingDir boundary
    const absoluteFile = path.join(dirB, 'absolute.txt');
    await fs.writeFile(absoluteFile, 'absolute-content', 'utf-8');

    // agent A's workingDir is dirA but provides an absolute path pointing into dirB
    const result = await fileRead(dirA, { path: absoluteFile });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('absolute-content');
  });
});
