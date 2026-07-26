import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const workflowctl = join(root, 'src', 'workflowctl.mjs');
const cachectl = join(root, 'src', 'cachectl.mjs');

function run(...args) {
  return execFileSync(process.execPath, [workflowctl, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function cache(...args) {
  return execFileSync(process.execPath, [cachectl, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runId(output) {
  const match = output.match(/Created workflow run: ([a-z0-9-]+)/);
  assert.ok(match, `Expected a run id in: ${output}`);
  return match[1];
}

async function removeRun(id) {
  const path = join(root, '.workflow-runs', id);
  if (existsSync(path)) await rm(path, { recursive: true, force: true });
}

test('a natural-language workflow needs no contract or business Skill', async (t) => {
  const id = runId(run(
    'init',
    '--summary', 'Open a site and collect visible metrics',
    '--intent', 'Open the requested site, collect the requested visible metrics, and return them.',
    '--name', 'browser-task',
    '--input', 'requestedRank=3',
  ));
  t.after(() => removeRun(id));

  run('plan-add', '--run', id, '--id', 'open-site', '--title', 'Open the requested site');
  run('plan-add', '--run', id, '--id', 'collect-results', '--title', 'Collect visible metrics', '--after', 'open-site');
  run('step', '--run', id, '--id', 'open-site', '--status', 'completed');
  run('checkpoint', '--run', id, '--step', 'collect-results', '--next', 'Read the visible metrics', '--system', 'example', '--url', 'https://example.com');
  run('output', '--run', id, '--key', 'result.url', '--value', 'https://example.com');
  run('evidence', '--run', id, '--kind', 'page', '--value', 'https://example.com');

  const review = run('review', '--run', id);
  assert.match(review, /Name: browser-task/);
  assert.match(review, /Intent: Open the requested site/);
  assert.match(review, /requestedRank: 3/);
  assert.match(review, /\[in_progress\] collect-results/);
  assert.match(review, /url: https:\/\/example\.com/);
  assert.match(review, /Recent evidence/);
  assert.match(review, /kind: page/);
});

test('human checkpoints preserve and resume the same prompt-driven run', async (t) => {
  const id = runId(run('init', '--summary', 'Wait for user verification'));
  t.after(() => removeRun(id));

  run('plan-add', '--run', id, '--id', 'verify-user', '--title', 'Wait for user verification');
  run('checkpoint', '--run', id, '--step', 'verify-user', '--next', 'Wait for the signed-in page');
  assert.match(
    run('pause', '--run', id, '--reason', 'waiting for verification', '--until', 'signed-in page is visible'),
    /Waiting at verify-user/,
  );
  assert.throws(
    () => run('step', '--run', id, '--id', 'verify-user', '--status', 'completed'),
    /Run is waiting/,
  );
  assert.equal(run('latest').trim(), id);
  assert.match(run('context', '--run', id), /signed-in page is visible/);
  assert.match(run('resume', '--run', id), /Resumed at verify-user/);
  assert.match(
    run('step', '--run', id, '--id', 'verify-user', '--status', 'completed'),
    /Step verify-user: completed/,
  );
});

test('runs with different business inputs remain isolated and can be resumed precisely', async (t) => {
  const orderA = runId(run(
    'init',
    '--summary', 'Process order A',
    '--name', 'order-processing',
    '--input', 'order.id=A',
  ));
  const orderB = runId(run(
    'init',
    '--summary', 'Process order B',
    '--name', 'order-processing',
    '--input', 'order.id=B',
  ));
  t.after(() => Promise.all([removeRun(orderA), removeRun(orderB)]));

  run('output', '--run', orderA, '--key', 'result.ticket', '--value', 'TICKET-A');
  run('output', '--run', orderB, '--key', 'result.ticket', '--value', 'TICKET-B');

  assert.equal(
    run('latest', '--name', 'order-processing', '--input', 'order.id=A').trim(),
    orderA,
  );
  assert.equal(
    run('latest', '--name', 'order-processing', '--input', 'order.id=B').trim(),
    orderB,
  );
  assert.match(run('show', '--run', orderA), /TICKET-A/);
  assert.doesNotMatch(run('show', '--run', orderA), /TICKET-B/);
});

test('discovered order type selects a branch and produces complete resume context', async (t) => {
  const id = runId(run(
    'init',
    '--summary', 'Process order A',
    '--intent', 'Inspect the order type. For physical orders use the warehouse route; for virtual orders use the license route.',
    '--name', 'order-processing',
    '--input', 'order.id=A',
  ));
  t.after(() => removeRun(id));

  run('plan-add', '--run', id, '--id', 'inspect-order', '--title', 'Inspect the order and determine its type');
  run('step', '--run', id, '--id', 'inspect-order', '--status', 'completed');
  run('fact', '--run', id, '--key', 'order.type', '--value', 'physical', '--source', 'Order details page');
  run(
    'decision',
    '--run', id,
    '--name', 'order-route',
    '--condition', 'order.type is physical',
    '--selected', 'warehouse',
    '--reason', 'The order details page shows a physical order',
  );
  run('plan-add', '--run', id, '--id', 'check-inventory', '--title', 'Check inventory', '--after', 'inspect-order');
  run('step', '--run', id, '--id', 'check-inventory', '--status', 'completed');
  run('plan-add', '--run', id, '--id', 'create-shipment', '--title', 'Create the shipment', '--after', 'check-inventory');
  run(
    'checkpoint',
    '--run', id,
    '--step', 'create-shipment',
    '--next', 'Fill the shipment form for order A',
    '--system', 'warehouse',
    '--url', 'https://warehouse.example/orders/A',
  );

  const context = run('context', '--run', id);
  assert.match(context, /order-route: \*\*warehouse\*\*/);
  assert.match(context, /type: physical/);
  assert.match(context, /currentStep: create-shipment/);
  assert.match(context, /Fill the shipment form for order A/);
  assert.match(context, /Browser session: `[^`]+`/);
});

test('a changed result invalidates an earlier confirmation', async (t) => {
  const id = runId(run('init', '--summary', 'Submit after review'));
  t.after(() => removeRun(id));

  run('output', '--run', id, '--key', 'cr.id', '--value', 'CR-1');
  assert.match(
    run('confirm', '--run', id, '--action', 'submit', '--by', 'test-user'),
    /Confirmation recorded for submit/,
  );
  run('output', '--run', id, '--key', 'cr.id', '--value', 'CR-2');
  const state = run('show', '--run', id);
  assert.match(state, /"submit"/);
  assert.match(state, /"invalidatedAt"/);
  assert.match(state, /Output changed: cr.id/);
});

test('definition and page caches are isolated by prompt identity and content version', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptAPath = join(promptDir, `cache-a-${suffix}.prompt.md`);
  const promptBPath = join(promptDir, `cache-b-${suffix}.prompt.md`);
  const relativeA = `.github/prompts/cache-a-${suffix}.prompt.md`;
  const relativeB = `.github/prompts/cache-b-${suffix}.prompt.md`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptAPath, 'Process order ${input:orderId} by its type.\n', 'utf8');
  await writeFile(promptBPath, 'Validate resource ${input:resourceName}.\n', 'utf8');

  const preparedA = JSON.parse(cache('prepare', '--prompt', relativeA));
  const preparedB = JSON.parse(cache('prepare', '--prompt', relativeB));
  const createdRuns = [];
  t.after(async () => {
    await Promise.all(createdRuns.map(removeRun));
    await Promise.all([
      rm(promptAPath, { force: true }),
      rm(promptBPath, { force: true }),
      rm(join(root, '.workflow-cache', 'definitions', preparedA.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', preparedA.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'definitions', preparedB.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', preparedB.prompt.key), { recursive: true, force: true }),
    ]);
  });

  assert.notEqual(preparedA.prompt.key, preparedB.prompt.key);
  assert.notEqual(preparedA.prompt.scope, preparedB.prompt.scope);
  assert.equal(
    JSON.parse(cache('show', '--prompt-key', preparedA.prompt.key)).definition.prompt.scope,
    preparedA.prompt.scope,
  );

  cache('definition-step', '--prompt', relativeA, '--id', 'inspect-order', '--title', 'Inspect order type');
  cache(
    'definition-branch',
    '--prompt', relativeA,
    '--name', 'order-route',
    '--condition', 'order type',
    '--route', 'physical=Use warehouse',
    '--route', 'virtual=Use license service',
  );
  cache(
    'page-init',
    '--prompt', relativeA,
    '--page', 'order-details',
    '--origin', 'https://orders.example',
    '--route', '/orders/*',
    '--title', 'Order details',
    '--anchor', 'Order type',
    '--viewport', '1440x900',
  );
  const learned = cache(
    'action-learn',
    '--prompt', relativeA,
    '--page', 'order-details',
    '--name', 'open-order',
    '--strategy', 'locator',
    '--target', "getByRole('link', { name: 'Order details' })",
    '--postcondition', 'Order details heading is visible',
  );
  const candidate = learned.match(/(candidate-[a-f0-9]+)/)?.[1];
  assert.ok(candidate);
  cache(
    'action-result',
    '--prompt', relativeA,
    '--page', 'order-details',
    '--name', 'open-order',
    '--candidate', candidate,
    '--status', 'success',
  );

  const pageA = JSON.parse(cache('page-show', '--prompt', relativeA, '--page', 'order-details'));
  assert.equal(pageA.actions['open-order'].candidates[0].successCount, 1);
  assert.throws(
    () => cache('page-show', '--prompt', relativeB, '--page', 'order-details'),
    /Page cache not found/,
  );

  const orderA = runId(run(
    'init',
    '--summary', 'Process order A',
    '--name', 'order-processing',
    '--prompt-key', preparedA.prompt.key,
    '--input', 'order.id=A',
  ));
  const orderB = runId(run(
    'init',
    '--summary', 'Process order B',
    '--name', 'order-processing',
    '--prompt-key', preparedA.prompt.key,
    '--input', 'order.id=B',
  ));
  createdRuns.push(orderA, orderB);
  const stateA = JSON.parse(run('show', '--run', orderA));
  const stateB = JSON.parse(run('show', '--run', orderB));
  assert.equal(stateA.prompt.scope, preparedA.prompt.scope);
  assert.equal(stateB.prompt.scope, preparedA.prompt.scope);
  assert.notDeepEqual(stateA.inputs, stateB.inputs);

  await writeFile(promptAPath, 'Process order ${input:orderId} with updated routing rules.\n', 'utf8');
  const updatedA = JSON.parse(cache('prepare', '--prompt', relativeA));
  assert.equal(updatedA.prompt.key, preparedA.prompt.key);
  assert.notEqual(updatedA.prompt.hash, preparedA.prompt.hash);
  assert.notEqual(updatedA.prompt.scope, preparedA.prompt.scope);
});

test('official Playwright Skill and prompt-first project guidance are present', () => {
  const officialSkill = join(root, '.agents', 'skills', 'playwright-cli', 'SKILL.md');
  const guidance = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(existsSync(officialSkill), true);
  assert.match(guidance, /The prompt is the workflow definition/);
  assert.match(guidance, /Do not require the user to create a Skill, YAML contract/);
  assert.match(guidance, /Prompt file identity plus its content hash/);
  assert.match(guidance, /Do not run a full snapshot on every successful cached action/);
  assert.equal(existsSync(join(root, 'workflows')), false);
  assert.equal(existsSync(join(root, 'skills')), false);
  assert.equal(existsSync(join(root, 'knowledge')), false);
  assert.equal(existsSync(join(root, 'src', 'browser')), false);
});
