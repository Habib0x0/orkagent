import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, ConfigValidationError } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(__dirname, '../../test-fixtures');

function fixture(name: string) {
  return path.join(fixtures, name);
}

// Helper to create and auto-clean a temp fixture
function withTempFixture(name: string, content: string, fn: (p: string) => void) {
  const tmpPath = path.join(fixtures, name);
  writeFileSync(tmpPath, content);
  try {
    fn(tmpPath);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* already gone */ }
  }
}

describe('loadConfig', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedEnv.ANTHROPIC_API_KEY !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (savedEnv.OPENAI_API_KEY !== undefined) {
      process.env.OPENAI_API_KEY = savedEnv.OPENAI_API_KEY;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('loads a valid config cleanly', () => {
    // valid.yaml uses ollama -- no API key needed
    const config = loadConfig(fixture('valid.yaml'));

    expect(config.version).toBe(1);
    expect(config.agents).toHaveProperty('researcher');
    expect(config.agents).toHaveProperty('coder');
    expect(config.agents.researcher.provider).toBe('ollama');
    expect(config.agents.researcher.model).toBe('llama3.2');
    expect(config.agents.researcher.max_restarts).toBe(5);
    expect(config.agents.coder.tools).toEqual(['file_read', 'file_write']);
    expect(config.agents.coder.tools_mode).toBe('unified');
    expect(config.teams?.default.agents).toEqual(['researcher', 'coder']);
    expect(config.session?.max_cost).toBe(10.0);
  });

  it('applies default max_restarts of 3 when not specified', () => {
    const config = loadConfig(fixture('valid.yaml'));
    // coder agent does not specify max_restarts
    expect(config.agents.coder.max_restarts).toBe(3);
  });

  it('throws ConfigValidationError with "no config found" for a missing file', () => {
    let caught: unknown;
    try {
      loadConfig('/nonexistent/path/agents.yaml');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect((caught as ConfigValidationError).message).toContain('no config found');
  });

  it('throws ConfigValidationError with path and received value on Zod failure', () => {
    let caught: unknown;
    try {
      loadConfig(fixture('invalid.yaml'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const e = caught as ConfigValidationError;
    expect(e.issues.length).toBeGreaterThan(0);
    const providerIssue = e.issues.find((i) => i.path.includes('provider'));
    expect(providerIssue).toBeDefined();
    expect(providerIssue?.path).toContain('provider');
  });

  it('throws ConfigValidationError identifying agent name and env var when API key is missing', () => {
    withTempFixture(
      '_tmp_anthropic.yaml',
      'version: 1\nagents:\n  myagent:\n    provider: anthropic\n    model: claude-3-5-sonnet-20241022\n',
      (tmpPath) => {
        let caught: unknown;
        try {
          loadConfig(tmpPath);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ConfigValidationError);
        const e = caught as ConfigValidationError;
        expect(e.message).toContain('myagent');
        expect(e.message).toContain('ANTHROPIC_API_KEY');
        // Must not contain an actual API key value
        expect(e.message).not.toMatch(/sk-[a-zA-Z0-9]/);
      }
    );
  });

  it('succeeds when anthropic agent has its API key set', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-value';
    withTempFixture(
      '_tmp_anthropic_ok.yaml',
      'version: 1\nagents:\n  myagent:\n    provider: anthropic\n    model: claude-3-5-sonnet-20241022\n',
      (tmpPath) => {
        const config = loadConfig(tmpPath);
        expect(config.agents.myagent.provider).toBe('anthropic');
      }
    );
  });

  it('rejects a config with an invalid version', () => {
    withTempFixture(
      '_tmp_badversion.yaml',
      'version: 2\nagents:\n  a:\n    provider: ollama\n    model: llama3\n',
      (tmpPath) => {
        let caught: unknown;
        try {
          loadConfig(tmpPath);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ConfigValidationError);
      }
    );
  });

  it('rejects an unknown provider value with a path in the issue', () => {
    withTempFixture(
      '_tmp_badprovider.yaml',
      'version: 1\nagents:\n  a:\n    provider: gemini\n    model: gemini-pro\n',
      (tmpPath) => {
        let caught: unknown;
        try {
          loadConfig(tmpPath);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ConfigValidationError);
        const e = caught as ConfigValidationError;
        const issue = e.issues.find((i) => i.path.includes('provider'));
        expect(issue).toBeDefined();
      }
    );
  });
});
