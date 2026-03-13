import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { Store } from '../store.js';
import type { AgentStoreEntry } from '../store.js';
import App from '../ui/App.js';
import StatusBar from '../ui/StatusBar.js';
import AgentPane from '../ui/AgentPane.js';
import InputBar from '../ui/InputBar.js';

function makeEntry(overrides: Partial<AgentStoreEntry> = {}): AgentStoreEntry {
  return {
    id: 'a1',
    name: 'coder',
    state: 'idle',
    outputBuffer: [],
    messages: [],
    tokens: { input: 0, output: 0 },
    cost: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// StatusBar (tmux-style tab bar)
// ---------------------------------------------------------------------------
describe('StatusBar', () => {
  it('renders agent names with state indicators', () => {
    const agents: AgentStoreEntry[] = [
      makeEntry({ id: 'a1', name: 'coder', state: 'running' }),
      makeEntry({ id: 'a2', name: 'reviewer', state: 'idle' }),
      makeEntry({ id: 'a3', name: 'tester', state: 'done' }),
      makeEntry({ id: 'a4', name: 'broken', state: 'error' }),
    ];
    const { lastFrame } = render(React.createElement(StatusBar, { agents, activeIndex: 0 }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('coder');
    expect(frame).toContain('reviewer');
    expect(frame).toContain('tester');
    expect(frame).toContain('broken');
  });

  it('renders cost formatted to 4 decimal places', () => {
    const agents: AgentStoreEntry[] = [
      makeEntry({ id: 'a1', name: 'coder', state: 'done', cost: 0.0123 }),
    ];
    const { lastFrame } = render(React.createElement(StatusBar, { agents, activeIndex: 0 }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('$0.0123');
  });

  it('renders token counts in compact format', () => {
    const agents: AgentStoreEntry[] = [
      makeEntry({ id: 'a1', name: 'coder', state: 'done', tokens: { input: 1500, output: 3000 } }),
    ];
    const { lastFrame } = render(React.createElement(StatusBar, { agents, activeIndex: 0 }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1.5k');
    expect(frame).toContain('3.0k');
  });

  it('shows paused state indicator', () => {
    const agents = [makeEntry({ id: 'a1', name: 'agent', state: 'paused' })];
    const { lastFrame } = render(React.createElement(StatusBar, { agents, activeIndex: 0 }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('agent');
  });
});

// ---------------------------------------------------------------------------
// AgentPane
// ---------------------------------------------------------------------------
describe('AgentPane', () => {
  it('shows agent name in header', () => {
    const entry = makeEntry({ name: 'myagent', state: 'running' });
    const { lastFrame } = render(
      React.createElement(AgentPane, { entry, isFocused: false, isExpanded: false }),
    );
    expect(lastFrame()).toContain('myagent');
  });

  it('shows state text label alongside name', () => {
    const states: Array<[AgentStoreEntry['state'], string]> = [
      ['running', 'running'],
      ['idle', 'idle'],
      ['done', 'done'],
      ['error', 'error'],
      ['paused', 'paused'],
    ];
    for (const [state, label] of states) {
      const entry = makeEntry({ state });
      const { lastFrame, unmount } = render(
        React.createElement(AgentPane, { entry, isFocused: false, isExpanded: false }),
      );
      expect(lastFrame()).toContain(label);
      unmount();
    }
  });

  it('renders visible lines from outputBuffer', () => {
    const entry = makeEntry({
      outputBuffer: ['line one', 'line two', 'line three'],
    });
    const { lastFrame } = render(
      React.createElement(AgentPane, { entry, isFocused: false, isExpanded: false }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line one');
    expect(frame).toContain('line two');
    expect(frame).toContain('line three');
  });

  it('prefixes tool call lines with [TOOL: ...]', () => {
    const entry = makeEntry({
      outputBuffer: ['[TOOL: bash] running command'],
    });
    const { lastFrame } = render(
      React.createElement(AgentPane, { entry, isFocused: false, isExpanded: false }),
    );
    expect(lastFrame()).toContain('[TOOL: bash]');
  });
});

// ---------------------------------------------------------------------------
// InputBar
// ---------------------------------------------------------------------------
describe('InputBar', () => {
  it('renders the agent name as prompt', () => {
    const { lastFrame } = render(
      React.createElement(InputBar, { agentName: 'mycoder', onSubmit: vi.fn() }),
    );
    expect(lastFrame()).toContain('[mycoder]');
  });

  it('accepts onSubmit prop (contract check)', () => {
    const onSubmit = vi.fn();
    const { lastFrame } = render(
      React.createElement(InputBar, { agentName: 'coder', onSubmit }),
    );
    expect(lastFrame()).toContain('[coder]');
    onSubmit('test');
    expect(onSubmit).toHaveBeenCalledWith('test');
  });

  it('does not call onSubmit on empty input', () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(InputBar, { agentName: 'coder', onSubmit }),
    );
    stdin.write('\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// App -- tmux-style layout
// ---------------------------------------------------------------------------
describe('App', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store();
    store.initAgent('a1', 'coder');
    store.initAgent('a2', 'reviewer');
    store.initAgent('a3', 'tester');
  });

  afterEach(() => {
    store.destroy();
  });

  it('renders only the active agent pane (tmux-style)', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        store,
        onRestart: vi.fn(),
        onStop: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    // first agent shown by default
    expect(frame).toContain('coder');
  });

  it('shows all agents in the status bar', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        store,
        onRestart: vi.fn(),
        onStop: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('coder');
    expect(frame).toContain('reviewer');
    expect(frame).toContain('tester');
  });

  it('n key cycles to next agent', () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { store, onRestart: vi.fn(), onStop: vi.fn() }),
    );

    // press 'n' to move to next agent
    stdin.write('n');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('reviewer');
  });

  it('number keys jump to agent by index', () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { store, onRestart: vi.fn(), onStop: vi.fn() }),
    );

    // press '3' to jump to third agent
    stdin.write('3');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('tester');
  });
});
