import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { AgentStoreEntry } from '../store.js';
import type { AgentState } from '../providers/types.js';

// set up marked with terminal renderer once
const marked = new Marked(markedTerminal({
  reflowText: true,
  width: 120,
  showSectionPrefix: false,
}) as unknown as Record<string, unknown>);

interface Props {
  entry: AgentStoreEntry;
  isFocused: boolean;
  isExpanded: boolean;
}

function stateDisplay(state: AgentState): { color: string; label: string; icon: string } {
  switch (state) {
    case 'running':
    case 'starting':
      return { color: 'green', label: 'running', icon: '>' };
    case 'idle':
    case 'pending':
      return { color: 'yellow', label: 'idle', icon: '-' };
    case 'paused':
      return { color: 'cyan', label: 'paused', icon: '|' };
    case 'done':
      return { color: 'gray', label: 'done', icon: '.' };
    case 'error':
      return { color: 'red', label: 'error', icon: '!' };
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function AgentPane({ entry }: Props) {
  const { stdout } = useStdout();
  const termRows = (stdout as { rows?: number }).rows ?? 24;
  // header(1) + border top/bottom(2) + status bar(1) = 4
  const paneHeight = Math.max(termRows - 4, 4);

  const isStreaming = entry.state === 'running' || entry.state === 'starting';

  // render markdown to ANSI and split into lines for the visible window
  const visibleLines = useMemo(() => {
    const raw = entry.outputBuffer.join('\n');
    if (!raw.trim()) return [];

    let rendered: string;
    try {
      rendered = (marked.parse(raw) as string)
        .replace(/\n+$/, ''); // trim trailing newlines
    } catch {
      rendered = raw;
    }

    const lines = rendered.split('\n');
    if (lines.length <= paneHeight) return lines;
    return lines.slice(lines.length - paneHeight);
  }, [entry.outputBuffer, paneHeight]);

  const { color, label, icon } = stateDisplay(entry.state);
  const totalTokens = entry.tokens.input + entry.tokens.output;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* header bar */}
      <Box flexDirection="row" paddingX={1}>
        <Text color={color} bold>{icon} </Text>
        <Text bold color="white">{entry.name}</Text>
        <Text color={color} dimColor> {label}</Text>
        {isStreaming ? <Text color="green"> {getSpinner()}</Text> : null}
        <Box flexGrow={1} />
        {totalTokens > 0 ? (
          <Text dimColor>{formatTokens(entry.tokens.input)}in {formatTokens(entry.tokens.output)}out</Text>
        ) : null}
        {entry.cost > 0 ? (
          <Text dimColor> ${entry.cost.toFixed(4)}</Text>
        ) : null}
      </Box>
      {/* main output area */}
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={isStreaming ? 'green' : 'gray'}
        paddingX={1}
      >
        {visibleLines.length === 0 && !entry.lastError ? (
          <Text dimColor>{isStreaming ? 'Waiting for response...' : 'No output yet'}</Text>
        ) : null}
        {visibleLines.map((line, i) => (
          <Text key={i} wrap="wrap">{line}</Text>
        ))}
        {entry.lastError ? (
          <Box marginTop={1}>
            <Text color="red">{entry.lastError}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function getSpinner(): string {
  const frames = ['|', '/', '-', '\\'];
  const idx = Math.floor(Date.now() / 120) % frames.length;
  return frames[idx]!;
}
