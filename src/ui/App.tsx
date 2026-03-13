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

  // current agent index -- always show one agent full-screen (tmux-style)
  const [activeIndex, setActiveIndex] = useState(0);

  // ctrl-b prefix for tmux-style commands
  const [ctrlBPending, setCtrlBPending] = useState(false);

  // input mode -- when true, keystrokes go to InputBar instead of navigation
  const [inputMode, setInputMode] = useState(false);

  const clamp = useCallback(
    (idx: number) => {
      if (agents.length === 0) return 0;
      return ((idx % agents.length) + agents.length) % agents.length;
    },
    [agents.length],
  );

  useInput(
    useCallback(
      (input, key) => {
        // in input mode, only escape exits
        if (inputMode) {
          if (key.escape) {
            setInputMode(false);
          }
          return;
        }

        // ctrl-b prefix commands (tmux-style)
        if (ctrlBPending) {
          setCtrlBPending(false);
          const target = agents[activeIndex]?.id;
          if (!target) return;

          switch (input) {
            case 'r': onRestart(target); break;
            case 'x': onStop(target); break;
            case 'n': setActiveIndex((i) => clamp(i + 1)); break;
            case 'p': setActiveIndex((i) => clamp(i - 1)); break;
            case 's': {
              // swap current agent with next
              // (swap is visual only -- changes the agents array order in store)
              break;
            }
          }
          return;
        }

        // detect ctrl-b prefix
        if (input === 'b' && key.ctrl) {
          setCtrlBPending(true);
          return;
        }

        // navigation: next/previous agent
        if (input === 'n' || key.rightArrow || (key.tab && !key.shift)) {
          setActiveIndex((i) => clamp(i + 1));
          return;
        }
        if (input === 'p' || key.leftArrow) {
          setActiveIndex((i) => clamp(i - 1));
          return;
        }

        // 1-9 jump to agent by index
        const digit = parseInt(input, 10);
        if (digit >= 1 && digit <= 9) {
          setActiveIndex(clamp(digit - 1));
          return;
        }

        // enter input mode to send a message
        if (input === 'i' || key.return) {
          setInputMode(true);
          return;
        }
      },
      [ctrlBPending, inputMode, agents, activeIndex, clamp, onRestart, onStop],
    ),
  );

  const handleInputSubmit = useCallback(
    (text: string) => {
      const target = agents[activeIndex];
      if (!target) return;
      if (onSendMessage) {
        onSendMessage(target.id, text);
      } else {
        store.appendOutput(target.id, `[user] ${text}`);
      }
      setInputMode(false);
    },
    [agents, activeIndex, store, onSendMessage],
  );

  const handleApprove = useCallback(
    (id: string) => store.resolvePendingApproval(id, 'approve'),
    [store],
  );

  const handleDeny = useCallback(
    (id: string) => store.resolvePendingApproval(id, 'deny'),
    [store],
  );

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

  const activeAgent = agents[activeIndex];

  return (
    <Box flexDirection="column" flexGrow={1}>
      {approvalPrompt}
      <Box flexGrow={1}>
        {activeAgent ? (
          <AgentPane entry={activeAgent} isFocused={true} isExpanded={true} />
        ) : null}
      </Box>
      {inputMode && activeAgent ? (
        <InputBar agentName={activeAgent.name} onSubmit={handleInputSubmit} />
      ) : null}
      <StatusBar agents={agents} activeIndex={activeIndex} />
    </Box>
  );
}
