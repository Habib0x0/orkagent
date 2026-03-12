import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// Mock template modules so no real FS/network calls happen
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

// Build a minimal program with just the template commands (mirrors src/index.ts wiring)
function buildProgram() {
  const p = new Command();
  p.exitOverride(); // prevent process.exit during tests

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

describe('CLI template command registration', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = buildProgram();
  });

  it('has a save command registered', () => {
    const cmd = program.commands.find((c) => c.name() === 'save');
    expect(cmd).toBeDefined();
  });

  it('has a publish command registered', () => {
    const cmd = program.commands.find((c) => c.name() === 'publish');
    expect(cmd).toBeDefined();
  });

  it('has a fork command registered', () => {
    const cmd = program.commands.find((c) => c.name() === 'fork');
    expect(cmd).toBeDefined();
  });

  it('has a templates subcommand group registered', () => {
    const cmd = program.commands.find((c) => c.name() === 'templates');
    expect(cmd).toBeDefined();
  });

  it('templates group has a search subcommand', () => {
    const templates = program.commands.find((c) => c.name() === 'templates');
    const search = templates?.commands.find((c) => c.name() === 'search');
    expect(search).toBeDefined();
  });
});

describe('CLI template argument parsing', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = buildProgram();
  });

  it('save passes name and default file to saveTemplate', async () => {
    await program.parseAsync(['node', 'cli', 'save', 'my-template']);
    expect(saveTemplate).toHaveBeenCalledWith('my-template', { file: 'agents.yaml', description: undefined });
  });

  it('save passes --file and --description options', async () => {
    await program.parseAsync(['node', 'cli', 'save', 'my-template', '-f', 'custom.yaml', '-d', 'A test template']);
    expect(saveTemplate).toHaveBeenCalledWith('my-template', { file: 'custom.yaml', description: 'A test template' });
  });

  it('publish passes name to publishTemplate', async () => {
    await program.parseAsync(['node', 'cli', 'publish', 'my-template']);
    expect(publishTemplate).toHaveBeenCalledWith('my-template', { registry: undefined });
  });

  it('publish passes --registry option', async () => {
    await program.parseAsync(['node', 'cli', 'publish', 'my-template', '--registry', 'https://example.com']);
    expect(publishTemplate).toHaveBeenCalledWith('my-template', { registry: 'https://example.com' });
  });

  it('fork passes repo-url to forkTemplate', async () => {
    await program.parseAsync(['node', 'cli', 'fork', 'https://github.com/org/repo.git']);
    expect(forkTemplate).toHaveBeenCalledWith('https://github.com/org/repo.git', { name: undefined });
  });

  it('fork passes --name option', async () => {
    await program.parseAsync(['node', 'cli', 'fork', 'https://github.com/org/repo.git', '--name', 'custom-name']);
    expect(forkTemplate).toHaveBeenCalledWith('https://github.com/org/repo.git', { name: 'custom-name' });
  });

  it('templates search passes query to searchTemplates', async () => {
    await program.parseAsync(['node', 'cli', 'templates', 'search', 'ollama']);
    expect(searchTemplates).toHaveBeenCalledWith('ollama', { limit: 10, registry: undefined });
  });

  it('templates search passes --limit option', async () => {
    await program.parseAsync(['node', 'cli', 'templates', 'search', 'ollama', '--limit', '5']);
    expect(searchTemplates).toHaveBeenCalledWith('ollama', { limit: 5, registry: undefined });
  });
});
