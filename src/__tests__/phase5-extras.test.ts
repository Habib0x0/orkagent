// Phase 5 extra coverage -- template marketplace edge cases
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command, CommanderError } from 'commander';
import { TemplateManifestSchema } from '../templates/manifest.js';

// ---------------------------------------------------------------------------
// Mock template modules
// ---------------------------------------------------------------------------

vi.mock('../templates/save.js', () => ({
  saveTemplate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../templates/publish.js', () => ({
  publishTemplate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../templates/fork.js', () => ({
  forkTemplate: vi.fn().mockResolvedValue('/tmp/forked'),
}));
vi.mock('../templates/search.js', () => ({
  searchTemplates: vi.fn().mockResolvedValue([]),
}));

import { saveTemplate } from '../templates/save.js';
import { publishTemplate } from '../templates/publish.js';
import { forkTemplate } from '../templates/fork.js';
import { searchTemplates } from '../templates/search.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProgram() {
  const p = new Command();
  p.exitOverride();

  p.command('save <name>')
    .option('-f, --file <path>', 'config file to save', 'agents.yaml')
    .option('-d, --description <text>', 'short description for the template')
    .action(async (name: string, opts: { file: string; description?: string }) => {
      await saveTemplate(name, { file: opts.file, description: opts.description });
    });

  p.command('publish <name>')
    .option('--registry <url>', 'registry base URL')
    .action(async (name: string, opts: { registry?: string }) => {
      await publishTemplate(name, { registry: opts.registry });
    });

  p.command('fork <repo-url>')
    .option('--name <name>', 'local directory name')
    .action(async (repoUrl: string, opts: { name?: string }) => {
      await forkTemplate(repoUrl, { name: opts.name });
    });

  const templates = p.command('templates');
  templates.command('search <query>')
    .option('--limit <n>', 'max results', '10')
    .option('--registry <url>', 'registry base URL')
    .action(async (query: string, opts: { limit: string; registry?: string }) => {
      await searchTemplates(query, { limit: parseInt(opts.limit, 10), registry: opts.registry });
    });

  return p;
}

const validManifest = {
  name: 'test-template',
  version: '1.0.0',
  description: 'A test template for phase 5',
};

// ---------------------------------------------------------------------------
// Template save edge cases
// ---------------------------------------------------------------------------

describe('save edge cases', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = buildProgram();
  });

  it('save with empty description passes undefined', async () => {
    await program.parseAsync(['node', 'cli', 'save', 'tpl']);
    expect(saveTemplate).toHaveBeenCalledWith('tpl', {
      file: 'agents.yaml',
      description: undefined,
    });
  });

  it('save with special characters in name passes them through', async () => {
    await program.parseAsync(['node', 'cli', 'save', 'my-cool_template.v2']);
    expect(saveTemplate).toHaveBeenCalledWith('my-cool_template.v2', expect.any(Object));
  });

  it('save without name argument throws commander error', async () => {
    await expect(program.parseAsync(['node', 'cli', 'save'])).rejects.toThrow();
  });

  it('saveTemplate error propagates to the caller', async () => {
    vi.mocked(saveTemplate).mockRejectedValueOnce(new Error('disk full'));
    await expect(
      program.parseAsync(['node', 'cli', 'save', 'tpl']),
    ).rejects.toThrow('disk full');
  });
});

// ---------------------------------------------------------------------------
// Template publish edge cases
// ---------------------------------------------------------------------------

describe('publish edge cases', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = buildProgram();
  });

  it('publish without required name throws commander error', async () => {
    await expect(program.parseAsync(['node', 'cli', 'publish'])).rejects.toThrow();
  });

  it('publish with custom registry URL passes it through', async () => {
    await program.parseAsync([
      'node', 'cli', 'publish', 'tpl',
      '--registry', 'https://custom.example.com/templates',
    ]);
    expect(publishTemplate).toHaveBeenCalledWith('tpl', {
      registry: 'https://custom.example.com/templates',
    });
  });

  it('publishTemplate network failure propagates', async () => {
    vi.mocked(publishTemplate).mockRejectedValueOnce(
      new Error('fetch failed: ECONNREFUSED'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'publish', 'tpl']),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('publishTemplate timeout error propagates', async () => {
    vi.mocked(publishTemplate).mockRejectedValueOnce(
      new Error('request timed out after 30000ms'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'publish', 'tpl']),
    ).rejects.toThrow('timed out');
  });
});

// ---------------------------------------------------------------------------
// Template fork edge cases
// ---------------------------------------------------------------------------

describe('fork edge cases', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = buildProgram();
  });

  it('fork without repo-url throws commander error', async () => {
    await expect(program.parseAsync(['node', 'cli', 'fork'])).rejects.toThrow();
  });

  it('fork with --name overrides derived directory name', async () => {
    await program.parseAsync([
      'node', 'cli', 'fork', 'https://github.com/org/repo.git',
      '--name', 'my-local-copy',
    ]);
    expect(forkTemplate).toHaveBeenCalledWith(
      'https://github.com/org/repo.git',
      { name: 'my-local-copy' },
    );
  });

  it('forkTemplate git clone failure propagates', async () => {
    vi.mocked(forkTemplate).mockRejectedValueOnce(
      new Error('git clone failed: repository not found'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'fork', 'https://github.com/org/bad-repo.git']),
    ).rejects.toThrow('repository not found');
  });

  it('forkTemplate network error propagates', async () => {
    vi.mocked(forkTemplate).mockRejectedValueOnce(
      new Error('unable to access: could not resolve host'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'fork', 'https://unreachable.example.com/repo.git']),
    ).rejects.toThrow('could not resolve host');
  });
});

// ---------------------------------------------------------------------------
// Template search edge cases
// ---------------------------------------------------------------------------

describe('search edge cases', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = buildProgram();
  });

  it('search without query throws commander error', async () => {
    await expect(
      program.parseAsync(['node', 'cli', 'templates', 'search']),
    ).rejects.toThrow();
  });

  it('search with --limit 0 passes zero', async () => {
    await program.parseAsync([
      'node', 'cli', 'templates', 'search', 'ollama', '--limit', '0',
    ]);
    expect(searchTemplates).toHaveBeenCalledWith('ollama', {
      limit: 0,
      registry: undefined,
    });
  });

  it('search with custom registry passes it through', async () => {
    await program.parseAsync([
      'node', 'cli', 'templates', 'search', 'gpt',
      '--registry', 'https://my-registry.io',
    ]);
    expect(searchTemplates).toHaveBeenCalledWith('gpt', {
      limit: 10,
      registry: 'https://my-registry.io',
    });
  });

  it('searchTemplates network failure propagates', async () => {
    vi.mocked(searchTemplates).mockRejectedValueOnce(
      new Error('network error: ENOTFOUND'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'templates', 'search', 'test']),
    ).rejects.toThrow('ENOTFOUND');
  });

  it('search with query containing spaces is parsed correctly', async () => {
    await program.parseAsync([
      'node', 'cli', 'templates', 'search', 'multi agent setup',
    ]);
    expect(searchTemplates).toHaveBeenCalledWith('multi agent setup', expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// CLI exit codes -- missing required arguments
// ---------------------------------------------------------------------------

describe('CLI exit codes for missing required arguments', () => {
  it('save without name exits with code other than 0', async () => {
    const p = buildProgram();
    try {
      await p.parseAsync(['node', 'cli', 'save']);
      // should not reach here
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommanderError);
      expect((err as CommanderError).exitCode).not.toBe(0);
    }
  });

  it('publish without name exits with code other than 0', async () => {
    const p = buildProgram();
    try {
      await p.parseAsync(['node', 'cli', 'publish']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommanderError);
      expect((err as CommanderError).exitCode).not.toBe(0);
    }
  });

  it('fork without repo-url exits with code other than 0', async () => {
    const p = buildProgram();
    try {
      await p.parseAsync(['node', 'cli', 'fork']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommanderError);
      expect((err as CommanderError).exitCode).not.toBe(0);
    }
  });

  it('templates search without query exits with code other than 0', async () => {
    const p = buildProgram();
    try {
      await p.parseAsync(['node', 'cli', 'templates', 'search']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommanderError);
      expect((err as CommanderError).exitCode).not.toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// API key stripping -- manifest must reject secrets
// ---------------------------------------------------------------------------

describe('API key stripping verification', () => {
  it('rejects requiredEnvVars containing sk- prefixed values', () => {
    expect(() =>
      TemplateManifestSchema.parse({
        ...validManifest,
        requiredEnvVars: ['sk-proj-abc123def456'],
      }),
    ).toThrow();
  });

  it('rejects requiredEnvVars containing ant- prefixed values', () => {
    expect(() =>
      TemplateManifestSchema.parse({
        ...validManifest,
        requiredEnvVars: ['ant-api-key-xyz'],
      }),
    ).toThrow();
  });

  it('rejects multiple entries when one is a secret', () => {
    expect(() =>
      TemplateManifestSchema.parse({
        ...validManifest,
        requiredEnvVars: ['OPENAI_API_KEY', 'sk-real-key-value'],
      }),
    ).toThrow();
  });

  it('accepts placeholder env var names without secret values', () => {
    const result = TemplateManifestSchema.parse({
      ...validManifest,
      requiredEnvVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL'],
    });
    expect(result.requiredEnvVars).toHaveLength(3);
  });

  it('rejects lowercase env var names to prevent accidental key leaks', () => {
    expect(() =>
      TemplateManifestSchema.parse({
        ...validManifest,
        requiredEnvVars: ['openai_api_key'],
      }),
    ).toThrow();
  });

  it('rejects env var names that are just numbers', () => {
    expect(() =>
      TemplateManifestSchema.parse({
        ...validManifest,
        requiredEnvVars: ['12345'],
      }),
    ).toThrow();
  });

  it('rejects env var names with mixed case', () => {
    expect(() =>
      TemplateManifestSchema.parse({
        ...validManifest,
        requiredEnvVars: ['OpenAI_Key'],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Template validation -- missing fields, invalid manifest
// ---------------------------------------------------------------------------

describe('template manifest validation -- missing and invalid fields', () => {
  it('rejects manifest with missing name', () => {
    expect(() =>
      TemplateManifestSchema.parse({ version: '1.0.0', description: 'test' }),
    ).toThrow();
  });

  it('rejects manifest with missing version', () => {
    expect(() =>
      TemplateManifestSchema.parse({ name: 'tpl', description: 'test' }),
    ).toThrow();
  });

  it('rejects manifest with missing description', () => {
    expect(() =>
      TemplateManifestSchema.parse({ name: 'tpl', version: '1.0.0' }),
    ).toThrow();
  });

  it('rejects completely empty object', () => {
    expect(() => TemplateManifestSchema.parse({})).toThrow();
  });

  it('rejects null input', () => {
    expect(() => TemplateManifestSchema.parse(null)).toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => TemplateManifestSchema.parse('not an object')).toThrow();
  });

  it('rejects invalid semver with only major.minor', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...validManifest, version: '1.0' }),
    ).toThrow();
  });

  it('rejects invalid semver with letters', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...validManifest, version: 'abc' }),
    ).toThrow();
  });

  it('accepts valid semver with prerelease', () => {
    const result = TemplateManifestSchema.parse({
      ...validManifest,
      version: '2.0.0-beta.1',
    });
    expect(result.version).toBe('2.0.0-beta.1');
  });

  it('accepts valid semver with build metadata', () => {
    const result = TemplateManifestSchema.parse({
      ...validManifest,
      version: '1.0.0+sha.abc123',
    });
    expect(result.version).toBe('1.0.0+sha.abc123');
  });

  it('rejects name with empty string', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...validManifest, name: '' }),
    ).toThrow();
  });

  it('rejects description with empty string', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...validManifest, description: '' }),
    ).toThrow();
  });

  it('accepts optional author field', () => {
    const result = TemplateManifestSchema.parse({
      ...validManifest,
      author: 'Alice',
    });
    expect(result.author).toBe('Alice');
  });

  it('accepts optional repository field', () => {
    const result = TemplateManifestSchema.parse({
      ...validManifest,
      repository: 'https://github.com/org/repo',
    });
    expect(result.repository).toBe('https://github.com/org/repo');
  });

  it('defaults requiredEnvVars to empty array when omitted', () => {
    const result = TemplateManifestSchema.parse(validManifest);
    expect(result.requiredEnvVars).toEqual([]);
  });

  it('accepts dependencies with plugins map', () => {
    const result = TemplateManifestSchema.parse({
      ...validManifest,
      dependencies: { plugins: { 'my-plugin': '^1.0.0' } },
    });
    expect(result.dependencies?.plugins?.['my-plugin']).toBe('^1.0.0');
  });

  it('accepts dependencies with empty plugins map', () => {
    const result = TemplateManifestSchema.parse({
      ...validManifest,
      dependencies: { plugins: {} },
    });
    expect(result.dependencies?.plugins).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Network failure handling -- error propagation through the CLI layer
// ---------------------------------------------------------------------------

describe('network failure propagation through CLI commands', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = buildProgram();
  });

  it('save with read error from missing file propagates', async () => {
    vi.mocked(saveTemplate).mockRejectedValueOnce(
      new Error('Cannot read config file: /nonexistent/agents.yaml'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'save', 'tpl']),
    ).rejects.toThrow('Cannot read config file');
  });

  it('publish with 401 auth error propagates', async () => {
    vi.mocked(publishTemplate).mockRejectedValueOnce(
      new Error('401 Unauthorized: invalid credentials'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'publish', 'tpl']),
    ).rejects.toThrow('401 Unauthorized');
  });

  it('publish with 500 server error propagates', async () => {
    vi.mocked(publishTemplate).mockRejectedValueOnce(
      new Error('500 Internal Server Error'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'publish', 'tpl']),
    ).rejects.toThrow('500 Internal Server Error');
  });

  it('search with 503 service unavailable propagates', async () => {
    vi.mocked(searchTemplates).mockRejectedValueOnce(
      new Error('503 Service Unavailable'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'templates', 'search', 'test']),
    ).rejects.toThrow('503 Service Unavailable');
  });

  it('fork with permission denied propagates', async () => {
    vi.mocked(forkTemplate).mockRejectedValueOnce(
      new Error('EACCES: permission denied'),
    );
    await expect(
      program.parseAsync(['node', 'cli', 'fork', 'https://github.com/org/repo.git']),
    ).rejects.toThrow('EACCES');
  });
});
