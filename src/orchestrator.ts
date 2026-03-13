// Orchestrator -- agent lifecycle management and coordination
// Implementation: T-9, T-37

import { readFileSync, writeFileSync } from 'fs';
import type { Config, AgentConfig } from './config.js';
import type { Store } from './store.js';
import { AgentRunner } from './runner.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { OpenAIAdapter } from './providers/openai.js';
import { OllamaAdapter } from './providers/ollama.js';
import type { AgentProvider, Message } from './providers/types.js';
import { HookRegistry } from './hooks.js';
import { ToolRegistry } from './tools/registry.js';
import { PermissionGuard } from './tools/permission.js';
import * as fileTool from './tools/builtin/file.js';
import * as shellTool from './tools/builtin/shell.js';
import * as webTool from './tools/builtin/web.js';
import { loadPlugins } from './plugins/loader.js';
import { EventBus } from './eventbus.js';

// Rough pricing estimates in USD per token
const PRICING: Record<string, { input: number; output: number }> = {
  // anthropic models
  'claude-opus-4-5': { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  'claude-sonnet-4-5': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-haiku-3-5': { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  'claude-3-opus': { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  'claude-3-sonnet': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-3-haiku': { input: 0.25 / 1_000_000, output: 1.25 / 1_000_000 },
  // openai models
  'gpt-4o': { input: 5 / 1_000_000, output: 15 / 1_000_000 },
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  'gpt-4-turbo': { input: 10 / 1_000_000, output: 30 / 1_000_000 },
  'gpt-3.5-turbo': { input: 0.5 / 1_000_000, output: 1.5 / 1_000_000 },
  // ollama -- local, no cost
  _ollama_default: { input: 0, output: 0 },
  // fallback
  _default: { input: 3 / 1_000_000, output: 15 / 1_000_000 },
};

function pricingFor(provider: string, model: string): { input: number; output: number } {
  if (PRICING[model]) return PRICING[model];
  if (provider === 'ollama') return PRICING['_ollama_default']!;
  return PRICING['_default']!;
}

export function computeCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = pricingFor(provider, model);
  return p.input * inputTokens + p.output * outputTokens;
}

function createProvider(agentId: string, agentConfig: AgentConfig): AgentProvider {
  const { provider, model } = agentConfig;

  switch (provider) {
    case 'anthropic':
      return new AnthropicAdapter({
        apiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
        model,
        agentId,
      });

    case 'openai':
      return new OpenAIAdapter({
        apiKey: process.env['OPENAI_API_KEY'] ?? '',
        model,
        agentId,
        baseURL: agentConfig.base_url,
      });

    case 'ollama':
      return new OllamaAdapter({ model, agentId });

    default: {
      // TypeScript narrowing -- this should be unreachable given the Zod schema
      const exhaustive: never = provider;
      throw new Error(`Unknown provider: ${String(exhaustive)}`);
    }
  }
}

interface SessionData {
  agents: Record<string, { history: Message[] }>;
}

export class Orchestrator {
  private runners = new Map<string, AgentRunner>();
  private providers = new Map<string, AgentProvider>();
  private hookRegistry = new HookRegistry();
  private toolRegistry = new ToolRegistry();
  private eventBus = new EventBus();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  async start(sessionPath?: string): Promise<void> {
    let savedSession: SessionData | null = null;

    if (sessionPath) {
      savedSession = this.readSession(sessionPath);
    }

    // register built-in tools
    const cwd = process.cwd();
    fileTool.register(this.toolRegistry, cwd);
    shellTool.register(this.toolRegistry, cwd);
    webTool.register(this.toolRegistry);

    // load plugins before creating any runners
    const pluginResult = await loadPlugins(this.config, this.toolRegistry, this.hookRegistry);
    for (const w of pluginResult.warnings) {
      // use a synthetic agent store entry keyed to '_system' if available,
      // otherwise just log -- we don't abort startup on plugin load failure
      this.store.appendOutput('_system', `[plugin] warning: failed to load "${w.name}": ${w.error}`);
    }

    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      const provider = createProvider(agentId, agentConfig);
      this.providers.set(agentId, provider);

      // create a per-agent permission guard from its declared tools allow-list
      const guard = new PermissionGuard(this.store, agentConfig.tools ?? []);

      const runner = new AgentRunner(
        agentId,
        agentConfig,
        provider,
        this.store,
        this.hookRegistry,
        this.eventBus,
        this.toolRegistry,
        guard,
      );

      // restore history if we have a saved session
      if (savedSession?.agents[agentId]) {
        const saved = savedSession.agents[agentId];
        if (saved) {
          const history = runner.getHistory();
          history.push(...saved.history);
        }
      }

      this.runners.set(agentId, runner);
      this.store.initAgent(agentId, agentId);
    }

    // wire up cost tracking via store change events
    this.store.on('change', () => this.updateCosts());

    // start runners, respecting depends_on and context_from sequencing
    const startPromises = Array.from(this.runners.entries()).map(([agentId, runner]) => {
      const agentConfig = this.config.agents[agentId]!;
      const deps = agentConfig.depends_on ?? [];
      const contextSources = agentConfig.context_from ?? [];

      // wait for both deps and context_from sources before launching
      const allPreds = [...new Set([...deps, ...contextSources])];

      const launchRunner = async () => {
        if (contextSources.length > 0) {
          const parts = contextSources.map((srcId) => {
            const entry = this.store.getAgent(srcId);
            return entry ? entry.outputBuffer.join('\n') : '';
          }).filter((s) => s.length > 0);

          if (parts.length > 0) {
            const contextBlock = parts.join('\n\n');
            const history = runner.getHistory();
            const sysIdx = history.findIndex((m) => m.role === 'system');
            if (sysIdx >= 0) {
              history[sysIdx] = {
                ...history[sysIdx]!,
                content: `${history[sysIdx]!.content}\n\n${contextBlock}`,
              };
            } else {
              history.unshift({ role: 'system', content: contextBlock });
            }
          }
        }
        return runner.start();
      };

      if (allPreds.length === 0) {
        return launchRunner();
      }
      return this.waitForDeps(allPreds).then(launchRunner);
    });
    await Promise.all(startPromises);
  }

  // Resolves once all listed dep agent ids have reached 'idle' or 'done'.
  private waitForDeps(depIds: string[]): Promise<void> {
    return new Promise((resolve) => {
      const ready = () =>
        depIds.every((id) => {
          const s = this.store.getAgent(id)?.state;
          return s === 'idle' || s === 'done';
        });

      if (ready()) {
        resolve();
        return;
      }

      const check = () => {
        if (ready()) {
          this.store.off('change', check);
          resolve();
        }
      };
      this.store.on('change', check);
    });
  }

  stopAgent(id: string): void {
    const runner = this.runners.get(id);
    if (!runner) return;
    runner.abort();
    // abort() already transitions to 'done' in the runner, but be explicit
    this.store.updateAgentState(id, 'done');
  }

  async restartAgent(id: string): Promise<void> {
    const agentConfig = this.config.agents[id];
    if (!agentConfig) return;

    // stop existing runner
    const existing = this.runners.get(id);
    if (existing) {
      existing.abort();
    }

    // create fresh provider + runner
    const provider = createProvider(id, agentConfig);
    this.providers.set(id, provider);

    const guard = new PermissionGuard(this.store, agentConfig.tools ?? []);
    const runner = new AgentRunner(
      id,
      agentConfig,
      provider,
      this.store,
      this.hookRegistry,
      this.eventBus,
      this.toolRegistry,
      guard,
    );
    this.runners.set(id, runner);

    // reset state for a clean restart
    this.store.initAgent(id, id);

    await runner.start();
  }

  getRunners(): Map<string, AgentRunner> {
    return this.runners;
  }

  getHookRegistry(): HookRegistry {
    return this.hookRegistry;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  saveSession(path: string): void {
    const data: SessionData = { agents: {} };

    for (const [agentId, runner] of this.runners.entries()) {
      data.agents[agentId] = { history: runner.getHistory() };
    }

    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  }

  loadSession(path: string): void {
    const session = this.readSession(path);
    if (!session) return;

    for (const [agentId, agentData] of Object.entries(session.agents)) {
      const runner = this.runners.get(agentId);
      if (!runner) continue;
      const history = runner.getHistory();
      // clear and repopulate
      history.length = 0;
      history.push(...agentData.history);
    }
  }

  private readSession(path: string): SessionData | null {
    try {
      const raw = readFileSync(path, 'utf8');
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  private updateCosts(): void {
    let sessionTotal = 0;

    for (const [agentId, entry] of Object.entries(this.store.getAllAgents())) {
      const agentConfig = this.config.agents[agentId];
      if (!agentConfig) continue;

      const cost = computeCost(
        agentConfig.provider,
        agentConfig.model,
        entry.tokens.input,
        entry.tokens.output,
      );
      entry.cost = cost;
      sessionTotal += cost;

      // pause the agent if it exceeds its own max_cost
      if (agentConfig.max_cost !== undefined && cost > agentConfig.max_cost) {
        const runner = this.runners.get(agentId);
        if (runner && entry.state !== 'paused') {
          runner.pause();
        }
      }
    }

    // pause all agents if the session-wide limit is exceeded
    const sessionMaxCost = this.config.session?.max_cost;
    if (sessionMaxCost !== undefined && sessionTotal > sessionMaxCost) {
      for (const [agentId, runner] of this.runners.entries()) {
        const entry = this.store.getAgent(agentId);
        if (entry && entry.state !== 'paused') {
          runner.pause();
        }
      }
    }
  }
}
