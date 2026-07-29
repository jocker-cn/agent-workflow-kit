import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { compileWorkflowSpec } from '../src/workflow-compiler.mjs';

const root = resolve(import.meta.dirname, '..');
const workflowctl = join(root, 'src', 'workflowctl.mjs');
const cachectl = join(root, 'src', 'cachectl.mjs');
const workflowCompiler = join(root, 'src', 'workflow-compiler.mjs');
const recipeRunner = join(root, 'src', 'recipe-runner.mjs');
const workflowRunner = join(root, 'src', 'workflow-runner.mjs');

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

function compile(...args) {
  return execFileSync(process.execPath, [workflowCompiler, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function recipe(...args) {
  return execFileSync(process.execPath, [recipeRunner, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function execute(...args) {
  return execFileSync(process.execPath, [workflowRunner, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function executeWithEnv(env, ...args) {
  return execFileSync(process.execPath, [workflowRunner, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
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

test('definitions are versioned while page caches are reused only within one prompt identity', async (t) => {
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
  const reusedPage = JSON.parse(cache(
    'page-show', '--prompt-key', updatedA.prompt.key, '--page', 'order-details',
  ));
  assert.equal(reusedPage.pageId, 'order-details');
});

test('parameterized recipes isolate type A and B routes and stop on an unknown type', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptPath = join(promptDir, `recipe-${suffix}.prompt.md`);
  const relativePrompt = `.github/prompts/recipe-${suffix}.prompt.md`;
  const commitPath = join(root, `.recipe-commit-${suffix}.json`);
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptPath, 'Process an order according to its observed type.\n', 'utf8');
  const prepared = JSON.parse(cache('prepare', '--prompt', relativePrompt));
  let id;
  t.after(async () => {
    if (id) await removeRun(id);
    await Promise.all([
      rm(promptPath, { force: true }),
      rm(commitPath, { force: true }),
      rm(join(root, '.workflow-cache', 'definitions', prepared.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', prepared.prompt.key), { recursive: true, force: true }),
    ]);
  });

  cache(
    'recipe-node', '--prompt-key', prepared.prompt.key,
    '--id', 'process-order', '--title', 'Process order by type',
    '--depends-on', 'order.type',
  );
  cache(
    'page-init', '--prompt-key', prepared.prompt.key,
    '--page', 'order-details', '--origin', 'https://orders.example',
    '--route', '/orders/*', '--title', 'Order details', '--anchor', 'Order type',
  );
  cache(
    'page-init', '--prompt-key', prepared.prompt.key,
    '--page', 'order-details', '--variant', 'specialist',
    '--context', 'role=specialist', '--origin', 'https://orders.example',
    '--route', '/orders/*', '--title', 'Order details', '--anchor', 'Risk level',
  );
  const actionAOutput = cache(
    'action-learn', '--prompt-key', prepared.prompt.key,
    '--page', 'order-details', '--name', 'normal-approval',
    '--strategy', 'locator', '--locator-kind', 'role', '--role', 'button',
    '--target', 'Normal approval', '--operation', 'click',
    '--postcondition', 'Normal approval panel is visible',
  );
  const actionBOutput = cache(
    'action-learn', '--prompt-key', prepared.prompt.key,
    '--page', 'order-details', '--variant', 'specialist', '--name', 'special-approval',
    '--strategy', 'locator', '--locator-kind', 'role', '--role', 'button',
    '--target', 'Special approval', '--operation', 'click',
    '--postcondition', 'Special approval panel is visible',
  );
  assert.match(actionAOutput, /candidate-/);
  assert.match(actionBOutput, /candidate-/);
  cache(
    'recipe-route', '--prompt-key', prepared.prompt.key,
    '--node', 'process-order', '--id', 'type-a', '--when', 'order.type=A',
    '--action', 'order-details/normal-approval',
    '--expect-action', 'order-details/normal-approval',
    '--postcondition', 'Normal approval is available',
  );
  cache(
    'recipe-route', '--prompt-key', prepared.prompt.key,
    '--node', 'process-order', '--id', 'type-b', '--when', 'order.type=B',
    '--action', 'order-details@specialist/special-approval',
    '--expect-action', 'order-details@specialist/special-approval',
    '--transition-timeout-ms', '15000',
    '--postcondition', 'Special approval is available',
  );

  const typeA = JSON.parse(cache(
    'recipe-resolve', '--prompt-key', prepared.prompt.key, '--value', 'order.type=A',
  ));
  const typeB = JSON.parse(cache(
    'recipe-resolve', '--prompt-key', prepared.prompt.key, '--value', 'order.type=B',
  ));
  const typeC = JSON.parse(cache(
    'recipe-resolve', '--prompt-key', prepared.prompt.key, '--value', 'order.type=C',
  ));
  const missingType = JSON.parse(cache('recipe-resolve', '--prompt-key', prepared.prompt.key));
  assert.equal(typeA.status, 'ready');
  assert.equal(typeA.resolved[0].routeId, 'type-a');
  assert.equal(typeB.resolved[0].routeId, 'type-b');
  assert.equal(typeB.resolved[0].actions[0].variant, 'specialist');
  assert.equal(typeC.status, 'needs-learning');
  assert.equal(typeC.unknown[0].observed['order.type'], 'C');
  assert.equal(missingType.status, 'needs-facts');

  id = runId(run(
    'init', '--summary', 'Process order B', '--name', 'order-processing',
    '--prompt-key', prepared.prompt.key, '--input', 'order.id=B-100',
  ));
  await writeFile(commitPath, JSON.stringify({
    step: {
      id: 'process-order',
      title: 'Process order by type',
      status: 'in_progress',
      note: 'Type B route selected',
    },
    facts: [{ key: 'order.type', value: 'B', source: 'Order details page' }],
    decisions: [{
      name: 'order-route',
      selected: 'type-b',
      reason: 'Observed order.type B',
    }],
    outputs: [{ key: 'result.route', value: 'special-approval' }],
    cursor: {
      step: 'process-order',
      next: 'Execute the cached Type B route',
      system: 'orders',
      url: 'https://orders.example/orders/B-100',
    },
    recipe: {
      version: typeB.recipeVersion,
      selections: [{
        nodeId: 'process-order',
        routeId: 'type-b',
        routeSignature: 'order.type=B',
      }],
    },
    telemetry: {
      batchId: 'resolve-type-b',
      nodeId: 'process-order',
      routeId: 'type-b',
      durationMs: 12,
      orchestrationGapMs: 0,
      status: 'success',
    },
  }, null, 2), 'utf8');
  run('commit', '--run', id, '--file', `.recipe-commit-${suffix}.json`);

  const state = JSON.parse(run('show', '--run', id));
  assert.equal(state.facts.order.type, 'B');
  assert.equal(state.data.result.route, 'special-approval');
  assert.equal(state.recipe.selections[0].routeId, 'type-b');
  assert.equal(state.executionHistory[0].durationMs, 12);

  const dryRun = JSON.parse(recipe(
    '--run', id, '--node', 'process-order', '--dry-run', 'true',
  ));
  assert.equal(dryRun.routeId, 'type-b');
  assert.equal(dryRun.transitionTimeoutMs, 15000);
  assert.equal(dryRun.pageGroups.length, 1);
  assert.equal(dryRun.pageGroups[0].pageVariant, 'order-details@specialist');
  assert.equal(dryRun.actionCount, 1);
  assert.equal(dryRun.actions[0].variant, 'specialist');
  assert.deepEqual(dryRun.actions[0].selector, {
    kind: 'role',
    value: 'Special approval',
    role: 'button',
  });
  const continuousDryRun = JSON.parse(execute(
    '--run', id, '--value', 'order.type=B', '--dry-run', 'true',
  ));
  assert.equal(continuousDryRun.status, 'ready');
  assert.equal(continuousDryRun.executed.length, 1);
  assert.equal(continuousDryRun.executed[0].nodeId, 'process-order');
});

test('workflow compiler reorders scattered prompt work by dependencies and fuses page affinity', () => {
  const compiled = compileWorkflowSpec({
    workflow: {
      name: 'resource-validation',
      description: 'Validate a resource across two sites',
    },
    transactions: [
      {
        id: 'search-resource',
        title: 'Search the resource',
        description: 'Apply filters on the result page',
        affinity: {
          system: 'jinsuitui',
          page: 'video-resource-results',
          state: 'filtered',
          tab: 'main',
        },
        requires: ['session.authenticated'],
        produces: ['search.exists'],
        asserts: [{ key: 'search.exists', value: true }],
        operations: [{ id: 'apply-filter', description: 'Apply the search filter' }],
      },
      {
        id: 'verify-bilibili',
        title: 'Verify Bilibili',
        affinity: {
          system: 'bilibili',
          page: 'video',
          state: 'loaded',
          tab: 'resource',
        },
        requires: ['search.videoUrl'],
        produces: ['video.author'],
      },
      {
        id: 'collect-search-fields',
        title: 'Collect fields mentioned later in the Prompt',
        description: 'Collect the reference range and video URL from the existing result',
        affinity: {
          system: 'jinsuitui',
          page: 'video-resource-results',
          state: 'filtered',
          tab: 'main',
        },
        requires: ['search.exists'],
        produces: ['search.referenceFollowers', 'search.videoUrl'],
        operations: [{ id: 'collect-fields', kind: 'collect', description: 'Collect all result fields' }],
      },
    ],
  });

  assert.equal(compiled.optimization.sourceTransactionCount, 3);
  assert.equal(compiled.optimization.executableTransactionCount, 2);
  assert.equal(compiled.optimization.fusedTransactionCount, 1);
  assert.deepEqual(compiled.nodes[0].sourceNodeIds, ['search-resource', 'collect-search-fields']);
  assert.deepEqual(compiled.nodes[0].produces, [
    'search.exists',
    'search.referenceFollowers',
    'search.videoUrl',
  ]);
  assert.deepEqual(compiled.nodes[0].asserts, [{ key: 'search.exists', value: true, description: '' }]);
  assert.equal(compiled.nodes[1].id, 'verify-bilibili');
  assert.equal(compiled.nodes[0].description.includes('reference range'), true);
});

test('recipe guards normalize scalar values from workflow facts', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptPath = join(promptDir, `scalar-${suffix}.prompt.md`);
  const relativePrompt = `.github/prompts/scalar-${suffix}.prompt.md`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptPath, 'Use a boolean result to select a route.\n', 'utf8');
  const prepared = JSON.parse(cache('prepare', '--prompt', relativePrompt));
  t.after(async () => {
    await Promise.all([
      rm(promptPath, { force: true }),
      rm(join(root, '.workflow-cache', 'definitions', prepared.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', prepared.prompt.key), { recursive: true, force: true }),
    ]);
  });
  cache(
    'recipe-node', '--prompt-key', prepared.prompt.key,
    '--id', 'report-result', '--title', 'Report result',
    '--node-class', 'report', '--depends-on', 'result.valid',
  );
  cache(
    'recipe-route', '--prompt-key', prepared.prompt.key,
    '--node', 'report-result', '--id', 'valid',
    '--when', 'result.valid=true', '--status', 'learned',
    '--postcondition', 'Report the valid result',
  );
  const definitionPath = join(
    root,
    '.workflow-cache',
    'definitions',
    prepared.prompt.key,
    `${prepared.prompt.hash}.json`,
  );
  const definition = JSON.parse(readFileSync(definitionPath, 'utf8'));
  const { resolveWorkflowRecipe } = await import('../src/cache-store.mjs');
  const resolution = resolveWorkflowRecipe(definition, { result: { valid: true } });
  assert.equal(resolution.status, 'ready');
  assert.equal(resolution.resolved[0].routeId, 'valid');
});

test('cache clear previews exact targets and can clear pages or the complete prompt workflow', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptPath = join(promptDir, `clear-${suffix}.prompt.md`);
  const relativePrompt = `.github/prompts/clear-${suffix}.prompt.md`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptPath, 'Open a page and cache it.\n', 'utf8');
  const prepared = JSON.parse(cache('prepare', '--prompt', relativePrompt));
  const definitionsRoot = join(root, '.workflow-cache', 'definitions', prepared.prompt.key);
  const pagesRoot = join(root, '.workflow-cache', 'pages', prepared.prompt.key);
  t.after(async () => {
    await Promise.all([
      rm(promptPath, { force: true }),
      rm(definitionsRoot, { recursive: true, force: true }),
      rm(pagesRoot, { recursive: true, force: true }),
    ]);
  });
  cache(
    'page-init', '--prompt-key', prepared.prompt.key,
    '--page', 'cached-page', '--origin', 'https://example.com',
    '--route', '/*', '--anchor', 'Example',
  );

  const preview = JSON.parse(cache(
    'clear', '--prompt-key', prepared.prompt.key, '--scope', 'workflow',
  ));
  assert.equal(preview.status, 'preview');
  assert.equal(existsSync(definitionsRoot), true);
  assert.equal(existsSync(pagesRoot), true);

  const clearedPages = JSON.parse(cache(
    'clear', '--prompt-key', prepared.prompt.key,
    '--scope', 'pages', '--apply', 'true',
  ));
  assert.equal(clearedPages.status, 'cleared');
  assert.equal(existsSync(pagesRoot), false);
  assert.equal(existsSync(definitionsRoot), true);

  cache(
    'clear', '--prompt-key', prepared.prompt.key,
    '--scope', 'workflow', '--apply', 'true',
  );
  assert.equal(existsSync(definitionsRoot), false);
});

test('compiler safely merges learned routes when same-page transactions are fused', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptPath = join(promptDir, `migration-${suffix}.prompt.md`);
  const compilerPath = join(root, `.compiler-migration-${suffix}.json`);
  const relativePrompt = `.github/prompts/migration-${suffix}.prompt.md`;
  const relativeCompiler = `.compiler-migration-${suffix}.json`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptPath, 'Collect two fields from one result page.\n', 'utf8');
  const prepared = JSON.parse(cache('prepare', '--prompt', relativePrompt));
  t.after(async () => {
    await Promise.all([
      rm(promptPath, { force: true }),
      rm(compilerPath, { force: true }),
      rm(join(root, '.workflow-cache', 'definitions', prepared.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', prepared.prompt.key), { recursive: true, force: true }),
    ]);
  });
  cache(
    'recipe-node', '--prompt-key', prepared.prompt.key,
    '--id', 'search-resource', '--title', 'Search resource',
  );
  cache(
    'recipe-node', '--prompt-key', prepared.prompt.key,
    '--id', 'collect-fields', '--title', 'Collect fields',
  );
  cache(
    'page-init', '--prompt-key', prepared.prompt.key,
    '--page', 'result-page', '--origin', 'https://example.com',
    '--route', '/results', '--anchor', 'Results',
  );
  cache(
    'action-learn', '--prompt-key', prepared.prompt.key,
    '--page', 'result-page', '--name', 'apply-filter',
    '--strategy', 'locator', '--locator-kind', 'role', '--role', 'button',
    '--target', 'Filter', '--operation', 'click', '--postcondition', 'Results visible',
  );
  cache(
    'action-learn', '--prompt-key', prepared.prompt.key,
    '--page', 'result-page', '--name', 'collect-result',
    '--strategy', 'locator', '--locator-kind', 'text',
    '--target', 'Result', '--operation', 'extract', '--extract-to', 'search.result',
    '--postcondition', 'Result collected',
  );
  cache(
    'recipe-route', '--prompt-key', prepared.prompt.key,
    '--node', 'search-resource', '--id', 'default',
    '--action', 'result-page/apply-filter', '--expect-action', 'result-page/apply-filter',
  );
  cache(
    'recipe-route', '--prompt-key', prepared.prompt.key,
    '--node', 'collect-fields', '--id', 'default',
    '--action', 'result-page/collect-result', '--expect-action', 'result-page/collect-result',
  );
  await writeFile(compilerPath, JSON.stringify({
    workflow: {
      name: 'migration-test',
      description: 'Fuse compatible page transactions without losing learned routes',
    },
    transactions: [
      {
        id: 'search-resource',
        title: 'Search resource',
        affinity: { system: 'example', page: 'results', state: 'filtered', tab: 'main' },
        produces: ['search.ready'],
      },
      {
        id: 'collect-fields',
        title: 'Collect fields',
        affinity: { system: 'example', page: 'results', state: 'filtered', tab: 'main' },
        after: ['search-resource'],
        produces: ['search.result'],
        collects: ['search.result'],
      },
    ],
  }, null, 2), 'utf8');

  const result = JSON.parse(compile(
    '--prompt-key', prepared.prompt.key, '--file', relativeCompiler,
  ));
  assert.equal(result.optimization.fusedTransactionCount, 1);
  assert.deepEqual(result.migrationWarnings, []);
  const recipeDefinition = JSON.parse(cache('recipe-show', '--prompt-key', prepared.prompt.key));
  assert.equal(recipeDefinition.nodes.length, 1);
  assert.deepEqual(
    recipeDefinition.nodes[0].routes[0].actions.map((action) => action.action),
    ['apply-filter', 'collect-result'],
  );
  assert.equal(recipeDefinition.nodes[0].routes[0].expectation.action, 'collect-result');
});

test('continuous runner persists human boundaries then completes decision and report locally', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptPath = join(promptDir, `local-runner-${suffix}.prompt.md`);
  const compilerPath = join(root, `.compiler-local-${suffix}.json`);
  const relativePrompt = `.github/prompts/local-runner-${suffix}.prompt.md`;
  const relativeCompiler = `.compiler-local-${suffix}.json`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptPath, 'Wait for a human, choose a route, and report.\n', 'utf8');
  const prepared = JSON.parse(cache('prepare', '--prompt', relativePrompt));
  let id;
  t.after(async () => {
    if (id) await removeRun(id);
    await Promise.all([
      rm(promptPath, { force: true }),
      rm(compilerPath, { force: true }),
      rm(join(root, '.workflow-cache', 'definitions', prepared.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', prepared.prompt.key), { recursive: true, force: true }),
    ]);
  });
  const defaultRoute = {
    id: 'default',
    when: {},
    signature: 'default',
    status: 'learned',
    actions: [],
    postcondition: '',
    expectation: null,
  };
  await writeFile(compilerPath, JSON.stringify({
    workflow: {
      name: 'local-runner',
      summary: 'Human and local nodes',
      description: 'Descriptions must be available when a new Agent resumes the run',
    },
    outputs: [{ key: 'result.summary', description: 'Locally rendered result' }],
    transactions: [
      {
        id: 'human-check',
        title: 'Wait for human',
        description: 'Wait until the user finishes the visible verification step',
        type: 'human',
        barrier: 'human',
      },
      {
        id: 'choose-route',
        title: 'Choose route',
        description: 'Resolve a cached decision without the model',
        type: 'decision',
        after: ['human-check'],
        routes: [defaultRoute],
      },
      {
        id: 'report-result',
        title: 'Report result',
        description: 'Render the result from saved facts',
        type: 'report',
        after: ['choose-route'],
        computes: [{
          key: 'result.summary',
          target: 'output',
          op: 'template',
          template: 'Route ${result.route} completed',
        }],
        routes: [defaultRoute],
      },
    ],
  }, null, 2), 'utf8');
  compile('--prompt-key', prepared.prompt.key, '--file', relativeCompiler);
  id = runId(run(
    'init', '--summary', 'Test local runner', '--name', 'local-runner',
    '--prompt-key', prepared.prompt.key, '--input', 'result.route=default',
  ));

  const waiting = JSON.parse(execute('--run', id));
  assert.equal(waiting.status, 'waiting');
  assert.equal(JSON.parse(run('show', '--run', id)).status, 'waiting');
  run('resume', '--run', id);
  const completed = JSON.parse(execute('--run', id));
  assert.equal(completed.status, 'workflow-segment-complete');
  assert.deepEqual(
    completed.executed.map((item) => item.nodeId),
    ['human-check', 'choose-route', 'report-result'],
  );
  const state = JSON.parse(run('show', '--run', id));
  assert.equal(state.status, 'active');
  assert.equal(state.plan.every((step) => step.status === 'completed'), true);
  assert.equal(state.decisions.at(-1).selected, 'default');
  assert.equal(state.data.result.summary, 'Route default completed');
  assert.equal(state.executionHistory.at(-1).kind, 'segment');
  assert.match(run('context', '--run', id), /Descriptions must be available/);
});

test('continuous runner commits a failed browser transaction before returning repair-required', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptPath = join(promptDir, `failure-${suffix}.prompt.md`);
  const compilerPath = join(root, `.compiler-failure-${suffix}.json`);
  const fakeRunnerPath = join(root, `.fake-recipe-${suffix}.mjs`);
  const relativePrompt = `.github/prompts/failure-${suffix}.prompt.md`;
  const relativeCompiler = `.compiler-failure-${suffix}.json`;
  const relativeFakeRunner = `.fake-recipe-${suffix}.mjs`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptPath, 'Run one cached browser transaction.\n', 'utf8');
  const prepared = JSON.parse(cache('prepare', '--prompt', relativePrompt));
  let id;
  t.after(async () => {
    if (id) await removeRun(id);
    await Promise.all([
      rm(promptPath, { force: true }),
      rm(compilerPath, { force: true }),
      rm(fakeRunnerPath, { force: true }),
      rm(join(root, '.workflow-cache', 'definitions', prepared.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', prepared.prompt.key), { recursive: true, force: true }),
    ]);
  });
  await writeFile(compilerPath, JSON.stringify({
    workflow: { name: 'failure-test' },
    transactions: [{
      id: 'browser-step',
      title: 'Browser step',
      type: 'browser',
      affinity: { system: 'example', page: 'home', state: 'ready', tab: 'main' },
      routes: [{
        id: 'default',
        when: {},
        signature: 'default',
        status: 'learned',
        actions: [],
        postcondition: '',
        expectation: null,
      }],
    }],
  }, null, 2), 'utf8');
  compile('--prompt-key', prepared.prompt.key, '--file', relativeCompiler);
  id = runId(run(
    'init', '--summary', 'Test failure state', '--name', 'failure-test',
    '--prompt-key', prepared.prompt.key,
  ));
  await writeFile(fakeRunnerPath, `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const runId = value('--run');
const nodeId = value('--node');
const commitFile = \`.workflow-runs/\${runId}/last-boundary.json\`;
await writeFile(join(process.cwd(), commitFile), JSON.stringify({
  runStatus: 'repair_required',
  step: { id: nodeId, title: 'Browser step', status: 'blocked', note: 'Synthetic failure' },
  cursor: { step: nodeId, next: 'Repair browser step', system: 'example', url: 'https://example.com' },
  telemetry: { kind: 'transaction', batchId: 'fake', nodeId, durationMs: 1, status: 'failure' }
}));
console.log(JSON.stringify({
  status: 'failure',
  routeId: 'default',
  batchId: 'fake',
  reason: 'Synthetic failure',
  url: 'https://example.com',
  results: [],
  commitFile
}));
`, 'utf8');

  assert.throws(
    () => executeWithEnv({ AGENT_WORKFLOW_RECIPE_RUNNER: relativeFakeRunner }, '--run', id),
  );
  const state = JSON.parse(run('show', '--run', id));
  assert.equal(state.status, 'repair_required');
  assert.equal(state.plan[0].status, 'blocked');
  assert.equal(state.cursor.currentStep, 'browser-step');
});

test('risk boundaries remain waiting until the exact node is confirmed', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptPath = join(promptDir, `risk-${suffix}.prompt.md`);
  const compilerPath = join(root, `.compiler-risk-${suffix}.json`);
  const relativePrompt = `.github/prompts/risk-${suffix}.prompt.md`;
  const relativeCompiler = `.compiler-risk-${suffix}.json`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptPath, 'Publish only after explicit confirmation.\n', 'utf8');
  const prepared = JSON.parse(cache('prepare', '--prompt', relativePrompt));
  let id;
  t.after(async () => {
    if (id) await removeRun(id);
    await Promise.all([
      rm(promptPath, { force: true }),
      rm(compilerPath, { force: true }),
      rm(join(root, '.workflow-cache', 'definitions', prepared.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', prepared.prompt.key), { recursive: true, force: true }),
    ]);
  });
  await writeFile(compilerPath, JSON.stringify({
    workflow: { name: 'risk-test' },
    transactions: [{
      id: 'publish-result',
      title: 'Publish result',
      description: 'Publish the exact reviewed result',
      type: 'report',
      barrier: 'risk',
      risk: 'irreversible',
      authorization: {
        mode: 'runtime',
        scope: 'Publish the reviewed result',
      },
      routes: [{
        id: 'default',
        when: {},
        signature: 'default',
        status: 'learned',
        actions: [],
        expectation: null,
      }],
    }],
  }, null, 2), 'utf8');
  compile('--prompt-key', prepared.prompt.key, '--file', relativeCompiler);
  id = runId(run(
    'init', '--summary', 'Test risk boundary', '--name', 'risk-test',
    '--prompt-key', prepared.prompt.key,
  ));

  assert.equal(JSON.parse(execute('--run', id)).status, 'waiting');
  assert.equal(JSON.parse(run('show', '--run', id)).status, 'waiting');
  run('confirm', '--run', id, '--action', 'publish-result', '--by', 'test-user');
  const completed = JSON.parse(execute('--run', id));
  assert.equal(completed.status, 'workflow-segment-complete');
  assert.equal(completed.executed[0].nodeId, 'publish-result');
  assert.equal(JSON.parse(run('show', '--run', id)).plan[0].status, 'completed');
});

test('a bounded write explicitly authorized by the Prompt does not pause for confirmation', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptPath = join(promptDir, `prompt-authorized-${suffix}.prompt.md`);
  const compilerPath = join(root, `.compiler-prompt-authorized-${suffix}.json`);
  const relativePrompt = `.github/prompts/prompt-authorized-${suffix}.prompt.md`;
  const relativeCompiler = `.compiler-prompt-authorized-${suffix}.json`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptPath, 'Generate and submit num resources without per-item confirmation.\n', 'utf8');
  const prepared = JSON.parse(cache('prepare', '--prompt', relativePrompt));
  let id;
  t.after(async () => {
    if (id) await removeRun(id);
    await Promise.all([
      rm(promptPath, { force: true }),
      rm(compilerPath, { force: true }),
      rm(join(root, '.workflow-cache', 'definitions', prepared.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', prepared.prompt.key), { recursive: true, force: true }),
    ]);
  });
  await writeFile(compilerPath, JSON.stringify({
    workflow: { name: 'prompt-authorized-write' },
    inputs: [{ key: 'num', required: true, structural: false }],
    transactions: [{
      id: 'submit-resources',
      title: 'Submit requested resources',
      description: 'Submit the bounded number of generated resources requested by the Prompt',
      type: 'report',
      risk: 'irreversible',
      barrier: 'none',
      authorization: {
        mode: 'prompt',
        scope: 'Create resources in the requested target',
        countFrom: 'num',
        maxCount: 10,
        constraints: ['Use only Prompt-declared random value ranges'],
      },
      routes: [{
        id: 'default',
        when: {},
        signature: 'default',
        status: 'learned',
        actions: [],
        expectation: null,
      }],
    }],
  }, null, 2), 'utf8');
  const compiled = JSON.parse(compile(
    '--prompt-key', prepared.prompt.key, '--file', relativeCompiler,
  ));
  assert.equal(compiled.nodes[0].risk, 'irreversible');
  assert.equal(compiled.nodes[0].barrier, 'none');
  assert.equal(compiled.nodes[0].authorization.mode, 'prompt');
  id = runId(run(
    'init', '--summary', 'Submit two resources', '--name', 'prompt-authorized-write',
    '--prompt-key', prepared.prompt.key, '--input', 'num=2',
  ));

  const dryRun = JSON.parse(execute('--run', id, '--dry-run', 'true'));
  assert.equal(dryRun.status, 'ready');
  assert.equal(dryRun.executed[0].authorizationMode, 'prompt');
  assert.equal(dryRun.executed[0].authorizedCount, 2);

  const completed = JSON.parse(execute('--run', id));
  assert.equal(completed.status, 'workflow-segment-complete');
  assert.equal(completed.executed[0].nodeId, 'submit-resources');
  const state = JSON.parse(run('show', '--run', id));
  assert.equal(state.status, 'active');
  assert.equal(state.plan[0].status, 'completed');
  assert.deepEqual(state.authorizations, {});
});

test('page switching and coordinate vision actions are batchable cached operations', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const promptDir = join(root, '.github', 'prompts');
  const promptPath = join(promptDir, `page-actions-${suffix}.prompt.md`);
  const relativePrompt = `.github/prompts/page-actions-${suffix}.prompt.md`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(promptPath, 'Switch to a new tab and click a visual widget.\n', 'utf8');
  const prepared = JSON.parse(cache('prepare', '--prompt', relativePrompt));
  let id;
  t.after(async () => {
    if (id) await removeRun(id);
    await Promise.all([
      rm(promptPath, { force: true }),
      rm(join(root, '.workflow-cache', 'definitions', prepared.prompt.key), { recursive: true, force: true }),
      rm(join(root, '.workflow-cache', 'pages', prepared.prompt.key), { recursive: true, force: true }),
    ]);
  });
  cache(
    'recipe-node', '--prompt-key', prepared.prompt.key,
    '--id', 'switch-and-click', '--title', 'Switch and click',
  );
  cache(
    'page-init', '--prompt-key', prepared.prompt.key,
    '--page', 'source-page', '--origin', 'https://source.example',
    '--route', '/*', '--anchor', 'Open target', '--viewport', '1440x900',
  );
  cache(
    'action-learn', '--prompt-key', prepared.prompt.key,
    '--page', 'source-page', '--name', 'switch-target',
    '--strategy', 'page', '--target', 'https://target.example/*',
    '--operation', 'switch-page', '--tab-role', 'resource',
    '--postcondition', 'Target tab selected',
  );
  cache(
    'action-learn', '--prompt-key', prepared.prompt.key,
    '--page', 'source-page', '--name', 'visual-widget',
    '--strategy', 'vision', '--target', '320,240',
    '--operation', 'click', '--postcondition', 'Widget opened',
  );
  cache(
    'action-learn', '--prompt-key', prepared.prompt.key,
    '--page', 'source-page', '--name', 'wait-for-target-row',
    '--strategy', 'css', '--target', 'tbody tr',
    '--operation', 'wait', '--wait-for', 'stable', '--stable-ms', '250',
    '--timeout-ms', '5000', '--has-text-from', 'resource.name',
    '--match-mode', 'first', '--postcondition', 'Requested row is stable',
  );
  cache(
    'recipe-route', '--prompt-key', prepared.prompt.key,
    '--node', 'switch-and-click', '--id', 'default',
    '--action', 'source-page/switch-target',
    '--action', 'source-page/visual-widget',
    '--action', 'source-page/wait-for-target-row',
    '--expect-action', 'source-page/switch-target',
  );
  id = runId(run(
    'init', '--summary', 'Test page actions', '--name', 'page-actions',
    '--prompt-key', prepared.prompt.key, '--input', 'resource.name=example',
  ));
  const dryRun = JSON.parse(recipe('--run', id, '--node', 'switch-and-click', '--dry-run', 'true'));
  assert.equal(dryRun.actions[0].target, 'https://target.example/*');
  assert.equal(dryRun.actions[0].tabRole, 'resource');
  assert.deepEqual(dryRun.actions[1].point, { x: 320, y: 240 });
  assert.equal(dryRun.actions[2].operation, 'wait');
  assert.equal(dryRun.actions[2].hasTextFrom, 'resource.name');
  assert.equal(dryRun.actions[2].matchMode, 'first');
  assert.equal(dryRun.actions[2].waitFor, 'stable');
});

test('official Playwright Skill and prompt-first project guidance are present', () => {
  const officialSkill = join(root, '.agents', 'skills', 'playwright-cli', 'SKILL.md');
  const compilerSkill = join(root, '.agents', 'skills', 'compile-browser-workflows', 'SKILL.md');
  const guidance = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(existsSync(officialSkill), true);
  assert.equal(existsSync(compilerSkill), true);
  assert.match(guidance, /The prompt is the workflow definition/);
  assert.match(guidance, /Do not require the user to create a Skill, YAML contract/);
  assert.match(guidance, /definitions are versioned by Prompt file identity plus content hash/i);
  assert.match(guidance, /Stable page actions are\s+shared across content versions/);
  assert.match(guidance, /parameterized Workflow Recipe/);
  assert.match(guidance, /workflow commit/);
  assert.match(guidance, /Do not pre-check and post-check every cached click or fill/);
  assert.match(guidance, /num=N.*bounded batch/i);
  assert.match(guidance, /risk.*authorization.*barrier/i);
  assert.match(guidance, /pnpm execute/);
  assert.match(guidance, /Prompt paragraph order is a soft hint/);
  assert.equal(existsSync(join(root, 'workflows')), false);
  assert.equal(existsSync(join(root, 'skills')), false);
  assert.equal(existsSync(join(root, 'knowledge')), false);
  assert.equal(existsSync(join(root, 'src', 'browser')), false);
});
