import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionRequiresForeground,
  isGeometryChangingKeys,
  resolveRelativePoint,
  validateDesktopPlan,
} from '../src/desktop-batch.mjs';
import { validateDesktopCliArgs } from '../src/desktop-cli.mjs';

test('resolves normalized points in live screen coordinates', () => {
  assert.deepEqual(
    resolveRelativePoint({ x: 0.25, y: 0.75 }, { x: 100, y: 200, width: 800, height: 400 }),
    { x: 300, y: 500 },
  );
});

test('rejects relative points outside the target window', () => {
  assert.throws(
    () => resolveRelativePoint({ x: 1.1, y: 0.5 }, { x: 0, y: 0, width: 100, height: 100 }),
    /between 0 and 1/,
  );
});

test('detects geometry-changing keyboard shortcuts', () => {
  assert.equal(isGeometryChangingKeys('ctrl+a win+up enter'), true);
  assert.equal(isGeometryChangingKeys('ctrl+f text=file-transfer enter'), false);
});

test('validates a UIA-first transaction with one boundary screenshot', () => {
  const plan = validateDesktopPlan({
    id: 'fill-and-submit',
    target: { app: 'notepad', preserveGeometry: true },
    actions: [
      { id: 'fill-value', command: 'set-value', selector: 'TextEditor', valueFrom: 'order.text' },
      { id: 'wait-save', command: 'wait-for', selector: 'Save', timeoutMs: 3000 },
    ],
    evidence: { screenshot: 'boundary' },
  });
  assert.equal(plan.targets.default.preserveGeometry, true);
  assert.equal(plan.targets.default.activation.mode, 'auto');
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.evidence.screenshot, 'boundary');
});

test('activates only commands that depend on foreground input', () => {
  assert.equal(actionRequiresForeground({ command: 'inspect' }), false);
  assert.equal(actionRequiresForeground({ command: 'get-value' }), false);
  assert.equal(actionRequiresForeground({ command: 'set-value' }), false);
  assert.equal(actionRequiresForeground({ command: 'invoke' }), false);
  assert.equal(actionRequiresForeground({ command: 'send-keys', via: 'post-message' }), false);
  assert.equal(actionRequiresForeground({ command: 'send-keys', via: 'send-input' }), true);
  assert.equal(actionRequiresForeground({ command: 'click' }), true);
  assert.equal(actionRequiresForeground({ command: 'drag' }), true);
  assert.equal(actionRequiresForeground({ command: 'scroll', direction: 'down' }), false);
  assert.equal(actionRequiresForeground({ command: 'scroll', wheel: -1 }), true);
  assert.equal(actionRequiresForeground({ command: 'screenshot' }), false);
  assert.equal(actionRequiresForeground({ command: 'screenshot', captureScreen: true }), true);
});

test('rejects geometry changes when preservation is enabled', () => {
  assert.throws(() => validateDesktopPlan({
    id: 'bad-window-change',
    target: { app: 'Weixin', preserveGeometry: true },
    actions: [
      { id: 'maximize', command: 'send-keys', keys: 'win+up', allowSystemKeys: true },
    ],
  }), /changes window geometry/);
});

test('allows window-relative visual fallbacks without absolute screenshot coordinates', () => {
  const plan = validateDesktopPlan({
    id: 'visual-fallback',
    target: { app: 'Weixin' },
    actions: [
      { id: 'open-search', command: 'click', relative: { x: 0.3, y: 0.07 } },
      { id: 'type-name', command: 'send-keys', valueFrom: 'conversation.name' },
    ],
  });
  assert.equal(plan.actions[0].point.space, 'window');
});

test('normalizes one resumable workflow boundary instead of per-action checkpoints', () => {
  const plan = validateDesktopPlan({
    id: 'read-messages',
    target: { app: 'Weixin' },
    actions: [
      { id: 'read-window', command: 'inspect', saveAs: 'messages' },
    ],
    workflow: {
      nodeId: 'read-conversation',
      title: 'Read conversation',
      routeId: 'exact-search',
      facts: [{ key: 'conversation.messages', from: 'observations.messages' }],
    },
  });
  assert.equal(plan.workflow.nodeId, 'read-conversation');
  assert.deepEqual(plan.workflow.facts, [
    { key: 'conversation.messages', from: 'observations.messages' },
  ]);
});

test('compiles cross-application work into one desktop batch', () => {
  const plan = validateDesktopPlan({
    id: 'terminal-to-chat',
    targets: {
      terminal: { app: 'SecureCRT', title: 'SecureCRT' },
      chat: { app: 'Weixin', title: '微信' },
    },
    actions: [
      { id: 'read-title', window: 'terminal', command: 'window-info', saveAs: 'terminal-window' },
      {
        id: 'extract-status',
        window: 'terminal',
        command: 'extract-regex',
        sourceFrom: 'observations.terminal-window.title',
        pattern: '^STATUS=(?<status>.+)$',
        saveAs: 'service',
      },
      {
        id: 'compose-message',
        window: 'terminal',
        command: 'template',
        template: 'Service: ${observations.service.status}',
        saveAs: 'message',
      },
      {
        id: 'send-message',
        window: 'chat',
        command: 'send-keys',
        valueFrom: 'observations.message',
      },
    ],
    evidence: { screenshot: 'boundary', window: 'chat' },
  });
  assert.deepEqual(Object.keys(plan.targets), ['terminal', 'chat']);
  assert.equal(plan.actions[3].window, 'chat');
  assert.equal(plan.evidence.window, 'chat');
});

test('desktop CLI rejects screenshot focus and run-root screenshot clutter', () => {
  assert.throws(
    () => validateDesktopCliArgs(['screenshot', '-w', '123', '--focus', '--output', 'page.png']),
    /desktop:window/,
  );
  assert.throws(
    () => validateDesktopCliArgs([
      'screenshot',
      '-w',
      '123',
      '--output',
      '.workflow-runs/20260802-test-run/page.png',
    ]),
    /evidence.*diagnostics/,
  );
  assert.doesNotThrow(() => validateDesktopCliArgs([
    'screenshot',
    '-w',
    '123',
    '--output',
    '.workflow-runs/20260802-test-run/evidence/read-status/final.png',
  ]));
});
