import { describe, it, expect } from 'vitest';
import { PluginManifestSchema } from '../plugins/manifest.js';

const base = {
  name: 'my-plugin',
  version: '1.0.0',
  type: 'tool' as const,
  entry: './dist/index.js',
};

describe('PluginManifestSchema', () => {
  it('accepts a minimal valid manifest', () => {
    expect(() => PluginManifestSchema.parse(base)).not.toThrow();
  });

  it('accepts a manifest with provides matching type', () => {
    const result = PluginManifestSchema.parse({
      ...base,
      provides: { tools: ['my_tool'] },
    });
    expect(result.provides?.tools).toEqual(['my_tool']);
  });

  it('rejects empty name', () => {
    expect(() => PluginManifestSchema.parse({ ...base, name: '' })).toThrow();
  });

  it('rejects invalid semver', () => {
    expect(() => PluginManifestSchema.parse({ ...base, version: '1.0' })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...base, version: 'latest' })).toThrow();
  });

  it('accepts semver with pre-release tag', () => {
    expect(() => PluginManifestSchema.parse({ ...base, version: '2.0.0-beta.1' })).not.toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => PluginManifestSchema.parse({ ...base, type: 'unknown' })).toThrow();
  });

  it('rejects tool plugin declaring providers in provides', () => {
    expect(() =>
      PluginManifestSchema.parse({
        ...base,
        type: 'tool',
        provides: { providers: ['openai'] },
      }),
    ).toThrow();
  });

  it('rejects provider plugin declaring tools in provides', () => {
    expect(() =>
      PluginManifestSchema.parse({
        ...base,
        type: 'provider',
        provides: { tools: ['some_tool'] },
      }),
    ).toThrow();
  });

  it('allows mixed plugin to declare any provides sections', () => {
    expect(() =>
      PluginManifestSchema.parse({
        ...base,
        type: 'mixed',
        provides: { tools: ['t'], providers: ['p'], hooks: ['h'] },
      }),
    ).not.toThrow();
  });

  it('rejects empty entry', () => {
    expect(() => PluginManifestSchema.parse({ ...base, entry: '' })).toThrow();
  });

  it('accepts hook type with hooks provides', () => {
    expect(() =>
      PluginManifestSchema.parse({
        ...base,
        type: 'hook',
        provides: { hooks: ['on_start'] },
      }),
    ).not.toThrow();
  });
});
