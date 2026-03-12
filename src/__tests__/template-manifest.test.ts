import { describe, it, expect } from 'vitest';
import { TemplateManifestSchema } from '../templates/manifest.js';

const base = {
  name: 'my-template',
  version: '1.0.0',
  description: 'A sample template',
};

describe('TemplateManifestSchema', () => {
  it('accepts a minimal valid manifest', () => {
    const result = TemplateManifestSchema.parse(base);
    expect(result.requiredEnvVars).toEqual([]);
  });

  it('accepts optional fields', () => {
    const result = TemplateManifestSchema.parse({
      ...base,
      author: 'Alice',
      repository: 'https://github.com/alice/my-template',
      requiredEnvVars: ['OPENAI_API_KEY', 'DATABASE_URL'],
      dependencies: { plugins: { 'my-plugin': '^1.0.0' } },
    });
    expect(result.author).toBe('Alice');
    expect(result.requiredEnvVars).toHaveLength(2);
  });

  it('rejects invalid semver', () => {
    expect(() => TemplateManifestSchema.parse({ ...base, version: '1.2' })).toThrow();
  });

  it('rejects lowercase env var names', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...base, requiredEnvVars: ['openai_key'] }),
    ).toThrow();
  });

  it('rejects env var names starting with digit', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...base, requiredEnvVars: ['1_BAD'] }),
    ).toThrow();
  });

  it('accepts valid env var names', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...base, requiredEnvVars: ['MY_KEY', 'API_KEY_2'] }),
    ).not.toThrow();
  });

  it('rejects values that look like sk- secrets', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...base, requiredEnvVars: ['sk-abc123'] }),
    ).toThrow();
  });

  it('rejects values that look like ant- secrets', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...base, requiredEnvVars: ['ant-xyz'] }),
    ).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => TemplateManifestSchema.parse({ ...base, name: '' })).toThrow();
  });

  it('rejects empty description', () => {
    expect(() => TemplateManifestSchema.parse({ ...base, description: '' })).toThrow();
  });

  it('accepts semver with build metadata', () => {
    expect(() =>
      TemplateManifestSchema.parse({ ...base, version: '1.0.0+build.1' }),
    ).not.toThrow();
  });

  it('allows missing dependencies entirely', () => {
    const result = TemplateManifestSchema.parse(base);
    expect(result.dependencies).toBeUndefined();
  });
});
