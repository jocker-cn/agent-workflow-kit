#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ROOT,
  atomicWriteJson,
  cachePaths,
  normalizeDefinition,
  readJson,
  resolvePromptSelection,
  resolveWorkflowRecipe,
} from './cache-store.mjs';

const execFileAsync = promisify(execFile);
const RUNS_ROOT = join(ROOT, '.workflow-runs');
const PLAYWRIGHT_CLI = join(ROOT, 'node_modules', '@playwright', 'cli', 'playwright-cli.js');

function usage(exitCode = 0) {
  console.log(`
Cached workflow recipe runner

Usage:
  pnpm run recipe -- --run <run-id> --node <node-id>
              [--prompt <file> | --prompt-key <key>] [--value key=value]...
              [--dry-run true]

The runner resolves one guarded business node, verifies each page variant at entry, executes its
safe cached actions in one official Playwright CLI run-code call, verifies one business-boundary
expectation, updates action telemetry, and writes a workflow commit payload.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    (flags[key] ??= []).push(value);
    index += 1;
  }
  return flags;
}

function one(flags, name, required = true) {
  const value = flags[name]?.at(-1)?.trim();
  if (!value && required) throw new Error(`--${name} is required`);
  return value;
}

function safeName(value, label = 'name') {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`${label} must use lowercase letters, digits, and hyphens`);
  }
  return value;
}

function safeRunId(value) {
  if (!/^[a-z0-9-]+$/.test(value)) throw new Error('Invalid run id');
  return value;
}

function setPath(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
  cursor[parts.at(-1)] = value;
}

function parseValues(values = []) {
  const result = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error('--value must use key=value format');
    setPath(result, value.slice(0, separator), value.slice(separator + 1));
  }
  return result;
}

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      mergeDeep(target[key] ??= {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function nestedValue(values, dottedKey) {
  return dottedKey.split('.').reduce((current, part) => current?.[part], values);
}

function normalizePage(page) {
  if (page.variants) return page;
  return {
    schemaVersion: 2,
    prompt: page.prompt,
    id: page.id,
    variants: {
      default: {
        id: 'default',
        context: {},
        fingerprint: page.fingerprint ?? {},
        actions: page.actions ?? {},
        invalidatedAt: page.invalidatedAt ?? null,
        invalidationReason: page.invalidationReason ?? '',
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      },
    },
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function healthyCandidate(action) {
  return [...action.candidates]
    .filter((candidate) => candidate.selector && candidate.consecutiveFailures < 3)
    .sort((left, right) => {
      if (left.consecutiveFailures !== right.consecutiveFailures) {
        return left.consecutiveFailures - right.consecutiveFailures;
      }
      return right.successCount - left.successCount;
    })[0];
}

function selectorCode(selector) {
  const value = JSON.stringify(selector.value);
  if (selector.kind === 'css') return `page.locator(${value})`;
  if (selector.kind === 'role') {
    return `page.getByRole(${JSON.stringify(selector.role)}, { name: ${value}, exact: true })`;
  }
  if (selector.kind === 'text') return `page.getByText(${value}, { exact: false })`;
  if (selector.kind === 'label') return `page.getByLabel(${value}, { exact: true })`;
  if (selector.kind === 'placeholder') return `page.getByPlaceholder(${value}, { exact: true })`;
  if (selector.kind === 'testid') return `page.getByTestId(${value})`;
  throw new Error(`Unsupported selector kind: ${selector.kind}`);
}

function runtimeValueCode(valueFrom, values) {
  if (!valueFrom) throw new Error('Fill/select action requires valueFrom');
  if (valueFrom.startsWith('env.')) {
    const variable = valueFrom.slice(4);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(variable)) throw new Error(`Invalid environment variable: ${variable}`);
    if (process.env[variable] === undefined) throw new Error(`Environment variable is not set: ${variable}`);
    return `process.env[${JSON.stringify(variable)}]`;
  }
  const value = nestedValue(values, valueFrom);
  if (value === undefined) throw new Error(`Runtime value is missing: ${valueFrom}`);
  return JSON.stringify(String(value));
}

function operationCode(action, locator, values) {
  if (action.operation === 'click') return `await ${locator}.click()`;
  if (action.operation === 'fill') return `await ${locator}.fill(${runtimeValueCode(action.valueFrom, values)})`;
  if (action.operation === 'select') {
    return `await ${locator}.selectOption(${runtimeValueCode(action.valueFrom, values)})`;
  }
  if (action.operation === 'check') return `await ${locator}.check()`;
  if (action.operation === 'uncheck') return `await ${locator}.uncheck()`;
  if (action.operation === 'extract') return `__extracted[${JSON.stringify(action.extractTo)}] = (await ${locator}.textContent())?.trim() ?? ''`;
  throw new Error(`Unsupported operation: ${action.operation}`);
}

function fingerprintCode(fingerprint) {
  return `await __verifyPage(${JSON.stringify({
    origin: fingerprint.origin ?? '',
    route: fingerprint.route ?? '',
    title: fingerprint.title ?? '',
    anchors: fingerprint.anchors ?? [],
  })})`;
}

function expectationCode(expectation, actionLookup) {
  if (expectation.kind === 'text') {
    return `await page.getByText(${JSON.stringify(expectation.value)}, { exact: false }).first().waitFor({ state: 'visible' })`;
  }
  if (expectation.kind === 'url') {
    return `await page.waitForURL(${JSON.stringify(expectation.value)})`;
  }
  if (expectation.kind === 'action') {
    const key = `${expectation.page}@${expectation.variant ?? 'default'}/${expectation.action}`;
    const selected = actionLookup.get(key);
    if (!selected) throw new Error(`Expectation action is not batchable: ${key}`);
    return `await ${selectorCode(selected.candidate.selector)}.waitFor({ state: 'visible' })`;
  }
  throw new Error(`Unsupported expectation kind: ${expectation.kind}`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) usage();
  const runId = safeRunId(one(flags, 'run'));
  const nodeId = safeName(one(flags, 'node'), 'node id');
  const runPath = join(RUNS_ROOT, runId, 'state.json');
  if (!existsSync(runPath)) throw new Error(`Run not found: ${runId}`);
  const run = JSON.parse(await readFile(runPath, 'utf8'));
  const identity = await resolvePromptSelection({
    prompt: one(flags, 'prompt', false),
    promptKey: one(flags, 'prompt-key', false) ?? run.prompt?.key,
  });
  if (run.prompt?.scope && run.prompt.scope !== identity.scope) {
    throw new Error(`Run prompt scope ${run.prompt.scope} does not match ${identity.scope}`);
  }
  const paths = cachePaths(identity);
  const definition = normalizeDefinition(await readJson(paths.definitionPath));
  const values = mergeDeep(
    mergeDeep(mergeDeep({}, run.inputs ?? {}), run.facts ?? {}),
    run.data ?? {},
  );
  mergeDeep(values, parseValues(flags.value ?? []));
  const resolution = resolveWorkflowRecipe(definition, values, nodeId);
  if (resolution.status !== 'ready' || resolution.resolved.length !== 1) {
    console.log(JSON.stringify({
      status: resolution.status,
      recipeVersion: definition.compiled.version,
      ...resolution,
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  const selectedRoute = resolution.resolved[0];
  if (selectedRoute.type !== 'browser') {
    throw new Error(`Node ${nodeId} is not a browser node`);
  }
  if (!selectedRoute.expectation) {
    throw new Error(`Route ${nodeId}/${selectedRoute.routeId} has no executable boundary expectation`);
  }

  const loadedPages = new Map();
  const actionLookup = new Map();
  const selectedActions = [];
  for (const reference of selectedRoute.actions) {
    let loaded = loadedPages.get(reference.page);
    if (!loaded) {
      const path = join(paths.pagesDir, `${reference.page}.json`);
      if (!existsSync(path)) throw new Error(`Page cache not found: ${reference.page}`);
      loaded = { path, page: normalizePage(await readJson(path)) };
      loadedPages.set(reference.page, loaded);
    }
    const variantId = reference.variant ?? 'default';
    const variant = loaded.page.variants[variantId];
    if (!variant) throw new Error(`Page variant not found: ${reference.page}/${variantId}`);
    if (variant.invalidatedAt) throw new Error(`Page variant is invalidated: ${reference.page}/${variantId}`);
    const action = variant.actions[reference.action];
    if (!action) throw new Error(`Cached action not found: ${reference.page}/${reference.action}`);
    const candidate = healthyCandidate(action);
    if (!candidate) throw new Error(`No healthy batchable candidate: ${reference.page}/${reference.action}`);
    const selected = { reference, loaded, variant, action, candidate };
    selectedActions.push(selected);
    actionLookup.set(`${reference.page}@${variantId}/${reference.action}`, selected);
  }

  const lines = [
    'async page => {',
    '  const __results = [];',
    '  const __extracted = {};',
    '  const __verifyPage = async expected => {',
    '    const currentUrl = page.url();',
    '    if (expected.origin && currentUrl !== expected.origin && !currentUrl.startsWith(`${expected.origin}/`)) throw new Error(`origin:${currentUrl}`);',
    '    if (expected.route) {',
    '      const pattern = new RegExp(`^${expected.route.split("*").map(part => part.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")).join(".*")}$`);',
    '      const routeTarget = expected.route.includes("://") ? currentUrl : currentUrl.slice(expected.origin.length);',
    '      if (!pattern.test(routeTarget)) throw new Error(`route:${routeTarget}`);',
    '    }',
    '    if (expected.title && !(await page.title()).includes(expected.title)) throw new Error(`title:${await page.title()}`);',
    '    for (const anchor of expected.anchors) {',
    '      if (await page.getByText(anchor, { exact: false }).count() === 0) throw new Error(`anchor:${anchor}`);',
    '    }',
    '  };',
    '  try {',
  ];
  let previousPageVariant = '';
  for (const selected of selectedActions) {
    const pageVariant = `${selected.reference.page}@${selected.reference.variant ?? 'default'}`;
    if (pageVariant !== previousPageVariant) {
      lines.push(`    ${fingerprintCode(selected.variant.fingerprint)};`);
      previousPageVariant = pageVariant;
    }
    const locator = selectorCode(selected.candidate.selector);
    lines.push('    {');
    lines.push('      const __startedAt = new Date().toISOString();');
    lines.push('      const __started = Date.now();');
    lines.push('      try {');
    lines.push(`        ${operationCode(selected.action, locator, values)};`);
    lines.push(`        __results.push({ page: ${JSON.stringify(selected.reference.page)}, variant: ${JSON.stringify(selected.reference.variant ?? 'default')}, name: ${JSON.stringify(selected.reference.action)}, candidate: ${JSON.stringify(selected.candidate.id)}, status: 'success', startedAt: __startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - __started, cacheHit: true });`);
    lines.push('      } catch (error) {');
    lines.push(`        __results.push({ page: ${JSON.stringify(selected.reference.page)}, variant: ${JSON.stringify(selected.reference.variant ?? 'default')}, name: ${JSON.stringify(selected.reference.action)}, candidate: ${JSON.stringify(selected.candidate.id)}, status: 'failure', startedAt: __startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - __started, cacheHit: true, reason: error.message });`);
    lines.push('        throw error;');
    lines.push('      }');
    lines.push('    }');
  }
  lines.push('    const __postStarted = Date.now();');
  lines.push(`    ${expectationCode(selectedRoute.expectation, actionLookup)};`);
  lines.push("    return JSON.stringify({ status: 'success', results: __results, extracted: __extracted, postconditionDurationMs: Date.now() - __postStarted, url: page.url() });");
  lines.push('  } catch (error) {');
  lines.push("    return JSON.stringify({ status: 'failure', results: __results, extracted: __extracted, reason: error.message, url: page.url() });");
  lines.push('  }');
  lines.push('}');
  const script = `${lines.join('\n')}\n`;
  try {
    Function(`return (${script})`);
  } catch (error) {
    throw new Error(`Generated Playwright batch is invalid: ${error.message}`);
  }

  if ((one(flags, 'dry-run', false) ?? 'false') === 'true') {
    console.log(JSON.stringify({
      status: 'ready',
      recipeVersion: definition.compiled.version,
      nodeId,
      routeId: selectedRoute.routeId,
      routeSignature: selectedRoute.routeSignature,
      actionCount: selectedActions.length,
      actions: selectedActions.map(({ reference, action, candidate }) => ({
        ...reference,
        operation: action.operation,
        candidateId: candidate.id,
        selector: candidate.selector,
      })),
      expectation: selectedRoute.expectation,
    }, null, 2));
    return;
  }

  if (!existsSync(PLAYWRIGHT_CLI)) throw new Error('Local @playwright/cli is not installed');
  const batchId = `${nodeId}-${Date.now()}`;
  const temporaryScript = join(RUNS_ROOT, runId, `.${batchId}.js`);
  await mkdir(join(RUNS_ROOT, runId), { recursive: true });
  await writeFile(temporaryScript, script, 'utf8');
  const batchStartedAt = new Date().toISOString();
  const batchStarted = Date.now();
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [
      PLAYWRIGHT_CLI,
      `-s=${runId}`,
      '--raw',
      'run-code',
      `--filename=${temporaryScript}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }));
  } finally {
    await rm(temporaryScript, { force: true });
  }
  let result = JSON.parse(stdout.trim());
  if (typeof result === 'string') result = JSON.parse(result);
  if (!result || !Array.isArray(result.results)) {
    throw new Error(`Unexpected Playwright batch result: ${stdout.trim().slice(0, 1000)}`);
  }
  const finishedAt = new Date().toISOString();
  const resultsByAction = new Map(result.results.map((item) => [
    `${item.page}@${item.variant}/${item.name}`,
    item,
  ]));
  for (const selected of selectedActions) {
    const key = `${selected.reference.page}@${selected.reference.variant ?? 'default'}/${selected.reference.action}`;
    const actionResult = resultsByAction.get(key);
    if (!actionResult) continue;
    const candidate = selected.candidate;
    if (actionResult.status === 'success') {
      candidate.successCount += 1;
      candidate.consecutiveFailures = 0;
      candidate.lastSuccessAt = actionResult.endedAt;
      delete candidate.lastFailureReason;
    } else {
      candidate.failureCount += 1;
      candidate.consecutiveFailures += 1;
      candidate.lastFailureAt = actionResult.endedAt;
      candidate.lastFailureReason = actionResult.reason ?? result.reason ?? '';
    }
    candidate.lastExecution = {
      batchId,
      ...actionResult,
      postconditionDurationMs: result.postconditionDurationMs ?? 0,
    };
    candidate.updatedAt = finishedAt;
    selected.action.history ??= [];
    selected.action.history.push({ candidateId: candidate.id, ...candidate.lastExecution });
    selected.action.history = selected.action.history.slice(-20);
    selected.action.updatedAt = finishedAt;
    selected.variant.updatedAt = finishedAt;
    selected.loaded.page.updatedAt = finishedAt;
  }
  await Promise.all([...loadedPages.values()].map(({ path, page }) => atomicWriteJson(path, page)));

  const commitPayload = {
    step: {
      id: nodeId,
      title: selectedRoute.title,
      status: result.status === 'success' ? 'completed' : 'blocked',
      note: result.status === 'success'
        ? `Cached route ${selectedRoute.routeId} completed`
        : `Cached route ${selectedRoute.routeId} failed: ${result.reason}`,
    },
    facts: Object.entries(result.extracted ?? {}).map(([key, value]) => ({
      key,
      value,
      source: `Cached browser route ${nodeId}/${selectedRoute.routeId}`,
    })),
    recipe: {
      version: definition.compiled.version,
      selections: [{
        nodeId,
        routeId: selectedRoute.routeId,
        routeSignature: selectedRoute.routeSignature,
      }],
    },
    telemetry: {
      batchId,
      nodeId,
      routeId: selectedRoute.routeId,
      startedAt: batchStartedAt,
      endedAt: finishedAt,
      durationMs: Date.now() - batchStarted,
      status: result.status,
    },
  };
  const commitPath = join(RUNS_ROOT, runId, 'last-boundary.json');
  await atomicWriteJson(commitPath, commitPayload);
  console.log(JSON.stringify({
    ...result,
    batchId,
    recipeVersion: definition.compiled.version,
    nodeId,
    routeId: selectedRoute.routeId,
    routeSignature: selectedRoute.routeSignature,
    commitFile: `.workflow-runs/${runId}/last-boundary.json`,
  }, null, 2));
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
