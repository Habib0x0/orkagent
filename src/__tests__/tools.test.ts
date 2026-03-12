import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileRead, fileWrite } from '../tools/builtin/file.js';
import { shell } from '../tools/builtin/shell.js';
import { webSearch } from '../tools/builtin/web.js';
import { PermissionGuard } from '../tools/permission.js';
import { Store } from '../store.js';

// make sure web_search runs in stub mode
process.env['NODE_ENV'] = 'test';

// ---- file_read ----

describe('file_read', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkagent-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns file contents', async () => {
    const file = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(file, 'hello world', 'utf-8');

    const result = await fileRead(tmpDir, { path: 'hello.txt' });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('hello world');
  });

  it('returns error on missing file', async () => {
    const result = await fileRead(tmpDir, { path: 'does-not-exist.txt' });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/file_read error/);
  });
});

// ---- file_write ----

describe('file_write', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkagent-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates file with content', async () => {
    const result = await fileWrite(tmpDir, { path: 'out.txt', content: 'test content' });
    expect(result.isError).toBe(false);

    const written = await fs.readFile(path.join(tmpDir, 'out.txt'), 'utf-8');
    expect(written).toBe('test content');
  });

  it('creates parent directories as needed', async () => {
    const result = await fileWrite(tmpDir, {
      path: path.join('subdir', 'nested', 'file.txt'),
      content: 'nested',
    });
    expect(result.isError).toBe(false);

    const written = await fs.readFile(
      path.join(tmpDir, 'subdir', 'nested', 'file.txt'),
      'utf-8',
    );
    expect(written).toBe('nested');
  });

  it('returns error on permission denied', async () => {
    // create a read-only directory to trigger permission denied
    const readonlyDir = path.join(tmpDir, 'readonly');
    await fs.mkdir(readonlyDir, { mode: 0o444 });

    const result = await fileWrite(readonlyDir, { path: 'test.txt', content: 'x' });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/file_write error/);

    // restore permissions for cleanup
    await fs.chmod(readonlyDir, 0o755);
  });
});

// ---- shell ----

describe('shell', () => {
  it('executes a command and returns output', async () => {
    const result = await shell({ command: 'echo hello' });
    expect(result.isError).toBe(false);
    expect(result.output.trim()).toBe('hello');
  });

  it('captures stderr as well', async () => {
    const result = await shell({ command: 'node -e console.error("err_output")' });
    expect(result.output).toContain('err_output');
  });

  it('rejects path traversal in cwd', async () => {
    const result = await shell({ command: 'echo hi', cwd: '../../etc' }, '/tmp/safe');
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/path traversal|escapes base path/);
  });

  it('rejects cwd that escapes base path', async () => {
    // absolute path that starts differently than baseCwd
    const result = await shell({ command: 'echo hi', cwd: '/other/path' }, '/tmp/base');
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/escapes base path/);
  });

  it('returns error on unknown command', async () => {
    const result = await shell({ command: 'nonexistent-command-xyz' });
    expect(result.isError).toBe(true);
  });

  it('kills process on timeout', async () => {
    vi.useFakeTimers();

    // start the shell call but don't await yet
    const resultPromise = shell({ command: 'sleep 100' });

    // advance past 30s timeout
    vi.advanceTimersByTime(31_000);

    const result = await resultPromise;
    expect(result.isError).toBe(true);

    vi.useRealTimers();
  }, 10_000);
});

// ---- web_search ----

describe('web_search', () => {
  it('returns formatted results', async () => {
    const result = await webSearch({ query: 'typescript generics' });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('1.');
    expect(result.output).toContain('typescript generics');
  });

  it('respects num_results', async () => {
    const result = await webSearch({ query: 'vitest', num_results: 3 });
    expect(result.isError).toBe(false);
    const lines = result.output.trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('defaults to 5 results', async () => {
    const result = await webSearch({ query: 'test' });
    const lines = result.output.trim().split('\n');
    expect(lines).toHaveLength(5);
  });

  it('caps at 10 results', async () => {
    const result = await webSearch({ query: 'test', num_results: 99 });
    const lines = result.output.trim().split('\n');
    expect(lines).toHaveLength(10);
  });
});

// ---- PermissionGuard ----

describe('PermissionGuard', () => {
  let store: Store;
  let guard: PermissionGuard;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store();
    guard = new PermissionGuard(store, ['file_read', 'shell']);
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it('returns allowed for tools in the allow-list', () => {
    expect(guard.check('agent-1', 'file_read')).toBe('allowed');
    expect(guard.check('agent-1', 'shell')).toBe('allowed');
  });

  it('returns prompt for unknown tools', () => {
    expect(guard.check('agent-1', 'web_search')).toBe('prompt');
    expect(guard.check('agent-1', 'file_write')).toBe('prompt');
  });

  it('addToAllowList makes tool allowed', () => {
    expect(guard.check('agent-1', 'web_search')).toBe('prompt');
    guard.addToAllowList('web_search');
    expect(guard.check('agent-1', 'web_search')).toBe('allowed');
  });

  it('requestApproval creates a pending approval in the store', () => {
    store.initAgent('agent-1', 'coder');
    guard.requestApproval('agent-1', 'web_search', 'query: vitest');

    const state = store.getState();
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals[0]?.toolName).toBe('web_search');
    expect(state.pendingApprovals[0]?.inputSummary).toBe('query: vitest');
    expect(state.pendingApprovals[0]?.agentId).toBe('agent-1');
  });

  it('approval promise resolves when store resolves with approve', async () => {
    store.initAgent('agent-1', 'coder');
    const promise = guard.requestApproval('agent-1', 'web_search', 'test');

    const state = store.getState();
    const approval = state.pendingApprovals[0]!;
    store.resolvePendingApproval(approval.id, 'approve');

    const decision = await promise;
    expect(decision).toBe('approve');
  });

  it('approval promise resolves with deny when denied', async () => {
    store.initAgent('agent-1', 'coder');
    const promise = guard.requestApproval('agent-1', 'shell', 'rm -rf /tmp/test');

    const state = store.getState();
    const approval = state.pendingApprovals[0]!;
    store.resolvePendingApproval(approval.id, 'deny');

    const decision = await promise;
    expect(decision).toBe('deny');
  });

  it('pending approval is removed from store after resolution', async () => {
    store.initAgent('agent-1', 'coder');
    const promise = guard.requestApproval('agent-1', 'web_search', 'test');

    const state = store.getState();
    const approval = state.pendingApprovals[0]!;
    store.resolvePendingApproval(approval.id, 'approve');

    await promise;
    expect(store.getState().pendingApprovals).toHaveLength(0);
  });
});
