import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import ApprovalPrompt, { handleApprovalKey } from '../ui/ApprovalPrompt.js';
import type { PendingApproval } from '../store.js';

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'approval-1',
    agentId: 'agent-coder',
    toolName: 'shell',
    inputSummary: 'rm -rf /tmp/test',
    resolve: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ApprovalPrompt', () => {
  it('renders nothing when approvals list is empty', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalPrompt, {
        approvals: [],
        onApprove: vi.fn(),
        onDeny: vi.fn(),
        onApproveRemember: vi.fn(),
      }),
    );
    expect(lastFrame()).toBe('');
  });

  it('renders agent name and tool name', () => {
    const approval = makeApproval({ agentId: 'coder', toolName: 'file_write' });
    const { lastFrame } = render(
      React.createElement(ApprovalPrompt, {
        approvals: [approval],
        onApprove: vi.fn(),
        onDeny: vi.fn(),
        onApproveRemember: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('coder');
    expect(frame).toContain('file_write');
  });

  it('renders truncated input summary up to 100 chars', () => {
    const long = 'x'.repeat(200);
    const approval = makeApproval({ inputSummary: long });
    const { lastFrame } = render(
      React.createElement(ApprovalPrompt, {
        approvals: [approval],
        onApprove: vi.fn(),
        onDeny: vi.fn(),
        onApproveRemember: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    // full 200-char string should not appear
    expect(frame).not.toContain(long);
    // the truncated version ends with ellipsis character
    expect(frame).toContain('\u2026');
  });

  it('renders key hints', () => {
    const approval = makeApproval();
    const { lastFrame } = render(
      React.createElement(ApprovalPrompt, {
        approvals: [approval],
        onApprove: vi.fn(),
        onDeny: vi.fn(),
        onApproveRemember: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[y] Approve');
    expect(frame).toContain('[n] Deny');
    expect(frame).toContain('[a] Approve + remember');
  });

  it('snapshot: single pending approval', () => {
    const approval = makeApproval();
    const { lastFrame } = render(
      React.createElement(ApprovalPrompt, {
        approvals: [approval],
        onApprove: vi.fn(),
        onDeny: vi.fn(),
        onApproveRemember: vi.fn(),
      }),
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('only shows first approval when multiple are queued', () => {
    const approvals = [
      makeApproval({ id: 'a1', toolName: 'shell', agentId: 'coder' }),
      makeApproval({ id: 'a2', toolName: 'file_write', agentId: 'reviewer' }),
    ];
    const { lastFrame } = render(
      React.createElement(ApprovalPrompt, {
        approvals,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
        onApproveRemember: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    // first approval shown
    expect(frame).toContain('shell');
    // second queued, reviewer not shown as primary
    expect(frame).toContain('1 more queued');
  });

  // keybinding tests use handleApprovalKey directly because ink-testing-library 3.x
  // stdin doesn't support ink 5.x's readable-based useInput pipeline

  it('calls onApprove when y is pressed', () => {
    const onApprove = vi.fn();
    handleApprovalKey('y', 'test-id', { onApprove, onDeny: vi.fn(), onApproveRemember: vi.fn() });
    expect(onApprove).toHaveBeenCalledWith('test-id');
  });

  it('calls onDeny when n is pressed', () => {
    const onDeny = vi.fn();
    handleApprovalKey('n', 'test-id', { onApprove: vi.fn(), onDeny, onApproveRemember: vi.fn() });
    expect(onDeny).toHaveBeenCalledWith('test-id');
  });

  it('calls onApproveRemember when a is pressed', () => {
    const onApproveRemember = vi.fn();
    handleApprovalKey('a', 'test-id', { onApprove: vi.fn(), onDeny: vi.fn(), onApproveRemember });
    expect(onApproveRemember).toHaveBeenCalledWith('test-id');
  });

  it('does not call any handler for other keys', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const onApproveRemember = vi.fn();
    const handlers = { onApprove, onDeny, onApproveRemember };
    handleApprovalKey('z', 'test-id', handlers);
    handleApprovalKey('x', 'test-id', handlers);
    handleApprovalKey(' ', 'test-id', handlers);
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
    expect(onApproveRemember).not.toHaveBeenCalled();
  });

  it('does nothing when currentId is undefined', () => {
    const onApprove = vi.fn();
    handleApprovalKey('y', undefined, { onApprove, onDeny: vi.fn(), onApproveRemember: vi.fn() });
    expect(onApprove).not.toHaveBeenCalled();
  });
});
