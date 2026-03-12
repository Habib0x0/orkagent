import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { AgentStoreEntry } from '../store.js';
import type { AgentState } from '../providers/types.js';

interface Props {
  entry: AgentStoreEntry;
  isFocused: boolean;
  isExpanded: boolean;
}

interface StateDisplay {
  color: string;
  label: string;
}

function stateDisplay(state: AgentState): StateDisplay {
  switch (state) {
    case 'running':
    case 'starting':
      return { color: 'green', label: '[run]' };
    case 'idle':
    case 'pending':
      return { color: 'yellow', label: '[idle]' };
    case 'paused':
      return { color: 'cyan', label: '[wait]' };
    case 'done':
      return { color: 'gray', label: '[done]' };
    case 'error':
      return { color: 'red', label: '[err]' };
  }
}

function formatLine(line: string): React.ReactElement {
  // tool call events get a prefix
  if (line.startsWith('[TOOL: ')) {
    return <Text color="magenta">{line}</Text>;
  }
  return <Text>{line}</Text>;
}

export default function AgentPane({ entry, isFocused, isExpanded }: Props) {
  const { stdout } = useStdout();
  // rough height estimate: terminal rows minus header/footer, or a fixed slice in grid mode
  const termRows = (stdout as { rows?: number }).rows ?? 24;
  const paneHeight = isExpanded ? termRows - 4 : Math.max(6, Math.floor((termRows - 4) / 2));

  const visibleLines = useMemo(() => {
    const buf = entry.outputBuffer;
    if (buf.length <= paneHeight) return buf;
    return buf.slice(buf.length - paneHeight);
  }, [entry.outputBuffer, paneHeight]);

  const { color, label } = stateDisplay(entry.state);
  const dim = !isFocused && !isExpanded;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={isFocused ? 'cyan' : 'gray'}
      flexGrow={1}
      overflow="hidden"
    >
      {/* header */}
      <Box flexDirection="row" paddingX={1}>
        <Text bold={isFocused} dimColor={dim}>{entry.name}</Text>
        <Text> </Text>
        <Text color={color} dimColor={dim}>{label}</Text>
        {entry.lastError ? <Text color="red" dimColor={dim}> {entry.lastError}</Text> : null}
      </Box>
      {/* output area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {visibleLines.map((line, i) => (
          <Box key={i}>
            <Text dimColor={dim}>{formatLine(line).props.children}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
