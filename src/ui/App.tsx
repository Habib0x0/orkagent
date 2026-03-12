import React, { useState, useEffect, useCallback } from 'react';
import { Box, useInput } from 'ink';
import type { Store, AgentStoreEntry, AppState } from '../store.js';
import AgentPane from './AgentPane.js';
import StatusBar from './StatusBar.js';
import InputBar from './InputBar.js';
import ApprovalPrompt from './ApprovalPrompt.js';

interface Props {
  store: Store;
  onRestart: (id: string) => void;
  onStop: (id: string) => void;
  onSendMessage?: (agentId: string, text: string) => void;
}

export default function App({ store, onRestart, onStop, onSendMessage }: Props) {
  const [appState, setAppState] = useState<AppState>(() => store.getState() as AppState);

  useEffect(() => {
    const handler = (s: AppState) => setAppState({ ...s });
    store.on('change', handler);
    return () => {
      store.off('change', handler);
    };
  }, [store]);

  const agents = Object.values(appState.agents);
  const layout = appState.layout;
  const focusedId = appState.focusedAgentId;

  // track focus index for grid navigation
  const [focusIndex, setFocusIndex] = useState(0);

  // ctrl-b prefix state
  const [ctrlBPending, setCtrlBPending] = useState(false);

  const focusedEntry: AgentStoreEntry | undefined =
    focusedId ? appState.agents[focusedId] : agents[focusIndex];

  const clampIndex = useCallback(
    (idx: number) => Math.max(0, Math.min(idx, agents.length - 1)),
    [agents.length],
  );

  useInput(
    useCallback(
      (input, key) => {
        if (ctrlBPending) {
          setCtrlBPending(false);
          const target = layout === 'focused' ? focusedId : agents[focusIndex]?.id;
          if (!target) return;

          if (input === 'r') {
            onRestart(target);
          } else if (input === 'x') {
            onStop(target);
          }
          return;
        }

        // detect ctrl-b
        if (input === 'b' && key.ctrl) {
          setCtrlBPending(true);
          return;
        }

        if (layout === 'focused') {
          if (key.escape) {
            store.setFocusedAgent(null);
          }
          // in focused mode, other nav keys are consumed by InputBar
          return;
        }

        // grid mode navigation
        if (input === 'h' || key.leftArrow) {
          setFocusIndex((i) => clampIndex(i - 1));
          return;
        }
        if (input === 'l' || key.rightArrow) {
          setFocusIndex((i) => clampIndex(i + 1));
          return;
        }
        if (input === 'j' || key.downArrow) {
          setFocusIndex((i) => clampIndex(i + 1));
          return;
        }
        if (input === 'k' || key.upArrow) {
          setFocusIndex((i) => clampIndex(i - 1));
          return;
        }

        // 1-9 jump
        const digit = parseInt(input, 10);
        if (digit >= 1 && digit <= 9) {
          setFocusIndex(clampIndex(digit - 1));
          return;
        }

        if (key.return) {
          const target = agents[focusIndex];
          if (target) {
            store.setFocusedAgent(target.id);
          }
        }
      },
      [ctrlBPending, layout, focusedId, agents, focusIndex, clampIndex, store, onRestart, onStop],
    ),
  );

  const handleInputSubmit = useCallback(
    (text: string) => {
      if (!focusedId) return;
      if (onSendMessage) {
        onSendMessage(focusedId, text);
      } else {
        // fallback when no orchestrator is wired (e.g. plain mode)
        store.appendOutput(focusedId, `[user] ${text}`);
      }
    },
    [focusedId, store, onSendMessage],
  );

  const handleApprove = useCallback(
    (id: string) => store.resolvePendingApproval(id, 'approve'),
    [store],
  );

  const handleDeny = useCallback(
    (id: string) => store.resolvePendingApproval(id, 'deny'),
    [store],
  );

  // approve + add to allow list -- the guard instance is not directly accessible here,
  // so we emit an event that the orchestrator layer can pick up
  const handleApproveRemember = useCallback(
    (id: string) => {
      const approval = appState.pendingApprovals.find((a) => a.id === id);
      if (approval) {
        store.emit('approveRemember', approval.toolName);
      }
      store.resolvePendingApproval(id, 'approve');
    },
    [store, appState.pendingApprovals],
  );

  const approvalPrompt = appState.pendingApprovals.length > 0 ? (
    <ApprovalPrompt
      approvals={appState.pendingApprovals}
      onApprove={handleApprove}
      onDeny={handleDeny}
      onApproveRemember={handleApproveRemember}
    />
  ) : null;

  if (layout === 'focused' && focusedEntry) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {approvalPrompt}
        <Box flexGrow={1}>
          <AgentPane entry={focusedEntry} isFocused={true} isExpanded={true} />
        </Box>
        <InputBar agentName={focusedEntry.name} onSubmit={handleInputSubmit} />
        <StatusBar agents={agents} />
      </Box>
    );
  }

  // grid layout
  return (
    <Box flexDirection="column" flexGrow={1}>
      {approvalPrompt}
      <Box flexDirection="row" flexWrap="wrap" flexGrow={1}>
        {agents.map((agent, i) => (
          <Box key={agent.id} flexGrow={1} minWidth={30}>
            <AgentPane
              entry={agent}
              isFocused={i === focusIndex}
              isExpanded={false}
            />
          </Box>
        ))}
      </Box>
      <StatusBar agents={agents} />
    </Box>
  );
}
