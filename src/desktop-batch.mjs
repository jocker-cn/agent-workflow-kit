#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROOT, atomicWriteJson } from './cache-store.mjs';

const execFileAsync = promisify(execFile);
const RUNS_ROOT = join(ROOT, '.workflow-runs');
const WINAPP_CLI = join(
  ROOT,
  'node_modules',
  '@microsoft',
  'winappcli',
  'dist',
  'cli.js',
);
const COMMANDS = new Set([
  'click',
  'drag',
  'focus',
  'get-property',
  'get-value',
  'inspect',
  'invoke',
  'pause',
  'screenshot',
  'scroll',
  'search',
  'send-keys',
  'set-value',
  'wait-for',
]);
const READ_COMMANDS = new Set(['get-property', 'get-value', 'inspect', 'search']);

function usage(exitCode = 0) {
  console.log(`
Execute one declarative Windows desktop transaction through the repository-local WinAppCLI.

Usage:
  pnpm desktop:batch -- --file <.workflow-runs/.../desktop-transaction.json>
                         [--run <run-id>] [--input key=value]... [--dry-run true]

The runner preserves the target window geometry by default, resolves window-relative coordinates
against the current UIA window rectangle, runs all actions without returning to the model, and
captures a screenshot only at the transaction boundary or on failure.
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
    if (key === 'help') {
      flags.help = ['true'];
      continue;
    }
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

function safeRunId(value) {
  if (!/^[a-z0-9-]+$/.test(value ?? '')) throw new Error('Invalid run id');
  return value;
}

function safeId(value, label = 'id') {
  if (!/^[a-z][a-z0-9-]*$/.test(value ?? '')) {
    throw new Error(`${label} must use lowercase letters, digits, and hyphens`);
  }
  return value;
}

function setPath(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
  cursor[parts.at(-1)] = value;
}

function nestedValue(values, dottedKey) {
  return dottedKey.split('.').reduce((current, part) => current?.[part], values);
}

function parseAssignments(assignments = []) {
  const result = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    if (separator < 1) throw new Error('--input must use key=value format');
    setPath(result, assignment.slice(0, separator), assignment.slice(separator + 1));
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

function projectPath(value, label) {
  const absolute = resolve(ROOT, value);
  const fromRoot = relative(ROOT, absolute);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`${label} must be inside the project`);
  }
  return absolute;
}

function runScopedPath(value, runId, label) {
  const absolute = projectPath(value, label);
  const expectedRoot = runId ? join(RUNS_ROOT, runId) : RUNS_ROOT;
  const fromRun = relative(expectedRoot, absolute);
  if (fromRun.startsWith('..') || isAbsolute(fromRun)) {
    throw new Error(`${label} must be inside ${runId ? `.workflow-runs/${runId}` : '.workflow-runs'}`);
  }
  return absolute;
}

function positiveNumber(value, label, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} number`);
  }
  return parsed;
}

export function isGeometryChangingKeys(keys = '') {
  const normalized = String(keys).toLowerCase().replaceAll(/\s+/g, ' ').trim();
  return /(?:^| )(?:win\+(?:up|down|left|right)|alt\+space)(?: |$)/.test(normalized);
}

export function resolveRelativePoint(point, rectangle) {
  if (!point || typeof point !== 'object') throw new Error('A relative point is required');
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1) {
    throw new Error('Relative coordinates must be between 0 and 1');
  }
  return {
    x: Math.round(rectangle.x + (rectangle.width * x)),
    y: Math.round(rectangle.y + (rectangle.height * y)),
  };
}

function normalizeTarget(raw = {}) {
  if (!raw.app && !raw.process && !raw.title && !raw.hwnd) {
    throw new Error('target requires app, process, title, or hwnd');
  }
  const hwnd = raw.hwnd === undefined ? null : Number(raw.hwnd);
  if (hwnd !== null && (!Number.isInteger(hwnd) || hwnd <= 0)) {
    throw new Error('target.hwnd must be a positive integer');
  }
  return {
    app: String(raw.app ?? raw.process ?? raw.title ?? '').trim(),
    hwnd,
    title: String(raw.title ?? '').trim(),
    titleMode: raw.titleMode === 'exact' ? 'exact' : 'contains',
    process: String(raw.process ?? '').trim(),
    className: String(raw.className ?? '').trim(),
    preserveGeometry: raw.preserveGeometry !== false,
    geometryTolerancePx: positiveNumber(raw.geometryTolerancePx ?? 2, 'geometryTolerancePx', { allowZero: true }),
  };
}

function normalizePoint(raw, label) {
  if (typeof raw === 'string') {
    if (!/^-?\d+,-?\d+$/.test(raw)) throw new Error(`${label} screen point must use x,y`);
    return { space: 'screen', value: raw };
  }
  if (raw?.selector) return { space: 'selector', value: String(raw.selector) };
  if (raw?.relative) return { space: 'window', value: raw.relative };
  throw new Error(`${label} requires selector, relative coordinates, or an x,y screen point`);
}

function normalizeAction(raw, index, preserveGeometry) {
  const id = safeId(raw.id ?? `action-${index + 1}`, 'action id');
  const command = String(raw.command ?? '').trim();
  if (!COMMANDS.has(command)) throw new Error(`${id} has unsupported command: ${command}`);
  if (command === 'pause') {
    return {
      id,
      command,
      durationMs: positiveNumber(raw.durationMs ?? 100, `${id}.durationMs`, { allowZero: true }),
    };
  }
  if (command === 'send-keys' && preserveGeometry && isGeometryChangingKeys(raw.keys)) {
    throw new Error(`${id} changes window geometry while preserveGeometry is enabled`);
  }
  const action = {
    ...raw,
    id,
    command,
    timeoutMs: positiveNumber(raw.timeoutMs ?? 10000, `${id}.timeoutMs`, { allowZero: true }),
  };
  if (command === 'drag') {
    action.from = normalizePoint(raw.from, `${id}.from`);
    action.to = normalizePoint(raw.to, `${id}.to`);
  }
  if (command === 'click' && raw.relative) {
    action.point = normalizePoint({ relative: raw.relative }, `${id}.relative`);
  }
  if (command === 'set-value' && raw.value === undefined && !raw.valueFrom) {
    throw new Error(`${id} requires value or valueFrom`);
  }
  if (command === 'send-keys' && raw.keys === undefined && !raw.valueFrom) {
    throw new Error(`${id} requires keys or valueFrom`);
  }
  if (READ_COMMANDS.has(command) && raw.saveAs) safeId(raw.saveAs, `${id}.saveAs`);
  return action;
}

function normalizeWorkflow(raw) {
  if (!raw) return null;
  const nodeId = safeId(raw.nodeId, 'workflow.nodeId');
  const normalizeMappings = (items, label) => (items ?? []).map((item, index) => {
    if (!item?.key || !item?.from) throw new Error(`${label}[${index}] requires key and from`);
    return { key: String(item.key), from: String(item.from) };
  });
  return {
    nodeId,
    title: String(raw.title ?? nodeId),
    system: String(raw.system ?? ''),
    next: String(raw.next ?? 'Continue with the next workflow transaction'),
    routeId: raw.routeId ? safeId(raw.routeId, 'workflow.routeId') : '',
    routeSignature: String(raw.routeSignature ?? 'default'),
    facts: normalizeMappings(raw.facts, 'workflow.facts'),
    outputs: normalizeMappings(raw.outputs, 'workflow.outputs'),
  };
}

export function validateDesktopPlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Plan must be an object');
  const target = normalizeTarget(raw.target);
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
    throw new Error('Plan requires a non-empty actions array');
  }
  const ids = new Set();
  const actions = raw.actions.map((action, index) => {
    const normalized = normalizeAction(action, index, target.preserveGeometry);
    if (ids.has(normalized.id)) throw new Error(`Duplicate action id: ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
  const screenshotPolicy = raw.evidence?.screenshot ?? 'boundary';
  if (!['boundary', 'failure', 'none'].includes(screenshotPolicy)) {
    throw new Error('evidence.screenshot must be boundary, failure, or none');
  }
  return {
    schemaVersion: 1,
    id: safeId(raw.id ?? 'desktop-transaction', 'plan id'),
    description: String(raw.description ?? ''),
    target,
    activation: raw.activation ?? null,
    actions,
    workflow: normalizeWorkflow(raw.workflow),
    boundary: raw.boundary ?? null,
    evidence: {
      screenshot: screenshotPolicy,
      file: raw.evidence?.file ? String(raw.evidence.file) : '',
    },
  };
}

function parseJsonOutput(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = Math.max(text.lastIndexOf('\n{'), text.lastIndexOf('\n['));
    if (start >= 0) return JSON.parse(text.slice(start + 1));
    throw new Error(`Unexpected WinAppCLI output: ${text.slice(0, 800)}`);
  }
}

async function runWinApp(args) {
  if (!existsSync(WINAPP_CLI)) throw new Error('Local @microsoft/winappcli is not installed');
  const { stdout } = await execFileAsync(process.execPath, [WINAPP_CLI, 'ui', ...args, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return parseJsonOutput(stdout);
}

function windowMatches(window, target) {
  if (target.hwnd && window.hwnd !== target.hwnd) return false;
  if (target.process && window.processName.toLowerCase() !== target.process.toLowerCase()) return false;
  if (target.className && window.className !== target.className) return false;
  if (target.title) {
    const actual = String(window.title ?? '');
    if (target.titleMode === 'exact' ? actual !== target.title : !actual.includes(target.title)) return false;
  }
  return true;
}

async function resolveWindow(target) {
  const args = ['list-windows'];
  if (target.app) args.push('-a', target.app);
  const windows = await runWinApp(args);
  const matches = windows.filter((window) => windowMatches(window, target));
  if (matches.length === 0) throw new Error(`Target window not found: ${target.app || target.title || target.hwnd}`);
  if (matches.length > 1) {
    throw new Error(`Target window is ambiguous: ${matches.map((item) => `${item.hwnd}:${item.title}`).join(', ')}`);
  }
  return matches[0];
}

async function windowRectangle(hwnd) {
  const inspected = await runWinApp(['inspect', '-w', String(hwnd), '--depth', '1']);
  const root = inspected.windows?.[0]?.elements?.find((element) => element.type === 'Window')
    ?? inspected.windows?.[0]?.elements?.[0];
  if (!root || ![root.x, root.y, root.width, root.height].every(Number.isFinite)) {
    throw new Error(`Unable to read window rectangle for HWND ${hwnd}`);
  }
  return { x: root.x, y: root.y, width: root.width, height: root.height };
}

function targetArgs(hwnd) {
  return ['-w', String(hwnd)];
}

function scalarValue(action, values) {
  if (!action.valueFrom) return action.value ?? action.keys;
  if (action.valueFrom.startsWith('env.')) {
    const name = action.valueFrom.slice(4);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable: ${name}`);
    if (process.env[name] === undefined) throw new Error(`Environment variable is not set: ${name}`);
    return process.env[name];
  }
  const value = nestedValue(values, action.valueFrom);
  if (value === undefined) throw new Error(`Runtime value is missing: ${action.valueFrom}`);
  return value;
}

function pointArgument(point, rectangle) {
  if (point.space === 'selector' || point.space === 'screen') return point.value;
  const resolved = resolveRelativePoint(point.value, rectangle);
  return `${resolved.x},${resolved.y}`;
}

async function executeAction(action, context) {
  const { hwnd, rectangle, values } = context;
  if (action.command === 'pause') {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, action.durationMs));
    return { durationMs: action.durationMs };
  }
  const args = [action.command];
  if (action.command === 'click' && action.point) {
    const point = pointArgument(action.point, rectangle);
    return runWinApp(['drag', point, point, ...targetArgs(hwnd)]);
  }
  if (action.command === 'drag') {
    args.push(pointArgument(action.from, rectangle), pointArgument(action.to, rectangle));
    if (action.button === 'right') args.push('--right');
    if (action.holdMs !== undefined) args.push('--hold-ms', String(action.holdMs));
    if (action.dwellMs !== undefined) args.push('--dwell-ms', String(action.dwellMs));
  } else if (['invoke', 'click', 'focus', 'get-value', 'search', 'inspect'].includes(action.command)) {
    if (action.selector) args.push(String(action.selector));
    if (action.command === 'inspect' && action.depth !== undefined) args.push('--depth', String(action.depth));
    if (action.command === 'inspect' && action.interactive) args.push('--interactive');
  } else if (action.command === 'get-property') {
    args.push(String(action.selector), '--property', String(action.property));
  } else if (action.command === 'set-value') {
    args.push(String(action.selector), String(scalarValue(action, values)));
  } else if (action.command === 'send-keys') {
    args.push(String(scalarValue(action, values)));
    if (action.target) args.push('--target', String(action.target));
    args.push('--via', action.via === 'post-message' ? 'post-message' : 'send-input');
    if (action.verbatim || action.valueFrom) args.push('--verbatim');
    if (action.allowSystemKeys) args.push('--allow-system-keys');
  } else if (action.command === 'wait-for') {
    args.push(String(action.selector));
    if (action.gone) args.push('--gone');
    if (action.property) args.push('--property', String(action.property));
    if (action.value !== undefined) args.push('--value', String(action.value));
    if (action.contains) args.push('--contains');
    args.push('--timeout', String(action.timeoutMs));
  } else if (action.command === 'scroll') {
    if (action.selector) args.push(String(action.selector));
    if (action.direction) args.push('--direction', String(action.direction));
    if (action.to) args.push('--to', String(action.to));
    if (action.wheel !== undefined) args.push('--wheel', String(action.wheel));
  } else if (action.command === 'screenshot') {
    if (action.selector) args.push(String(action.selector));
    const output = runScopedPath(action.output, context.runId, `${action.id}.output`);
    await mkdir(dirname(output), { recursive: true });
    args.push('--output', output);
    if (action.captureScreen) args.push('--capture-screen');
    if (action.focus !== false) args.push('--focus');
  }
  args.push(...targetArgs(hwnd));
  return runWinApp(args);
}

function geometryChanged(before, after, tolerance) {
  return ['x', 'y', 'width', 'height'].some((key) => Math.abs(before[key] - after[key]) > tolerance);
}

async function boundaryScreenshot(plan, runId, hwnd, status) {
  const shouldCapture = plan.evidence.screenshot === 'boundary'
    || (plan.evidence.screenshot === 'failure' && status === 'failure');
  if (!shouldCapture) return null;
  const fallback = join(
    '.workflow-runs',
    runId ?? 'desktop-evidence',
    `${plan.id}-${status}.png`,
  );
  const output = runScopedPath(plan.evidence.file || fallback, runId, 'evidence.file');
  await mkdir(dirname(output), { recursive: true });
  const result = await runWinApp([
    'screenshot',
    '-w', String(hwnd),
    '--focus',
    '--output', output,
  ]);
  return result.filePath ?? output;
}

async function loadRuntimeValues(runId, explicitInputs) {
  const values = {};
  if (runId) {
    const statePath = join(RUNS_ROOT, runId, 'state.json');
    if (!existsSync(statePath)) throw new Error(`Run not found: ${runId}`);
    const run = JSON.parse(await readFile(statePath, 'utf8'));
    mergeDeep(values, run.inputs ?? {});
    mergeDeep(values, run.facts ?? {});
    mergeDeep(values, run.data ?? {});
  }
  return mergeDeep(values, explicitInputs);
}

function mappedValues(mappings, source, label) {
  return mappings.map(({ key, from }) => {
    const value = nestedValue(source, from);
    if (value === undefined) throw new Error(`${label} mapping is missing: ${from}`);
    return { key, value };
  });
}

async function writeWorkflowBoundary(plan, runId, result) {
  if (!runId || !plan.workflow) return null;
  const workflow = plan.workflow;
  const mappingSource = { observations: result.observations, result };
  const payload = {
    runStatus: result.status === 'success' ? 'active' : 'repair_required',
    step: {
      id: workflow.nodeId,
      title: workflow.title,
      status: result.status === 'success' ? 'completed' : 'blocked',
      note: result.status === 'success'
        ? `Desktop transaction ${plan.id} completed`
        : `Desktop transaction ${plan.id} failed at ${result.failure?.actionId ?? 'boundary'}`,
    },
    facts: result.status === 'success'
      ? mappedValues(workflow.facts, mappingSource, 'fact').map((item) => ({
          ...item,
          source: `Desktop transaction ${plan.id}`,
        }))
      : [],
    outputs: result.status === 'success'
      ? mappedValues(workflow.outputs, mappingSource, 'output')
      : [],
    cursor: {
      step: workflow.nodeId,
      next: result.status === 'success'
        ? workflow.next
        : `Repair desktop transaction ${plan.id} from ${result.failure?.actionId ?? 'boundary'}`,
      system: workflow.system,
      url: '',
    },
    recipe: workflow.routeId ? {
      selections: [{
        nodeId: workflow.nodeId,
        routeId: workflow.routeId,
        routeSignature: workflow.routeSignature,
      }],
    } : undefined,
    telemetry: {
      kind: 'desktop-transaction',
      batchId: `${plan.id}-${Date.now()}`,
      nodeId: workflow.nodeId,
      routeId: workflow.routeId,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      durationMs: result.durationMs,
      status: result.status,
    },
    evidence: [{
      kind: 'desktop-transaction-boundary',
      value: plan.id,
      data: {
        status: result.status,
        failedAction: result.failure?.actionId ?? null,
        screenshot: result.evidence.screenshot,
        geometry: result.geometry,
        observations: result.observations,
      },
    }],
  };
  const path = join(RUNS_ROOT, runId, 'last-boundary.json');
  await atomicWriteJson(path, payload);
  return relative(ROOT, path).replaceAll('\\', '/');
}

async function activate(plan, hwnd) {
  if (!plan.activation) return;
  const action = normalizeAction({
    id: 'activate-window',
    command: 'send-keys',
    ...plan.activation,
  }, 0, false);
  await executeAction(action, {
    hwnd,
    rectangle: await windowRectangle(hwnd),
    values: {},
    runId: null,
  });
  const timeoutMs = positiveNumber(plan.activation.timeoutMs ?? 5000, 'activation.timeoutMs');
  const deadline = Date.now() + timeoutMs;
  do {
    const window = await resolveWindow(plan.target).catch(() => null);
    if (window && window.width > 100 && window.height > 100) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  } while (Date.now() <= deadline);
  throw new Error('Target window did not become interactive after activation');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) usage();
  const runId = one(flags, 'run', false) ? safeRunId(one(flags, 'run', false)) : null;
  const file = runScopedPath(one(flags, 'file'), runId, '--file');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const plan = validateDesktopPlan(raw);
  const dryRun = (one(flags, 'dry-run', false) ?? 'false') === 'true';
  if (dryRun) {
    console.log(JSON.stringify({ status: 'ready', plan }, null, 2));
    return;
  }
  const values = await loadRuntimeValues(runId, parseAssignments(flags.input ?? []));
  let window = await resolveWindow(plan.target);
  await activate(plan, window.hwnd);
  window = await resolveWindow(plan.target);
  const rectangle = await windowRectangle(window.hwnd);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const results = [];
  const observations = {};
  let failure = null;
  for (const action of plan.actions) {
    const actionStartedAt = new Date().toISOString();
    const actionStarted = Date.now();
    try {
      const output = await executeAction(action, {
        hwnd: window.hwnd,
        rectangle,
        values,
        runId,
      });
      if (READ_COMMANDS.has(action.command) && action.saveAs) {
        observations[action.saveAs] = output;
      }
      results.push({
        id: action.id,
        command: action.command,
        status: 'success',
        startedAt: actionStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - actionStarted,
      });
    } catch (error) {
      failure = { actionId: action.id, command: action.command, reason: error.message };
      results.push({
        id: action.id,
        command: action.command,
        status: 'failure',
        reason: error.message,
        startedAt: actionStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - actionStarted,
      });
      break;
    }
  }
  let finalRectangle = null;
  if (!failure && plan.target.preserveGeometry) {
    finalRectangle = await windowRectangle(window.hwnd);
    if (geometryChanged(rectangle, finalRectangle, plan.target.geometryTolerancePx)) {
      failure = {
        actionId: 'boundary',
        command: 'geometry-check',
        reason: `Window geometry changed from ${JSON.stringify(rectangle)} to ${JSON.stringify(finalRectangle)}`,
      };
    }
  }
  const status = failure ? 'failure' : 'success';
  const screenshot = await boundaryScreenshot(plan, runId, window.hwnd, status).catch((error) => {
    failure ??= { actionId: 'boundary', command: 'screenshot', reason: error.message };
    return null;
  });
  const result = {
    status: failure ? 'failure' : 'success',
    planId: plan.id,
    target: {
      hwnd: window.hwnd,
      processName: window.processName,
      title: window.title,
      className: window.className,
    },
    geometry: {
      before: rectangle,
      after: finalRectangle ?? rectangle,
      preserved: !failure || failure.command !== 'geometry-check',
    },
    results,
    observations,
    evidence: { screenshot },
    failure,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
  if (runId) {
    const resultPath = join(RUNS_ROOT, runId, `desktop-${plan.id}-result.json`);
    await atomicWriteJson(resultPath, result);
    result.resultFile = relative(ROOT, resultPath).replaceAll('\\', '/');
    result.commitFile = await writeWorkflowBoundary(plan, runId, result);
  }
  console.log(JSON.stringify(result, null, 2));
  if (failure) process.exitCode = 2;
}

const isEntryPoint = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
