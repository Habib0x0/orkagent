// ApprovalPrompt -- tool permission approval modal
import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { PendingApproval } from '../store.js';

interface Props {
  approvals: PendingApproval[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  // called with id when user presses 'a' -- caller should also add tool to allow list
  onApproveRemember: (id: string) => void;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Exported for testing -- maps a single keystroke to the appropriate handler call. */
export function handleApprovalKey(
  input: string,
  currentId: string | undefined,
  handlers: { onApprove: (id: string) => void; onDeny: (id: string) => void; onApproveRemember: (id: string) => void },
): void {
  if (!currentId) return;
  if (input === 'y') handlers.onApprove(currentId);
  else if (input === 'n') handlers.onDeny(currentId);
  else if (input === 'a') handlers.onApproveRemember(currentId);
}

export default function ApprovalPrompt({ approvals, onApprove, onDeny, onApproveRemember }: Props) {
  const current = approvals[0];

  useInput((input) => {
    handleApprovalKey(input, current?.id, { onApprove, onDeny, onApproveRemember });
  });

  if (!current) return null;

  const summary = truncate(current.inputSummary, 100);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      marginBottom={1}
    >
      <Box flexDirection="row">
        <Text bold color="yellow">
          Tool approval required
        </Text>
        <Text> </Text>
        {approvals.length > 1 && (
          <Text color="gray">({approvals.length - 1} more queued)</Text>
        )}
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text color="cyan">agent: </Text>
        <Text>{current.agentId}</Text>
        <Text>  </Text>
        <Text color="cyan">tool: </Text>
        <Text bold>{current.toolName}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{summary}</Text>
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text color="green">[y] Approve</Text>
        <Text>  </Text>
        <Text color="red">[n] Deny</Text>
        <Text>  </Text>
        <Text color="cyan">[a] Approve + remember</Text>
      </Box>
    </Box>
  );
}
