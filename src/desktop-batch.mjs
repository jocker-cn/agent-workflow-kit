#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROOT, atomicWriteJson } from './cache-store.mjs';
import { activateWindow } from './windows-window.mjs';

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
  'extract-regex',
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
  'template',
  'wait-for',
  'window-info',
]);
const READ_COMMANDS = new Set([
  'extract-regex',
  'get-property',
  'get-value',
  'inspect',
  'search',
  'template',
  'window-info',
]);

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

function normalizeTarget(raw = {}, label = 'target') {
  if (!raw.app && !raw.process && !raw.title && !raw.hwnd) {
    throw new Error(`${label} requires app, process, title, or hwnd`);
  }
  const hwnd = raw.hwnd === undefined ? null : Number(raw.hwnd);
  if (hwnd !== null && (!Number.isInteger(hwnd) || hwnd <= 0)) {
    throw new Error(`${label}.hwnd must be a positive integer`);
  }
  let activation = null;
  if (raw.activation !== false) {
    const mode = raw.activation?.mode ?? 'auto';
    if (!['auto', 'activate', 'restore'].includes(mode)) {
      throw new Error(`${label}.activation.mode must be auto, activate, or restore`);
    }
    activation = {
      mode,
      timeoutMs: positiveNumber(raw.activation?.timeoutMs ?? 3000, `${label}.activation.timeoutMs`),
    };
  }
  return {
    app: String(raw.app ?? raw.process ?? raw.title ?? '').trim(),
    hwnd,
    title: String(raw.title ?? '').trim(),
    titleMode: raw.titleMode === 'exact' ? 'exact' : 'contains',
    process: String(raw.process ?? '').trim(),
    className: String(raw.className ?? '').trim(),
    preserveGeometry: raw.preserveGeometry !== false,
    geometryTolerancePx: positiveNumber(raw.geometryTolerancePx ?? 2, `${label}.geometryTolerancePx`, { allowZero: true }),
    activation,
  };
}

export function actionRequiresForeground(action) {
  if (['click', 'drag'].includes(action.command)) return true;
  if (action.command === 'send-keys') return action.via !== 'post-message';
  if (action.command === 'scroll') return action.wheel !== undefined;
  if (action.command === 'screenshot') return action.captureScreen === true;
  return false;
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
      window: raw.window ? safeId(raw.window, `${id}.window`) : '',
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
  if (command === 'extract-regex') {
    if (!raw.sourceFrom || !raw.pattern || !raw.saveAs) {
      throw new Error(`${id} requires sourceFrom, pattern, and saveAs`);
    }
    try {
      new RegExp(raw.pattern, raw.flags ?? '');
    } catch (error) {
      throw new Error(`${id} has an invalid regular expression: ${error.message}`);
    }
  }
  if (command === 'template' && (!raw.template || !raw.saveAs)) {
    throw new Error(`${id} requires template and saveAs`);
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
  const rawTargets = raw.targets
    ? Object.entries(raw.targets)
    : [['default', { ...(raw.target ?? {}), activation: raw.activation ?? raw.target?.activation }]];
  if (rawTargets.length === 0) throw new Error('Plan requires at least one target window');
  const targets = Object.fromEntries(rawTargets.map(([name, target]) => {
    const id = safeId(name, 'target name');
    return [id, normalizeTarget(target, `targets.${id}`)];
  }));
  const defaultTarget = Object.keys(targets)[0];
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
    throw new Error('Plan requires a non-empty actions array');
  }
  const ids = new Set();
  const actions = raw.actions.map((action, index) => {
    const windowName = action.window ? safeId(action.window, 'action window') : defaultTarget;
    if (!targets[windowName]) throw new Error(`Unknown action window: ${windowName}`);
    const normalized = normalizeAction(action, index, targets[windowName].preserveGeometry);
    normalized.window = windowName;
    if (ids.has(normalized.id)) throw new Error(`Duplicate action id: ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
  const screenshotPolicy = raw.evidence?.screenshot ?? 'boundary';
  if (!['boundary', 'failure', 'none'].includes(screenshotPolicy)) {
    throw new Error('evidence.screenshot must be boundary, failure, or none');
  }
  const evidenceWindow = raw.evidence?.window
    ? safeId(raw.evidence.window, 'evidence.window')
    : actions.at(-1).window;
  if (!targets[evidenceWindow]) throw new Error(`Unknown evidence window: ${evidenceWindow}`);
  return {
    schemaVersion: 1,
    id: safeId(raw.id ?? 'desktop-transaction', 'plan id'),
    description: String(raw.description ?? ''),
    targets,
    defaultTarget,
    actions,
    workflow: normalizeWorkflow(raw.workflow),
    boundary: raw.boundary ?? null,
    evidence: {
      screenshot: screenshotPolicy,
      file: raw.evidence?.file ? String(raw.evidence.file) : '',
      window: evidenceWindow,
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

function templateValue(template, values) {
  return String(template).replaceAll(/\$\{([^}]+)\}/g, (_, key) => {
    const value = nestedValue(values, key.trim());
    if (value === undefined) throw new Error(`Template value is missing: ${key.trim()}`);
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
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
  if (action.command === 'window-info') {
    const current = await resolveWindow(context.target);
    return { ...current, rectangle: context.rectangle };
  }
  if (action.command === 'extract-regex') {
    const source = nestedValue(values, action.sourceFrom);
    if (source === undefined) throw new Error(`Regex source is missing: ${action.sourceFrom}`);
    const match = String(source).match(new RegExp(action.pattern, action.flags ?? ''));
    if (!match) throw new Error(`Regex did not match ${action.sourceFrom}`);
    return match.groups ?? {
      match: match[0],
      captures: match.slice(1),
    };
  }
  if (action.command === 'template') return templateValue(action.template, values);
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
    if (!action.output) throw new Error(`${action.id}.output is required`);
    const output = artifactPath(
      action.output,
      context.runId,
      'diagnostics',
      context.planId,
      `${action.id}.output`,
    );
    await mkdir(dirname(output), { recursive: true });
    args.push('--output', output);
    if (action.captureScreen) args.push('--capture-screen');
  }
  args.push(...targetArgs(hwnd));
  return runWinApp(args);
}

function geometryChanged(before, after, tolerance) {
  return ['x', 'y', 'width', 'height'].some((key) => Math.abs(before[key] - after[key]) > tolerance);
}

function artifactRoot(runId, area, planId) {
  return join(RUNS_ROOT, runId ?? 'desktop-evidence', area, planId);
}

function artifactPath(value, runId, area, planId, label) {
  const absolute = value
    ? runScopedPath(value, runId, label)
    : join(artifactRoot(runId, area, planId), `${planId}.png`);
  const allowedRoot = artifactRoot(runId, area, planId);
  const fromAllowed = relative(allowedRoot, absolute);
  if (fromAllowed.startsWith('..') || isAbsolute(fromAllowed)) {
    throw new Error(`${label} must be inside ${relative(ROOT, allowedRoot).replaceAll('\\', '/')}`);
  }
  return absolute;
}

async function boundaryScreenshot(plan, runId, context, status) {
  const shouldCapture = plan.evidence.screenshot === 'boundary'
    || (plan.evidence.screenshot === 'failure' && status === 'failure');
  if (!shouldCapture) return null;
  const area = status === 'success' ? 'evidence' : 'diagnostics';
  const explicit = status === 'success' ? plan.evidence.file : '';
  const output = artifactPath(explicit, runId, area, plan.id, 'evidence.file');
  await mkdir(dirname(output), { recursive: true });
  const result = await runWinApp([
    'screenshot',
    '-w', String(context.window.hwnd),
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

async function prepareTarget(plan, name) {
  const target = plan.targets[name];
  let window = await resolveWindow(target);
  let activation = null;
  if (target.activation && target.activation.mode !== 'auto') {
    activation = await activateWindow(window.hwnd, {
      restore: target.activation.mode === 'restore',
      timeoutMs: target.activation.timeoutMs,
    });
    window = await resolveWindow(target);
  }
  return {
    name,
    target,
    window,
    activation,
    rectangle: await windowRectangle(window.hwnd),
  };
}

async function ensureForeground(context) {
  if (!context.target.activation || context.activation?.foreground) return context;
  const activation = await activateWindow(context.window.hwnd, {
    restore: context.target.activation.mode !== 'activate',
    timeoutMs: context.target.activation.timeoutMs,
  });
  context.window = await resolveWindow(context.target);
  context.activation = activation;
  if (activation.restored) context.rectangle = await windowRectangle(context.window.hwnd);
  return context;
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
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const results = [];
  const observations = {};
  values.observations = observations;
  const contexts = new Map();
  const contextFor = async (name) => {
    if (!contexts.has(name)) contexts.set(name, await prepareTarget(plan, name));
    return contexts.get(name);
  };
  let failure = null;
  for (const action of plan.actions) {
    const actionStartedAt = new Date().toISOString();
    const actionStarted = Date.now();
    try {
      let context = await contextFor(action.window);
      if (actionRequiresForeground(action)) context = await ensureForeground(context);
      const output = await executeAction(action, {
        ...context,
        hwnd: context.window.hwnd,
        values,
        runId,
        planId: plan.id,
      });
      if (READ_COMMANDS.has(action.command) && action.saveAs) {
        observations[action.saveAs] = output;
      }
      results.push({
        id: action.id,
        command: action.command,
        window: action.window,
        status: 'success',
        startedAt: actionStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - actionStarted,
      });
    } catch (error) {
      failure = {
        actionId: action.id,
        command: action.command,
        window: action.window,
        reason: error.message,
      };
      results.push({
        id: action.id,
        command: action.command,
        window: action.window,
        status: 'failure',
        reason: error.message,
        startedAt: actionStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - actionStarted,
      });
      break;
    }
  }
  const geometry = {};
  if (!failure) {
    for (const [name, context] of contexts) {
      const after = await windowRectangle(context.window.hwnd);
      const preserved = !context.target.preserveGeometry
        || !geometryChanged(context.rectangle, after, context.target.geometryTolerancePx);
      geometry[name] = { before: context.rectangle, after, preserved };
      if (!preserved) {
        failure = {
          actionId: 'boundary',
          command: 'geometry-check',
          window: name,
          reason: `Window geometry changed from ${JSON.stringify(context.rectangle)} to ${JSON.stringify(after)}`,
        };
        break;
      }
    }
  }
  const status = failure ? 'failure' : 'success';
  const screenshotWindow = status === 'failure'
    ? failure?.window ?? results.at(-1)?.window ?? plan.defaultTarget
    : plan.evidence.window;
  const evidenceContext = contexts.get(screenshotWindow)
    ?? await contextFor(plan.defaultTarget);
  const screenshot = await boundaryScreenshot(plan, runId, evidenceContext, status).catch((error) => {
    failure ??= { actionId: 'boundary', command: 'screenshot', reason: error.message };
    return null;
  });
  if (!failure) {
    await rm(artifactRoot(runId, 'diagnostics', plan.id), { recursive: true, force: true });
  }
  const targetResults = Object.fromEntries([...contexts].map(([name, context]) => [name, {
    hwnd: context.window.hwnd,
    processName: context.window.processName,
    title: context.window.title,
    className: context.window.className,
    activation: context.activation,
  }]));
  const result = {
    status: failure ? 'failure' : 'success',
    planId: plan.id,
    target: targetResults[plan.defaultTarget],
    targets: targetResults,
    geometry,
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
