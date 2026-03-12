// Template manifest schema
import { z } from 'zod';

const semver = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

// env var names: uppercase letters, digits, underscores
const envVarName = /^[A-Z][A-Z0-9_]*$/;

// reject values that look like actual secrets
const secretPatterns = [/^sk-/, /^ant-/];

export const TemplateManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(semver, 'version must be valid semver'),
  description: z.string().min(1),
  author: z.string().optional(),
  repository: z.string().optional(),
  requiredEnvVars: z
    .array(
      z.string()
        .regex(envVarName, 'env var names must be uppercase letters, digits, and underscores')
        .refine(
          v => !secretPatterns.some(p => p.test(v)),
          'env var value looks like a real secret -- store the name, not the value',
        ),
    )
    .default([]),
  dependencies: z
    .object({
      plugins: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
