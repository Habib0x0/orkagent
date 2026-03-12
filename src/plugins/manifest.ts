// Plugin manifest schema and Zod validation
import { z } from 'zod';

const semver = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

const ProvidesSchema = z.object({
  tools: z.array(z.string()).optional(),
  providers: z.array(z.string()).optional(),
  hooks: z.array(z.string()).optional(),
});

export const PluginManifestSchema = z
  .object({
    name: z.string().min(1, 'name must not be empty'),
    version: z.string().regex(semver, 'version must be valid semver'),
    type: z.enum(['provider', 'tool', 'hook', 'mixed']),
    entry: z.string().min(1, 'entry must be a non-empty relative path'),
    provides: ProvidesSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.provides) return;
    const { type, provides } = data;

    // check that declared provides sections match the plugin type
    if (type !== 'mixed') {
      const allowed: Record<string, (keyof typeof provides)[]> = {
        provider: ['providers'],
        tool: ['tools'],
        hook: ['hooks'],
      };
      const allowedKeys = allowed[type] ?? [];
      for (const key of ['tools', 'providers', 'hooks'] as const) {
        if (provides[key] !== undefined && !allowedKeys.includes(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `plugin of type '${type}' cannot declare provides.${key}`,
            path: ['provides', key],
          });
        }
      }
    }
  });

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
