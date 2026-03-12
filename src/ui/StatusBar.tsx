import React from 'react';
import { Box, Text } from 'ink';
import type { AgentStoreEntry } from '../store.js';
import type { AgentState } from '../providers/types.js';

interface Props {
  agents: AgentStoreEntry[];
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

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export default function StatusBar({ agents }: Props) {
  const totalInput = agents.reduce((sum, a) => sum + a.tokens.input, 0);
  const totalOutput = agents.reduce((sum, a) => sum + a.tokens.output, 0);
  const totalCost = agents.reduce((sum, a) => sum + a.cost, 0);

  return (
    <Box flexDirection="row" flexWrap="wrap">
      {agents.map((agent, i) => {
        const { color, label } = stateDisplay(agent.state);
        return (
          <Box key={agent.id} marginRight={1}>
            <Text>{agent.name}</Text>
            <Text color={color}>{label}</Text>
            {i < agents.length - 1 ? <Text> </Text> : null}
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text>in:{formatTokens(totalInput)} out:{formatTokens(totalOutput)} {formatCost(totalCost)}</Text>
    </Box>
  );
}
