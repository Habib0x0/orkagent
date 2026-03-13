import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';

// Zod schemas

export const AgentConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'ollama']),
  model: z.string().min(1),
  base_url: z.string().url().optional(),
  system: z.string().optional(),
  // Phase 2: inter-agent communication
  watches: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  context_from: z.array(z.string()).optional(),
  // Phase 3: tool sandboxing
  tools: z.array(z.string()).optional(),
  tools_mode: z.enum(['unified', 'native']).optional(),
  remote: z
    .object({
      host: z.string().min(1),
      user: z.string().min(1),
      key: z.string().optional(),
      port: z.number().int().positive().optional(),
    })
    .optional(),
  max_cost: z.number().positive().optional(),
  max_restarts: z.number().int().nonnegative().default(3),
});

export const TeamConfigSchema = z.object({
  agents: z.array(z.string()).min(1),
});

export const PluginRefSchema = z.object({
  name: z.string().min(1),
  path: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});

export const ConfigSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), AgentConfigSchema),
  teams: z.record(z.string(), TeamConfigSchema).optional(),
  plugins: z.array(PluginRefSchema).optional(),
  session: z
    .object({
      max_cost: z.number().positive().optional(),
      resume: z.boolean().optional(),
    })
    .optional(),
});

// Exported types

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type TeamConfig = z.infer<typeof TeamConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// API key env var per provider
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  // ollama needs no key
};

export interface ConfigIssue {
  path: string;
  expected: string;
  received: unknown;
}

export class ConfigValidationError extends Error {
  issues: ConfigIssue[];

  constructor(message: string, issues: ConfigIssue[]) {
    super(message);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

function zodPathToString(path: (string | number)[]): string {
  return path
    .map((segment, i) =>
      typeof segment === 'number'
        ? `[${segment}]`
        : i === 0
        ? segment
        : `.${segment}`
    )
    .join('');
}

// DFS-based cycle detection over the depends_on graph.
// Throws ConfigValidationError listing all agents in any detected cycle.
function validateDependencyGraph(agents: Record<string, AgentConfig>): void {
  // white=0, gray=1 (in stack), black=2 (done)
  const color = new Map<string, 0 | 1 | 2>();
  for (const id of Object.keys(agents)) {
    color.set(id, 0);
  }

  const visit = (id: string, stack: string[]): string[] | null => {
    color.set(id, 1);
    stack.push(id);

    for (const dep of agents[id]?.depends_on ?? []) {
      const depColor = color.get(dep);
      if (depColor === 1) {
        // cycle found -- extract the cycle portion from stack
        const cycleStart = stack.indexOf(dep);
        return stack.slice(cycleStart);
      }
      if (depColor === 0) {
        const cycle = visit(dep, stack);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    color.set(id, 2);
    return null;
  };

  for (const id of Object.keys(agents)) {
    if (color.get(id) === 0) {
      const cycle = visit(id, []);
      if (cycle) {
        const names = cycle.join(' -> ');
        const issues: ConfigIssue[] = cycle.map((name) => ({
          path: `agents.${name}.depends_on`,
          expected: 'acyclic dependency graph',
          received: 'cycle',
        }));
        throw new ConfigValidationError(
          `circular dependency detected: ${names}`,
          issues,
        );
      }
    }
  }
}

export function loadConfig(filePath: string): Config {
  // Read file -- synchronous as required by NFR-2
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new ConfigValidationError(`no config found at "${filePath}"`, [
      { path: '', expected: 'readable file', received: 'missing file' },
    ]);
  }

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`invalid YAML: ${msg}`, [
      { path: '', expected: 'valid YAML', received: 'parse error' },
    ]);
  }

  // Zod validation
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
      path: zodPathToString(issue.path as (string | number)[]),
      expected: issue.message,
      received: issue.code === 'invalid_type' ? (issue as z.ZodInvalidTypeIssue).received : 'invalid value',
    }));
    const summary = issues.map((i) => `  ${i.path}: ${i.expected} (got: ${String(i.received)})`).join('\n');
    throw new ConfigValidationError(`config validation failed:\n${summary}`, issues);
  }

  const config = result.data;

  // Check for circular dependencies in depends_on graph
  validateDependencyGraph(config.agents);

  // Validate that required API keys exist as env vars
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    const envVar = PROVIDER_ENV_VARS[agentConfig.provider];
    if (envVar && !process.env[envVar] && !agentConfig.base_url) {
      throw new ConfigValidationError(
        `agent "${agentName}" requires ${envVar} to be set`,
        [{ path: `agents.${agentName}.provider`, expected: `env var ${envVar} to be set`, received: 'not set' }]
      );
    }
  }

  return config;
}
