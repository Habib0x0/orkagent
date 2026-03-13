## Feature Brief: Orkagent

### Problem Statement
Managing multiple AI agents today means juggling terminal windows with zero unified visibility, no coordination, and no way to define reusable agent team topologies. There's no "command center" for agent orchestration.

### Proposed Solution
A TypeScript CLI/TUI tool that lets you define agent teams in YAML, launch them with a single command, observe/interact with all agents from a single terminal, enable agent-to-agent communication, sandbox tool access, support plugins, and share/fork agent topologies.

### Key Behaviors
- Split-pane TUI showing live output from multiple agents simultaneously
- Multi-provider support (Claude, OpenAI, Ollama/local models) via adapter pattern
- Focus switching and message routing to any active agent
- Status bar with agent state (running/idle/done/error), token usage, and cost tracking
- Declarative `agents.yaml` team definitions with `orkagent up` to launch
- Agent-to-agent pub/sub communication via `watches` and `depends_on`
- Per-agent tool sandboxing with explicit permissions
- Plugin system for custom providers, tools, and hooks
- Save, share, and fork agent team topologies as templates

### User Roles
- **Solo developer**: Runs multiple agents in parallel, monitors from one screen
- **Team lead**: Defines reusable agent team templates for common workflows
- **Plugin author**: Extends orkagent with custom providers, tools, or integrations
- **Community member**: Browses and forks published agent topologies

### Phased Delivery

**Phase 1 -- Core Foundation**
- TUI with split-pane live streaming (Ink)
- Multi-provider adapters (Claude, OpenAI, Ollama)
- `agents.yaml` config with Zod validation
- Focus switching, message routing
- Status bar with state, tokens, cost

**Phase 2 -- Agent Communication**
- Pub/sub via `watches` in agents.yaml
- Sequenced launches via `depends_on`
- Shared context injection via `context_from`
- Event bus for inter-agent message passing

**Phase 3 -- Tool Sandboxing**
- Unified tool layer (file, shell, web) across providers
- Per-agent permission declarations in agents.yaml
- Approval prompts for dangerous operations
- Isolation boundaries so agents can't interfere with each other

**Phase 4 -- Plugin System**
- Plugin API for custom providers, tools, and hooks
- Lifecycle hooks (onAgentStart, onMessage, onError, etc.)
- Plugin discovery and loading from node_modules or local paths
- Plugin manifest schema

**Phase 5 -- Forking & Template Marketplace**
- Save agent topologies as shareable templates
- `orkagent fork <template>` to clone and customize
- Registry for publishing/discovering templates
- Versioned templates with dependency tracking

### Expert Analysis

#### Software Architect
- **Key Concerns**: Provider abstraction must normalize streaming, tool calls, and token reporting. Batched TUI renders (50-100ms) essential for multi-agent performance. Per-agent error boundaries prevent cascade failures.
- **Recommendations**: Adapter pattern with normalized `StreamEvent` iterables. Single centralized store. Supervised `AgentRunner` per agent. Zod config validation at startup. ~6 core files for Phase 1, growing modularly per phase.
- **Design Constraints**: Orchestrator never imports provider SDKs directly. Components are pure display. Config fails fast before SDK calls.

### Open Questions
- Keybinding scheme: vim-style, tmux-style, or custom?
- Template registry: self-hosted, npm-based, or dedicated service?
- Plugin security: how to prevent malicious plugins from breaking sandboxing?
- Should `watches` trigger on all output or only on specific event types?

### Codebase Context
- Greenfield TypeScript project, distributed via npm
- Core deps: Ink, Anthropic SDK, OpenAI SDK, Zod
- Minimal engineering approach, growing modularly per phase

### Inspiration
- Andrej Karpathy's "bigger IDE" thread (Mar 11, 2026) -- agent command center concept
- Name: Ork (Orchestrate) + Ka (Karpathy) + gent (agent)
