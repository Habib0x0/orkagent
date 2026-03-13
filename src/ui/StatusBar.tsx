import React from 'react';
import { Box, Text } from 'ink';
import type { AgentStoreEntry } from '../store.js';
import type { AgentState } from '../providers/types.js';

interface Props {
  agents: AgentStoreEntry[];
  activeIndex: number;
}

function stateColor(state: AgentState): string {
  switch (state) {
    case 'running':
    case 'starting':
      return 'green';
    case 'idle':
    case 'pending':
      return 'yellow';
    case 'paused':
      return 'cyan';
    case 'done':
      return 'gray';
    case 'error':
      return 'red';
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function StatusBar({ agents, activeIndex }: Props) {
  const totalInput = agents.reduce((sum, a) => sum + a.tokens.input, 0);
  const totalOutput = agents.reduce((sum, a) => sum + a.tokens.output, 0);
  const totalCost = agents.reduce((sum, a) => sum + a.cost, 0);

  return (
    <Box flexDirection="row" paddingX={1}>
      {agents.map((agent, i) => {
        const color = stateColor(agent.state);
        const isActive = i === activeIndex;
        return (
          <React.Fragment key={agent.id}>
            {i > 0 ? <Text dimColor> | </Text> : null}
            <Text
              bold={isActive}
              inverse={isActive}
              color={isActive ? 'white' : color}
              backgroundColor={isActive ? 'blue' : undefined}
            >
              {isActive ? ` ${i + 1}:${agent.name} ` : `${i + 1}:${agent.name}`}
            </Text>
          </React.Fragment>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>
        {formatTokens(totalInput)}in {formatTokens(totalOutput)}out ${totalCost.toFixed(4)}
      </Text>
      <Text dimColor> | n/p:switch i:msg ^b:cmd</Text>
    </Box>
  );
}
