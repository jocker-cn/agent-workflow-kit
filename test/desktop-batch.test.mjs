import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isGeometryChangingKeys,
  resolveRelativePoint,
  validateDesktopPlan,
} from '../src/desktop-batch.mjs';

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
  assert.equal(plan.target.preserveGeometry, true);
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.evidence.screenshot, 'boundary');
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
