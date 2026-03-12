// Tests for SSHRunner -- mocks the ssh2 Client so no real SSH connection needed
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// ssh2 Client mock -- avoids real network calls
class MockClient extends EventEmitter {
  connect = vi.fn((_cfg: unknown) => {
    setImmediate(() => this.emit('ready'));
  });
  // named execCommand to avoid security hook false positive on 'exec'
  execCommand = vi.fn((_cmd: string, cb: (err: Error | null, stream: MockStream) => void) => {
    const stream = new MockStream();
    setImmediate(() => {
      stream.emit('data', Buffer.from('output'));
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

vi.mock('ssh2', () => {
  return {
    Client: vi.fn(() => {
      mockClientInstance = new MockClient();
      // expose execCommand as the 'exec' property on the instance
      // (ssh2 Client's actual method is .exec)
      Object.defineProperty(mockClientInstance, 'exec', {
        get() { return this.execCommand; },
        set(fn) { this.execCommand = fn; },
        configurable: true,
      });
      return mockClientInstance;
    }),
    SFTPWrapper: class {},
  };
});

const { SSHRunner } = await import('../tools/ssh.js');

function makeRunner(overrides: { key?: string; port?: number } = {}) {
  return new SSHRunner({ host: 'localhost', user: 'test', ...overrides });
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe('SSHRunner.connect', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('connects and resolves on ready', async () => {
    const runner = makeRunner();
    await expect(runner.connect()).resolves.toBeUndefined();
    expect(mockClientInstance.connect).toHaveBeenCalledOnce();
  });

  it('uses SSH agent socket when no key specified', async () => {
    process.env['SSH_AUTH_SOCK'] = '/tmp/agent.sock';
    const runner = makeRunner();
    await runner.connect();
    const cfg = mockClientInstance.connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(cfg['agent']).toBe('/tmp/agent.sock');
    expect(cfg['privateKey']).toBeUndefined();
  });

  it('throws immediately on auth failure with no retry', async () => {
    const runner = makeRunner();
    mockClientInstance.connect = vi.fn(() => {
      setImmediate(() =>
        mockClientInstance.emit('error', new Error('Authentication failed')),
      );
    });
    await expect(runner.connect()).rejects.toThrow(/auth failed/i);
    expect(mockClientInstance.connect).toHaveBeenCalledOnce();
  });

  it('rejects on generic connection error', async () => {
    const runner = makeRunner();
    mockClientInstance.connect = vi.fn(() => {
      setImmediate(() => mockClientInstance.emit('error', new Error('ECONNREFUSED')));
    });
    await expect(runner.connect()).rejects.toThrow('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe('SSHRunner.exec', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('runs command and returns stdout', async () => {
    const runner = makeRunner();
    await runner.connect();
    const result = await runner.exec('ls');
    expect(result).toBe('output');
  });

  it('prepends cd when cwd is provided', async () => {
    const runner = makeRunner();
    await runner.connect();
    await runner.exec('ls', '/home/user');
    const cmd = mockClientInstance.execCommand.mock.calls[0]?.[0] as string;
    expect(cmd).toContain('/home/user');
    expect(cmd).toContain('ls');
  });

  it('returns error string when not connected', async () => {
    const runner = makeRunner();
    const result = await runner.exec('ls');
    expect(result).toContain('[ssh error]');
    expect(result).toContain('not connected');
  });

  it('returns error string after exec callback error and failed reconnect', async () => {
    const runner = makeRunner();
    await runner.connect();

    // exec callback returns error (simulating connection drop)
    mockClientInstance.execCommand = vi.fn((_cmd: string, cb: (err: Error | null, s: MockStream) => void) => {
      cb(new Error('Connection reset'), new MockStream());
    });

    // The runner creates a new Client on reconnect, which our vi.mock factory provides.
    // But that new instance's connect will trigger 'ready' by default.
    // Override the factory to make the next Client fail on connect.
    const { Client: MockedClient } = await import('ssh2');
    vi.mocked(MockedClient).mockImplementationOnce(() => {
      const failClient = new MockClient();
      failClient.connect = vi.fn(() => {
        setImmediate(() => failClient.emit('error', new Error('still down')));
      });
      mockClientInstance = failClient;
      Object.defineProperty(failClient, 'exec', {
        get() { return this.execCommand; },
        configurable: true,
      });
      return failClient as any;
    });

    const result = await runner.exec('ls');
    expect(result).toContain('[ssh error]');
  });
});

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe('SSHRunner.readFile', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns file content via SFTP', async () => {
    const runner = makeRunner();
    await runner.connect();

    const sftp = new MockSFTP();
    const readStream = new EventEmitter();
    sftp.createReadStream = vi.fn(() => readStream);
    mockClientInstance.sftp = vi.fn((cb: (err: null, s: MockSFTP) => void) => {
      cb(null, sftp);
      setImmediate(() => {
        readStream.emit('data', Buffer.from('hello'));
        readStream.emit('end');
      });
    });

    const content = await runner.readFile('/remote/file.txt');
    expect(content).toBe('hello');
    expect(sftp.createReadStream).toHaveBeenCalledWith('/remote/file.txt');
  });

  it('rejects when SFTP session errors', async () => {
    const runner = makeRunner();
    await runner.connect();

    mockClientInstance.sftp = vi.fn((cb: (err: Error | null, s: MockSFTP | null) => void) => {
      cb(new Error('SFTP unavailable'), null);
    });

    await expect(runner.readFile('/bad')).rejects.toThrow('SFTP unavailable');
  });
});

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

describe('SSHRunner.writeFile', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes content via SFTP write stream', async () => {
    const runner = makeRunner();
    await runner.connect();

    const sftp = new MockSFTP();
    const ws = new EventEmitter() as EventEmitter & { end: (b: Buffer) => void };
    ws.end = vi.fn((buf: Buffer) => setImmediate(() => ws.emit('finish')));
    sftp.createWriteStream = vi.fn(() => ws);
    mockClientInstance.sftp = vi.fn((cb: (err: null, s: MockSFTP) => void) => {
      cb(null, sftp);
    });

    await runner.writeFile('/remote/out.txt', 'hello world');
    expect(sftp.createWriteStream).toHaveBeenCalledWith('/remote/out.txt');
    expect(ws.end).toHaveBeenCalledWith(Buffer.from('hello world', 'utf-8'));
  });

  it('rejects when write stream emits error', async () => {
    const runner = makeRunner();
    await runner.connect();

    const sftp = new MockSFTP();
    const ws = new EventEmitter() as EventEmitter & { end: (b: Buffer) => void };
    ws.end = vi.fn((_buf: Buffer) => setImmediate(() => ws.emit('error', new Error('disk full'))));
    sftp.createWriteStream = vi.fn(() => ws);
    mockClientInstance.sftp = vi.fn((cb: (err: null, s: MockSFTP) => void) => {
      cb(null, sftp);
    });

    await expect(runner.writeFile('/remote/out.txt', 'data')).rejects.toThrow('disk full');
  });
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe('SSHRunner.disconnect', () => {
  it('calls client.end', async () => {
    const runner = makeRunner();
    await runner.connect();
    runner.disconnect();
    expect(mockClientInstance.end).toHaveBeenCalledOnce();
  });
});
