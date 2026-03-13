#!/usr/bin/env node

// CLI entry point -- arg parsing and command dispatch
// Implementation: T-14 (stub wired for T-3 config loading)

import { program } from 'commander';
import { writeFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import React from 'react';
import { render } from 'ink';
import { loadConfig, ConfigValidationError } from './config.js';
import { Store } from './store.js';
import { Orchestrator } from './orchestrator.js';
import App from './ui/App.js';
import { saveTemplate } from './templates/save.js';
import { publishTemplate } from './templates/publish.js';
import { forkTemplate } from './templates/fork.js';
import { searchTemplates } from './templates/search.js';

program
  .name('orkagent')
  .description('Agent command center CLI/TUI')
  .version('0.1.0');

program
  .command('validate')
  .description('Validate a config file without launching agents')
  .option('-f, --file <path>', 'config file path', 'agents.yaml')
  .action((opts: { file: string }) => {
    const filePath = resolve(process.cwd(), opts.file);
    try {
      loadConfig(filePath);
      console.log('Config valid');
      process.exit(0);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        console.error(err.message);
      } else {
        console.error(String(err));
      }
      process.exit(1);
    }
  });

program
  .command('up')
  .description('Launch agents from config')
  .option('-f, --file <path>', 'config file path', 'agents.yaml')
  .option('--resume', 'resume a previous session')
  .option('--plain', 'non-interactive plain output mode')
  .option('--team <name>', 'team to launch')
  .action((opts: { file: string; resume?: boolean; plain?: boolean; team?: string }) => {
    const filePath = resolve(process.cwd(), opts.file);
    let config;
    try {
      config = loadConfig(filePath);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        console.error(err.message);
      } else {
        console.error(String(err));
      }
      process.exit(1);
      return;
    }

    const store = new Store();
    const orchestrator = new Orchestrator(config, store);

    // resolve session file path for --resume support
    const sessionPath = join(process.cwd(), '.orkagent-session.json');

    // dispatch callbacks passed into the TUI
    const onRestart = (id: string) => { orchestrator.restartAgent(id).catch(() => {}); };
    const onStop = (id: string) => { orchestrator.stopAgent(id); };
    const onSendMessage = (agentId: string, text: string) => {
      const runner = orchestrator.getRunners().get(agentId);
      if (runner) runner.sendUserMessage(text);
    };

    if (opts.plain) {
      // non-interactive mode -- print new output lines as they arrive
      const printed = new Map<string, number>();
      store.on('change', (s) => {
        for (const [id, entry] of Object.entries(s.agents) as [string, { outputBuffer: string[] }][]) {
          const prev = printed.get(id) ?? 0;
          for (let i = prev; i < entry.outputBuffer.length; i++) {
            const line = entry.outputBuffer[i];
            if (line) process.stdout.write(`[${id}] ${line}\n`);
          }
          printed.set(id, entry.outputBuffer.length);
        }
      });
    } else {
      render(
        React.createElement(App, { store, onRestart, onStop, onSendMessage }),
      );
    }

    orchestrator.start(opts.resume ? sessionPath : undefined).catch((err) => {
      console.error('Orchestrator error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });

    // save session on exit so --resume can restore it next run
    const saveAndExit = () => {
      try {
        orchestrator.saveSession(sessionPath);
      } catch {
        // best-effort -- don't crash on exit
      }
      store.destroy();
      process.exit(0);
    };
    process.on('SIGINT', saveAndExit);
    process.on('SIGTERM', saveAndExit);
  });

program
  .command('init')
  .description('Generate a starter agents.yaml in the current directory')
  .action(() => {
    const dest = resolve(process.cwd(), 'agents.yaml');
    if (existsSync(dest)) {
      console.error('agents.yaml already exists');
      process.exit(1);
      return;
    }
    const starter = [
      'version: 1',
      '',
      'agents:',
      '  assistant:',
      '    provider: ollama',
      '    model: llama3.2',
      '    system: You are a helpful assistant.',
      '',
    ].join('\n');
    writeFileSync(dest, starter);
    console.log('Created agents.yaml');
  });

program
  .command('save <name>')
  .description('Package current config as a shareable template')
  .option('-f, --file <path>', 'config file to save', 'agents.yaml')
  .option('-d, --description <text>', 'short description for the template')
  .action(async (name: string, opts: { file: string; description?: string }) => {
    try {
      await saveTemplate(name, { file: opts.file, description: opts.description });
      console.log(`Template saved: ${name}.template.yaml`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('publish <name>')
  .description('Push a saved template to the git registry')
  .option('--registry <url>', 'registry base URL')
  .action(async (name: string, opts: { registry?: string }) => {
    try {
      await publishTemplate(name, { registry: opts.registry });
      console.log(`Template published: ${name}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('fork <repo-url>')
  .description('Clone and customize a template from a git repository')
  .option('--name <name>', 'local directory name for the forked template')
  .action(async (repoUrl: string, opts: { name?: string }) => {
    try {
      const dest = await forkTemplate(repoUrl, { name: opts.name });
      console.log(`Template forked to: ${dest}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const templates = program.command('templates').description('Template registry commands');

templates
  .command('search <query>')
  .description('Search the template registry')
  .option('--limit <n>', 'max results to show', '10')
  .option('--registry <url>', 'registry base URL')
  .action(async (query: string, opts: { limit: string; registry?: string }) => {
    try {
      const results = await searchTemplates(query, {
        limit: parseInt(opts.limit, 10),
        registry: opts.registry,
      });
      if (results.length === 0) {
        console.log('No templates found.');
      } else {
        for (const r of results) {
          console.log(`${r.name} -- ${r.description} (${r.url})`);
        }
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program.parse();
