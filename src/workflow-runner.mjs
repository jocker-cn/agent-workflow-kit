#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ROOT,
  assertCacheHygiene,
  atomicWriteJson,
  cachePaths,
  normalizeDefinition,
  readJson,
  resolvePromptSelection,
  resolveWorkflowRecipe,
} from './cache-store.mjs';

const execFileAsync = promisify(execFile);
const RUNS_ROOT = join(ROOT, '.workflow-runs');
const RECIPE_RUNNER = process.env.AGENT_WORKFLOW_RECIPE_RUNNER
  ? resolve(ROOT, process.env.AGENT_WORKFLOW_RECIPE_RUNNER)
  : join(ROOT, 'src', 'recipe-runner.mjs');
const WORKFLOW_CTL = join(ROOT, 'src', 'workflowctl.mjs');

function usage(exitCode = 0) {
  console.log(`
Continuously execute cached workflow transactions without returning to the Agent between nodes.

Usage:
  pnpm execute -- --run <run-id> [--from <node-id>] [--value key=value]...
                       [--dry-run true] [--max-nodes <count>] [--retries <count>]

Browser, decision, and report nodes execute locally. Execution pauses for human or unconfirmed
high-risk boundaries and records failures as repair_required before returning to the Agent.
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

function safeName(value, label = 'name') {
  if (!/^[a-z][a-z0-9-]*$/.test(value ?? '')) {
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

function parseValues(assignments = []) {
  const values = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    if (separator < 1) throw new Error('--value must use key=value format');
    setPath(values, assignment.slice(0, separator), assignment.slice(separator + 1));
  }
  return values;
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

function localizedNumber(value) {
  if (typeof value === 'number') return value;
  const normalized = String(value ?? '').replaceAll(',', '').trim();
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) throw new Error(`Cannot parse number from: ${value}`);
  const multiplier = /万/.test(normalized) ? 10000 : /亿/.test(normalized) ? 100000000 : 1;
  return Number(match[0]) * multiplier;
}

function localizedRange(value) {
  const parts = String(value ?? '').split(/\s*(?:-|–|—|~|至)\s*/).filter(Boolean);
  if (parts.length !== 2) throw new Error(`Cannot parse range from: ${value}`);
  return { min: localizedNumber(parts[0]), max: localizedNumber(parts[1]) };
}

function computationSource(computation, values, key = 'from') {
  if (computation[key] !== undefined) return nestedValue(values, computation[key]);
  if (computation.value !== undefined) return computation.value;
  throw new Error(`Computation ${computation.key} requires ${key} or value`);
}

function evaluateComputation(computation, values) {
  switch (computation.op) {
    case 'copy':
      return computationSource(computation, values);
    case 'set':
      return computation.value;
    case 'parse-number':
      return localizedNumber(computationSource(computation, values));
    case 'parse-range':
      return localizedRange(computationSource(computation, values));
    case 'equals':
      return computationSource(computation, values) === computationSource(computation, values, 'otherFrom');
    case 'contains':
      return String(computationSource(computation, values))
        .includes(String(computationSource(computation, values, 'otherFrom')));
    case 'between': {
      const value = localizedNumber(computationSource(computation, values));
      const range = computation.rangeFrom
        ? nestedValue(values, computation.rangeFrom)
        : computation.range;
      if (!range || range.min === undefined || range.max === undefined) {
        throw new Error(`Computation ${computation.key} requires rangeFrom or range`);
      }
      return value >= localizedNumber(range.min) && value <= localizedNumber(range.max);
    }
    case 'conditional':
      return nestedValue(values, computation.when)
        ? computation.trueValue
        : computation.falseValue;
    case 'template':
      return String(computation.template ?? '').replace(/\$\{([^}]+)\}/g, (_, key) => {
        const value = nestedValue(values, key.replace(/^(?:fact|input|output):/, ''));
        if (value === undefined) throw new Error(`Template value is missing: ${key}`);
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
      });
    default:
      throw new Error(`Unsupported local computation: ${computation.op}`);
  }
}

function localComputationPayload(node, run, explicitValues) {
  const values = transactionValues(run, explicitValues);
  const facts = [];
  const outputs = [];
  for (const computation of node.computes ?? []) {
    const value = evaluateComputation(computation, values);
    setPath(values, computation.key, value);
    const item = {
      key: computation.key,
      value,
      source: `Local ${node.type} computation ${node.id}/${computation.op}`,
    };
    if (computation.target === 'output') outputs.push({ key: item.key, value: item.value });
    else facts.push(item);
  }
  return { facts, outputs, values };
}

function flattenAssignments(value, prefix = '', output = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenAssignments(child, prefix ? `${prefix}.${key}` : key, output);
    }
  } else if (prefix) {
    output.push(`${prefix}=${Array.isArray(value) ? JSON.stringify(value) : String(value ?? '')}`);
  }
  return output;
}

function deterministicNumber(seed) {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) / 0x100000000;
}

function mergeGeneratorSpec(base, override) {
  const merged = structuredClone(base ?? {});
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergeGeneratorSpec(merged[key], value);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function deterministicPermutation(values, seed, cycle = 0) {
  return values
    .map((value, index) => ({
      value,
      score: deterministicNumber(`${seed}\0cycle=${cycle}\0candidate=${index}`),
    }))
    .sort((left, right) => left.score - right.score)
    .map(({ value }) => value);
}

function renderTemplate(template, values) {
  return String(template ?? '').replace(/\$\{([^}]+)\}/g, (_, key) => {
    const value = nestedValue(values, key);
    if (value === undefined) {
      const error = new Error(`Iteration template value is missing: ${key}`);
      error.code = 'ITERATION_VALUE_MISSING';
      throw error;
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

function generatedValue(spec, values, seed, { index = 0, total = 1 } = {}) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  switch (spec.op ?? 'literal') {
    case 'literal':
      return spec.value;
    case 'copy': {
      const value = nestedValue(values, spec.from);
      if (value === undefined) {
        const error = new Error(`Iteration copy value is missing: ${spec.from}`);
        error.code = 'ITERATION_VALUE_MISSING';
        throw error;
      }
      return value;
    }
    case 'template':
      return renderTemplate(spec.template, values);
    case 'random-int': {
      const min = Number(spec.min);
      const max = Number(spec.max);
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new Error('random-int requires integer min and max with max >= min');
      }
      return min + Math.floor(deterministicNumber(`${seed}\0index=${index}`) * (max - min + 1));
    }
    case 'choice': {
      if (!Array.isArray(spec.values) || spec.values.length === 0) {
        throw new Error('choice requires a non-empty values array');
      }
      const selection = spec.selection ?? 'random';
      let value;
      if (selection === 'random') {
        value = spec.values[
          Math.floor(deterministicNumber(`${seed}\0index=${index}`) * spec.values.length)
        ];
      } else if (selection === 'cycle') {
        value = spec.values[index % spec.values.length];
      } else if (['balanced', 'shuffle-cycle', 'unique'].includes(selection)) {
        if (selection === 'unique' && total > spec.values.length) {
          throw new Error(
            `unique choice requires at least ${total} values, received ${spec.values.length}`,
          );
        }
        const cycle = Math.floor(index / spec.values.length);
        const permutation = deterministicPermutation(spec.values, seed, cycle);
        value = permutation[index % permutation.length];
      } else {
        throw new Error(`Unsupported choice selection: ${selection}`);
      }
      return structuredClone(value);
    }
    case 'random-string': {
      const length = Number(spec.length);
      const alphabet = spec.alphabet ?? 'abcdefghijklmnopqrstuvwxyz0123456789';
      if (!Number.isInteger(length) || length < 1 || !alphabet) {
        throw new Error('random-string requires positive length and a non-empty alphabet');
      }
      return Array.from({ length }, (_, offset) => (
        alphabet[Math.floor(
          deterministicNumber(`${seed}\0index=${index}\0offset=${offset}`) * alphabet.length,
        )]
      )).join('');
    }
    default:
      throw new Error(`Unsupported iteration generator: ${spec.op}`);
  }
}

function createIterationItem(node, run, index, total, sourceItem, explicitValues, routeId = '') {
  const item = sourceItem && typeof sourceItem === 'object'
    ? structuredClone(sourceItem)
    : sourceItem === undefined
      ? {}
      : { value: sourceItem };
  const loop = { index, iteration: index + 1, count: total, item };
  const values = transactionValues(run, explicitValues);
  values.loop = loop;
  setPath(values, node.iteration.indexAs, index);
  setPath(values, node.iteration.itemAs, item);
  const routeGenerator = routeId ? node.iteration.generateByRoute?.[routeId] ?? {} : {};
  const fieldPolicies = run.generationProfile?.effective
    ?.nodes?.[node.id]?.routes?.[routeId]?.fields ?? {};
  const generator = {
    ...(node.iteration.generate ?? {}),
    ...routeGenerator,
  };
  const pending = new Map(Object.entries(generator));
  let lastMissing = null;
  while (pending.size > 0) {
    let generated = 0;
    for (const [key, baseSpec] of pending) {
      const spec = mergeGeneratorSpec(baseSpec, fieldPolicies[key]);
      const seed = `${run.runId}\0${node.id}\0${routeId}\0${key}`;
      let value;
      try {
        value = generatedValue(spec, values, seed, { index, total });
      } catch (error) {
        if (error.code === 'ITERATION_VALUE_MISSING') {
          lastMissing = error;
          continue;
        }
        throw error;
      }
      setPath(item, key, value);
      setPath(values, `loop.item.${key}`, value);
      setPath(values, `${node.iteration.itemAs}.${key}`, value);
      pending.delete(key);
      generated += 1;
    }
    if (generated === 0) {
      throw new Error(
        `Iteration generators for ${node.id} have unresolved or cyclic dependencies: `
        + `${[...pending.keys()].join(', ')}${lastMissing ? ` (${lastMissing.message})` : ''}`,
      );
    }
  }
  return item;
}

function fieldValue(item, key) {
  return key.split('.').reduce((value, part) => value?.[part], item);
}

function validateMaterializedItems(node, run, routeId, items, total) {
  const policies = run.generationProfile?.effective
    ?.nodes?.[node.id]?.routes?.[routeId]?.fields ?? {};
  for (const [field, policy] of Object.entries(policies)) {
    if (!policy?.unique) continue;
    const values = Array.from({ length: total }, (_, index) => fieldValue(items[String(index)], field));
    if (values.some((value) => value === undefined)) {
      throw new Error(`Unique generation field is missing: ${node.id}/${routeId}/${field}`);
    }
    if (new Set(values.map((value) => JSON.stringify(value))).size !== total) {
      throw new Error(`Generation field must be unique: ${node.id}/${routeId}/${field}`);
    }
  }
}

function materializedItems(node, run, descriptor, explicitValues, routeId) {
  if (
    descriptor.previous.routeId
    && descriptor.previous.routeId !== routeId
    && Object.keys(descriptor.previous.items ?? {}).length > 0
  ) {
    throw new Error(
      `Iteration route changed for ${node.id}: ${descriptor.previous.routeId} -> ${routeId}`,
    );
  }
  if (
    descriptor.previous.total !== undefined
    && descriptor.previous.total !== descriptor.total
    && Object.keys(descriptor.previous.items ?? {}).length > 0
  ) {
    throw new Error(
      `Iteration count changed for ${node.id}: ${descriptor.previous.total} -> ${descriptor.total}`,
    );
  }
  const items = structuredClone(descriptor.previous.items ?? {});
  for (let index = 0; index < descriptor.total; index += 1) {
    if (items[String(index)] !== undefined) continue;
    items[String(index)] = createIterationItem(
      node,
      run,
      index,
      descriptor.total,
      descriptor.items?.[index],
      explicitValues,
      routeId,
    );
  }
  validateMaterializedItems(node, run, routeId, items, descriptor.total);
  return items;
}

function loopSummary(node, run, routeId, items, results, total) {
  const policies = run.generationProfile?.effective
    ?.nodes?.[node.id]?.routes?.[routeId]?.fields ?? {};
  const fields = Object.keys(policies).length > 0
    ? Object.keys(policies)
    : [...new Set(Object.values(items).flatMap((item) => Object.keys(item ?? {})))];
  const distinct = {};
  const distribution = {};
  const policySatisfied = {};
  for (const field of fields) {
    const values = Array.from({ length: total }, (_, index) => fieldValue(items[String(index)], field))
      .filter((value) => value !== undefined && (value === null || typeof value !== 'object'));
    if (values.length === 0) continue;
    const counts = {};
    for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
    distinct[field] = Object.keys(counts).length;
    distribution[field] = counts;
    const policy = policies[field] ?? {};
    if (policy.unique) policySatisfied[`${field}.unique`] = distinct[field] === total;
    if (['balanced', 'shuffle-cycle', 'cycle'].includes(policy.selection)) {
      const frequencies = Object.values(counts);
      policySatisfied[`${field}.${policy.selection}`] = (
        Math.max(...frequencies) - Math.min(...frequencies) <= 1
      );
    }
  }
  return {
    nodeId: node.id,
    routeId,
    requestedCount: total,
    completedCount: results.filter((item) => item.status === 'success').length,
    failedCount: results.filter((item) => item.status !== 'success').length,
    durationMs: results.reduce((sum, item) => sum + Number(item.durationMs ?? 0), 0),
    distinct,
    distribution,
    policySatisfied,
  };
}

function iterationDescriptor(node, run, explicitValues) {
  if (!node.iteration) return null;
  const values = transactionValues(run, explicitValues);
  const previous = run.loops?.[node.id] ?? {};
  if (previous.status === 'attempting') {
    return {
      error: `Iteration ${previous.attemptingIndex + 1} for ${node.id} has an uncertain external result; reconcile it before retrying`,
    };
  }
  let items = null;
  let total;
  if (node.iteration.mode === 'foreach') {
    items = nestedValue(values, node.iteration.itemsFrom);
    if (!Array.isArray(items)) {
      return { error: `Iteration source ${node.iteration.itemsFrom} must be an array` };
    }
    total = items.length;
  } else {
    const rawCount = node.iteration.countFrom
      ? nestedValue(values, node.iteration.countFrom)
      : node.iteration.count;
    total = Number(rawCount);
    if (!Number.isInteger(total) || total < 1) {
      return { error: `Iteration count for ${node.id} must be a positive integer` };
    }
  }
  if (total > node.iteration.maxIterations) {
    return {
      error: `Iteration count ${total} exceeds maxIterations ${node.iteration.maxIterations} for ${node.id}`,
    };
  }
  if (previous.total !== undefined && previous.total !== total) {
    return {
      error: `Iteration count changed from ${previous.total} to ${total} for resumable node ${node.id}`,
    };
  }
  const nextIndex = Number(previous.nextIndex ?? 0);
  if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex > total) {
    return { error: `Invalid saved nextIndex for ${node.id}` };
  }
  return { total, items, nextIndex, previous };
}

function iterationContext(node, run, descriptor, index, explicitValues, routeId = '') {
  const savedItem = descriptor.previous.items?.[String(index)];
  const item = savedItem ?? createIterationItem(
    node,
    run,
    index,
    descriptor.total,
    descriptor.items?.[index],
    explicitValues,
    routeId,
  );
  const loop = {
    index,
    iteration: index + 1,
    count: descriptor.total,
    item,
  };
  const aliases = {};
  setPath(aliases, node.iteration.indexAs, index);
  setPath(aliases, node.iteration.itemAs, item);
  return {
    item,
    values: { loop, ...aliases },
    assignments: flattenAssignments({ loop, ...aliases }),
  };
}

async function loadRun(runId) {
  const path = join(RUNS_ROOT, runId, 'state.json');
  if (!existsSync(path)) throw new Error(`Run not found: ${runId}`);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function workflowCommand(...args) {
  return execFileAsync(process.execPath, [WORKFLOW_CTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function executeNode(runId, nodeId, assignments) {
  const args = [RECIPE_RUNNER, '--run', runId, '--node', nodeId];
  for (const assignment of assignments) args.push('--value', assignment);
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  let result = JSON.parse(stdout.trim());
  if (typeof result === 'string') result = JSON.parse(result);
  return result;
}

async function commitBoundary(runId, file) {
  await workflowCommand('commit', '--run', runId, '--file', file);
}

async function writeAndCommit(runId, payload) {
  const file = join(RUNS_ROOT, runId, 'last-boundary.json');
  await atomicWriteJson(file, payload);
  await commitBoundary(runId, `.workflow-runs/${runId}/last-boundary.json`);
}

async function prepareIterationBatch(
  runId,
  node,
  run,
  descriptor,
  explicitValues,
  routeId,
  persist = true,
) {
  const items = materializedItems(node, run, descriptor, explicitValues, routeId);
  const prepared = {
    ...(descriptor.previous ?? {}),
    nodeId: node.id,
    mode: node.iteration.mode,
    total: descriptor.total,
    nextIndex: descriptor.nextIndex,
    completedCount: descriptor.nextIndex,
    status: descriptor.nextIndex === descriptor.total ? 'completed' : 'prepared',
    attemptingIndex: null,
    routeId,
    profileRevision: run.generationProfile?.baseRevision ?? null,
    items,
    results: descriptor.previous.results ?? [],
    preparedAt: descriptor.previous.preparedAt ?? new Date().toISOString(),
  };
  if (persist) {
    await writeAndCommit(runId, {
      ...localBoundary(node, null, 'in_progress'),
      runStatus: 'active',
      loop: prepared,
    });
  }
  descriptor.previous = prepared;
  return prepared;
}

async function prepareIterationCommit(runId, node, descriptor, context, result) {
  const commitPath = resolve(ROOT, result.commitFile);
  const payload = await readJson(commitPath);
  const succeeded = result.status === 'success';
  const finalIteration = succeeded && context.values.loop.index + 1 >= descriptor.total;
  const previousResults = descriptor.previous.results ?? [];
  const iterationResult = {
    index: context.values.loop.index,
    iteration: context.values.loop.iteration,
    status: result.status,
    batchId: result.batchId ?? '',
    routeId: result.routeId ?? '',
    observations: result.extracted ?? {},
    boundaryEvidence: result.boundaryEvidence ?? null,
    url: result.url ?? '',
    actionCount: result.results?.length ?? 0,
    durationMs: Number(result.durationMs ?? 0),
    at: new Date().toISOString(),
  };
  payload.step.status = succeeded
    ? finalIteration ? 'completed' : 'in_progress'
    : 'blocked';
  payload.step.note = succeeded
    ? `Iteration ${context.values.loop.iteration}/${descriptor.total} completed`
    : `Iteration ${context.values.loop.iteration}/${descriptor.total} failed: ${result.reason}`;
  payload.loop = {
    nodeId: node.id,
    mode: node.iteration.mode,
    total: descriptor.total,
    nextIndex: succeeded ? context.values.loop.index + 1 : context.values.loop.index,
    completedCount: succeeded ? context.values.loop.index + 1 : context.values.loop.index,
    status: succeeded ? finalIteration ? 'completed' : 'active' : 'failed',
    attemptingIndex: null,
    routeId: result.routeId ?? descriptor.previous.routeId ?? '',
    profileRevision: descriptor.previous.profileRevision ?? null,
    preparedAt: descriptor.previous.preparedAt ?? null,
    items: {
      ...(descriptor.previous.items ?? {}),
      [String(context.values.loop.index)]: context.item,
    },
    results: [
      ...previousResults.filter((item) => item.index !== context.values.loop.index),
      iterationResult,
    ].sort((left, right) => left.index - right.index),
  };
  if (finalIteration) {
    const summary = loopSummary(
      node,
      await loadRun(runId),
      result.routeId ?? descriptor.previous.routeId ?? '',
      payload.loop.items,
      payload.loop.results,
      descriptor.total,
    );
    payload.loop.summary = summary;
    payload.outputs ??= [];
    payload.outputs.push({
      key: `executionSummary.${node.id}`,
      value: summary,
    });
  }
  payload.evidence = (payload.evidence ?? [])
    .filter((evidence) => evidence.kind !== 'transaction-boundary');
  payload.evidence.push({
    kind: 'iteration',
    value: `${node.id}#${context.values.loop.iteration}`,
    data: {
      item: context.item,
      status: result.status,
      batchId: result.batchId ?? '',
      observations: result.extracted ?? {},
      boundaryEvidence: result.boundaryEvidence ?? null,
      url: result.url ?? '',
      durationMs: Number(result.durationMs ?? 0),
    },
  });
  await atomicWriteJson(commitPath, payload);
  return payload.loop;
}

async function markIterationAttempt(runId, node, descriptor, context) {
  await writeAndCommit(runId, {
    ...localBoundary(node, null, 'in_progress'),
    runStatus: 'active',
    loop: {
      nodeId: node.id,
      mode: node.iteration.mode,
      total: descriptor.total,
      nextIndex: context.values.loop.index,
      completedCount: context.values.loop.index,
      status: 'attempting',
      attemptingIndex: context.values.loop.index,
      routeId: descriptor.previous.routeId ?? '',
      profileRevision: descriptor.previous.profileRevision ?? null,
      preparedAt: descriptor.previous.preparedAt ?? null,
      items: {
        ...(descriptor.previous.items ?? {}),
        [String(context.values.loop.index)]: context.item,
      },
      results: descriptor.previous.results ?? [],
    },
  });
}

function hasValidAuthorization(run, nodeId) {
  const authorization = run.authorizations?.[nodeId];
  return Boolean(authorization && !authorization.invalidatedAt);
}

function authorizationMode(node) {
  return node.authorization?.mode
    ?? (node.barrier === 'risk' ? 'runtime' : node.risk === 'read' ? 'not-required' : 'prompt');
}

function validateAuthorizationEnvelope(node, run, explicitValues) {
  if (authorizationMode(node) !== 'prompt') return { valid: true, count: null };
  const authorization = node.authorization ?? {};
  const values = transactionValues(run, explicitValues);
  const rawCount = authorization.countFrom
    ? nestedValue(values, authorization.countFrom)
    : authorization.count;
  if (authorization.countFrom && rawCount === undefined) {
    return {
      valid: false,
      reason: `Prompt authorization for ${node.id} requires input ${authorization.countFrom}`,
    };
  }
  if (rawCount === null || rawCount === undefined || rawCount === '') {
    return { valid: true, count: null };
  }
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 1) {
    return {
      valid: false,
      reason: `Prompt authorization count for ${node.id} must be a positive integer`,
    };
  }
  if (authorization.maxCount !== null
    && authorization.maxCount !== undefined
    && count > authorization.maxCount) {
    return {
      valid: false,
      reason: `Prompt authorization count ${count} exceeds maxCount ${authorization.maxCount} for ${node.id}`,
    };
  }
  return { valid: true, count };
}

function wasHumanStepResumed(run, nodeId) {
  return run.status === 'active'
    && run.waitHistory?.some((item) => item.step === nodeId && item.resumedAt);
}

function transactionValues(run, explicitValues) {
  const values = mergeDeep(
    mergeDeep(mergeDeep({}, run.inputs ?? {}), run.facts ?? {}),
    run.data ?? {},
  );
  return mergeDeep(values, explicitValues);
}

function isTransientFailure(reason = '') {
  return /timeout|timed out|page-fingerprint|route-entry|navigation|loading|temporar/i.test(reason);
}

function localBoundary(node, route, status = 'completed') {
  return {
    step: {
      id: node.id,
      title: node.title,
      status,
      note: status === 'completed'
        ? `Local ${node.type} route ${route?.routeId ?? 'default'} completed`
        : node.description,
    },
    recipe: route ? {
      selections: [{
        nodeId: node.id,
        routeId: route.routeId,
        routeSignature: route.routeSignature,
      }],
    } : undefined,
    cursor: {
      step: node.id,
      next: status === 'completed' ? 'Continue with the next workflow transaction' : node.description,
      system: node.affinity?.system ?? '',
      url: '',
    },
  };
}

async function pauseAtBoundary(runId, node, reason, until) {
  await writeAndCommit(runId, {
    ...localBoundary(node, null, 'in_progress'),
    runStatus: 'active',
  });
  await workflowCommand(
    'pause',
    '--run', runId,
    '--reason', reason,
    '--until', until || node.description || node.title,
  );
}

async function main() {
  const segmentStartedAt = new Date().toISOString();
  const segmentStarted = Date.now();
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) usage();
  await assertCacheHygiene();
  const runId = safeRunId(one(flags, 'run'));
  const from = one(flags, 'from', false);
  if (from) safeName(from, 'from node id');
  const dryRun = (one(flags, 'dry-run', false) ?? 'false') === 'true';
  const maxNodes = Number(one(flags, 'max-nodes', false) ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new Error('--max-nodes must be a positive integer');
  const retries = Number(one(flags, 'retries', false) ?? 1);
  if (!Number.isInteger(retries) || retries < 0) throw new Error('--retries must be a non-negative integer');
  const explicitAssignments = flags.value ?? [];
  const explicitValues = parseValues(explicitAssignments);
  let initialRun = await loadRun(runId);
  if (initialRun.status === 'repair_required' && !dryRun) {
    await workflowCommand('resume', '--run', runId);
    initialRun = await loadRun(runId);
  }
  if (initialRun.status === 'waiting') {
    const waitingStep = initialRun.waiting?.step;
    if (waitingStep && hasValidAuthorization(initialRun, waitingStep) && !dryRun) {
      await workflowCommand('resume', '--run', runId);
      initialRun = await loadRun(runId);
    } else {
      throw new Error(`Run is waiting at ${waitingStep ?? 'an unknown boundary'}`);
    }
  }
  if (initialRun.status === 'completed') throw new Error('Completed runs cannot be executed');

  const identity = await resolvePromptSelection({ promptKey: initialRun.prompt?.key });
  if (initialRun.prompt?.scope && initialRun.prompt.scope !== identity.scope) {
    throw new Error(`Run prompt scope ${initialRun.prompt.scope} does not match ${identity.scope}`);
  }
  const definition = normalizeDefinition(await readJson(cachePaths(identity).definitionPath));
  const nodes = [...definition.compiled.nodes]
    .sort((left, right) => (left.executionOrder ?? 0) - (right.executionOrder ?? 0));
  const startIndex = from ? nodes.findIndex((node) => node.id === from) : 0;
  if (startIndex < 0) throw new Error(`Recipe node not found: ${from}`);

  const executed = [];
  const skipped = [];
  for (const node of nodes.slice(startIndex)) {
    if (executed.length >= maxNodes) break;
    const run = await loadRun(runId);
    const planStep = run.plan?.find((step) => step.id === node.id);
    if (planStep && ['completed', 'skipped'].includes(planStep.status)) {
      skipped.push({ nodeId: node.id, reason: `already-${planStep.status}` });
      continue;
    }

    if (node.type === 'human' || node.barrier === 'human') {
      if (wasHumanStepResumed(run, node.id)) {
        if (!dryRun) await writeAndCommit(runId, localBoundary(node, null));
        executed.push({ nodeId: node.id, status: 'completed', mode: 'human-resumed' });
        continue;
      }
      if (dryRun) {
        console.log(JSON.stringify({
          status: 'intervention-required',
          runId,
          executed,
          skipped,
          boundary: { nodeId: node.id, type: node.type, barrier: 'human', description: node.description },
        }, null, 2));
        return;
      }
      await pauseAtBoundary(
        runId,
        node,
        `Waiting for human step ${node.id}`,
        node.description,
      );
      console.log(JSON.stringify({
        status: 'waiting',
        runId,
        executed,
        skipped,
        boundary: { nodeId: node.id, type: node.type, barrier: 'human', description: node.description },
      }, null, 2));
      return;
    }

    const authorizationEnvelope = validateAuthorizationEnvelope(node, run, explicitValues);
    if (!authorizationEnvelope.valid) {
      if (!dryRun) {
        await writeAndCommit(runId, {
          ...localBoundary(node, null, 'blocked'),
          runStatus: 'repair_required',
        });
      }
      console.log(JSON.stringify({
        status: 'repair-required',
        runId,
        executed,
        skipped,
        failedNode: node.id,
        failure: { reason: authorizationEnvelope.reason },
        resume: { from: node.id },
      }, null, 2));
      process.exitCode = 2;
      return;
    }

    const requiresRuntimeAuthorization = authorizationMode(node) === 'runtime'
      || node.barrier === 'risk';
    if (requiresRuntimeAuthorization && !hasValidAuthorization(run, node.id)) {
      if (!dryRun) {
        await pauseAtBoundary(
          runId,
          node,
          `Explicit confirmation required for ${node.id}`,
          `Confirm the exact pending action with: pnpm workflow confirm --run ${runId} --action ${node.id} --by <name>`,
        );
      }
      console.log(JSON.stringify({
        status: dryRun ? 'intervention-required' : 'waiting',
        runId,
        executed,
        skipped,
        boundary: {
          nodeId: node.id,
          type: node.type,
          barrier: 'risk',
          risk: node.risk,
          authorization: node.authorization,
          description: node.description,
        },
      }, null, 2));
      return;
    }

    const loopDescriptor = iterationDescriptor(node, run, explicitValues);
    if (loopDescriptor?.error) {
      if (!dryRun) {
        await writeAndCommit(runId, {
          ...localBoundary(node, null, 'blocked'),
          runStatus: 'repair_required',
        });
      }
      console.log(JSON.stringify({
        status: 'repair-required',
        runId,
        executed,
        skipped,
        failedNode: node.id,
        failure: { reason: loopDescriptor.error },
        resume: { from: node.id },
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    if (loopDescriptor
      && authorizationEnvelope.count !== null
      && authorizationEnvelope.count !== loopDescriptor.total) {
      const reason = `Iteration count ${loopDescriptor.total} does not match authorized count ${authorizationEnvelope.count} for ${node.id}`;
      if (!dryRun) {
        await writeAndCommit(runId, {
          ...localBoundary(node, null, 'blocked'),
          runStatus: 'repair_required',
        });
      }
      console.log(JSON.stringify({
        status: 'repair-required',
        runId,
        executed,
        skipped,
        failedNode: node.id,
        failure: { reason },
        resume: { from: node.id },
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    if (loopDescriptor && loopDescriptor.nextIndex === loopDescriptor.total) {
      if (!dryRun) await writeAndCommit(runId, localBoundary(node, null));
      executed.push({
        nodeId: node.id,
        type: node.type,
        status: 'success',
        mode: 'iteration-already-complete',
        iterationCount: loopDescriptor.total,
      });
      continue;
    }
    const baseResolutionValues = transactionValues(run, explicitValues);
    const baseResolution = resolveWorkflowRecipe(definition, baseResolutionValues, node.id);
    const hasRouteGenerator = Object.keys(node.iteration?.generateByRoute ?? {}).length > 0;
    const generationRouteId = hasRouteGenerator
      && baseResolution.status === 'ready'
      && baseResolution.resolved.length === 1
      ? baseResolution.resolved[0].routeId
      : '';
    const firstIterationContext = loopDescriptor && (!hasRouteGenerator || generationRouteId)
      ? iterationContext(
          node,
          run,
          loopDescriptor,
          loopDescriptor.nextIndex,
          explicitValues,
          generationRouteId,
        )
      : null;
    const resolutionValues = mergeDeep({}, baseResolutionValues);
    if (firstIterationContext) mergeDeep(resolutionValues, firstIterationContext.values);
    const resolution = hasRouteGenerator && !generationRouteId
      ? baseResolution
      : resolveWorkflowRecipe(definition, resolutionValues, node.id);
    if (resolution.status !== 'ready' || resolution.resolved.length !== 1) {
      if (!dryRun) {
        await writeAndCommit(runId, {
          ...localBoundary(node, null, 'blocked'),
          runStatus: 'repair_required',
          telemetry: {
            kind: 'segment-boundary',
            batchId: `resolve-${node.id}-${Date.now()}`,
            nodeId: node.id,
            startedAt: segmentStartedAt,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - segmentStarted,
            status: resolution.status,
          },
        });
      }
      console.log(JSON.stringify({
        status: resolution.status,
        runId,
        executed,
        skipped,
        boundary: { nodeId: node.id, title: node.title, description: node.description ?? '' },
        pending: resolution.pending,
        unknown: resolution.unknown,
        ambiguous: resolution.ambiguous,
        resume: { from: node.id },
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    const selectedRoute = resolution.resolved[0];
    if (loopDescriptor) {
      await prepareIterationBatch(
        runId,
        node,
        run,
        loopDescriptor,
        explicitValues,
        generationRouteId || selectedRoute.routeId,
        !dryRun,
      );
    }

    if (dryRun) {
      executed.push({
        nodeId: node.id,
        type: node.type,
        routeId: selectedRoute.routeId,
        actionCount: selectedRoute.actions.length,
        authorizationMode: authorizationMode(node),
        authorizedCount: authorizationEnvelope.count,
        iteration: loopDescriptor ? {
          mode: node.iteration.mode,
          total: loopDescriptor.total,
          nextIndex: loopDescriptor.nextIndex,
          generationRouteId: generationRouteId || null,
          materializedCount: Object.keys(loopDescriptor.previous.items ?? {}).length,
        } : null,
        mode: 'dry-run',
      });
      continue;
    }

    if (node.type === 'decision' || node.type === 'report') {
      const payload = localBoundary(node, selectedRoute);
      const computed = localComputationPayload(node, run, explicitValues);
      payload.facts = computed.facts;
      payload.outputs = computed.outputs;
      if (node.type === 'report' && node.reportFromLoop) {
        const summary = run.data?.executionSummary?.[node.reportFromLoop]
          ?? run.loops?.[node.reportFromLoop]?.summary;
        if (!summary) {
          throw new Error(
            `Report ${node.id} requires completed loop summary ${node.reportFromLoop}`,
          );
        }
        payload.outputs.push({
          key: `reports.${node.id}`,
          value: structuredClone(summary),
        });
        setPath(computed.values, `reports.${node.id}`, structuredClone(summary));
      }
      if (node.type === 'decision') {
        payload.decisions = [{
          name: node.id,
          condition: selectedRoute.routeSignature,
          selected: selectedRoute.routeId,
          reason: `Resolved locally from cached guard ${selectedRoute.routeSignature}`,
        }];
      }
      const producedValues = mergeDeep(
        mergeDeep({}, computed.values),
        Object.fromEntries(computed.outputs.map(({ key, value }) => [key, value])),
      );
      const missingProduced = (node.produces ?? [])
        .filter((key) => nestedValue(producedValues, key) === undefined);
      if (missingProduced.length > 0) {
        throw new Error(`Local node ${node.id} did not produce declared values: ${missingProduced.join(', ')}`);
      }
      if (node.type === 'report') {
        const missingOutputs = (definition.compiled.outputs ?? [])
          .map((output) => typeof output === 'string' ? output : output.key)
          .filter(Boolean)
          .filter((key) => nestedValue(producedValues, key) === undefined);
        if (missingOutputs.length > 0) {
          throw new Error(`Report ${node.id} did not produce workflow outputs: ${missingOutputs.join(', ')}`);
        }
      }
      payload.recipe.version = definition.compiled.version;
      payload.runStatus = 'active';
      await writeAndCommit(runId, payload);
      executed.push({
        nodeId: node.id,
        type: node.type,
        routeId: selectedRoute.routeId,
        status: 'success',
        mode: 'local',
      });
      continue;
    }

    if (node.type !== 'browser') {
      throw new Error(`Unsupported executable node type: ${node.type}`);
    }

    const iterationExecutions = [];
    const indexes = loopDescriptor
      ? Array.from(
          { length: loopDescriptor.total - loopDescriptor.nextIndex },
          (_, offset) => loopDescriptor.nextIndex + offset,
        )
      : [null];
    for (const index of indexes) {
      const currentRun = index === null ? run : await loadRun(runId);
      const context = index === null
        ? null
        : iterationContext(
            node,
            currentRun,
            loopDescriptor,
            index,
            explicitValues,
            generationRouteId || selectedRoute.routeId,
          );
      if (context && node.risk === 'irreversible') {
        await markIterationAttempt(runId, node, loopDescriptor, context);
      }
      const assignments = [
        ...explicitAssignments,
        ...(context?.assignments ?? []),
      ];
      let result;
      let executionError = null;
      let attempts = 0;
      const automaticRetries = node.risk === 'irreversible' ? 0 : retries;
      do {
        attempts += 1;
        executionError = null;
        try {
          result = await executeNode(runId, node.id, assignments);
        } catch (error) {
          executionError = error;
        }
        const reason = executionError?.message ?? result?.reason ?? '';
        if ((!executionError && result?.status === 'success')
          || attempts > automaticRetries
          || !isTransientFailure(reason)) {
          break;
        }
      } while (true);
      if (executionError) {
        await writeAndCommit(runId, {
          ...localBoundary(node, selectedRoute, 'blocked'),
          runStatus: 'repair_required',
          telemetry: {
            kind: 'transaction',
            batchId: `crash-${node.id}-${Date.now()}`,
            nodeId: node.id,
            routeId: selectedRoute.routeId,
            startedAt: segmentStartedAt,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - segmentStarted,
            status: 'failure',
          },
        });
        if (iterationExecutions.length > 0) {
          executed.push({
            nodeId: node.id,
            type: node.type,
            status: 'partial',
            iterationCount: loopDescriptor?.total ?? 1,
            completedIterations: iterationExecutions.length,
            iterations: iterationExecutions,
          });
        }
        console.log(JSON.stringify({
          status: 'repair-required',
          runId,
          executed,
          skipped,
          failedNode: node.id,
          failedIteration: context?.values.loop.iteration ?? null,
          failure: { reason: executionError.message, completedActions: [], attempts },
          resume: { from: node.id },
        }, null, 2));
        process.exitCode = 2;
        return;
      }
      if (context) {
        loopDescriptor.previous = await prepareIterationCommit(
          runId,
          node,
          loopDescriptor,
          context,
          result,
        );
      }
      await commitBoundary(runId, result.commitFile);
      iterationExecutions.push({
        index,
        iteration: context?.values.loop.iteration ?? null,
        routeId: result.routeId,
        batchId: result.batchId,
        status: result.status,
        actionCount: result.results?.length ?? 0,
        attempts,
      });
      if (result.status !== 'success') {
        executed.push({
          nodeId: node.id,
          type: node.type,
          status: 'partial',
          iterationCount: loopDescriptor?.total ?? 1,
          completedIterations: iterationExecutions.filter((item) => item.status === 'success').length,
          iterations: iterationExecutions,
        });
        console.log(JSON.stringify({
          status: 'repair-required',
          runId,
          executed,
          skipped,
          failedNode: node.id,
          failedIteration: context?.values.loop.iteration ?? null,
          failure: {
            reason: result.reason,
            url: result.url,
            completedActions: result.results,
          },
          resume: { from: node.id },
        }, null, 2));
        process.exitCode = 2;
        return;
      }
    }
    if (loopDescriptor) {
      executed.push({
        nodeId: node.id,
        type: node.type,
        status: 'success',
        iterationMode: node.iteration.mode,
        iterationCount: loopDescriptor.total,
        completedIterations: iterationExecutions.length,
        resumedFromIndex: loopDescriptor.nextIndex,
        iterations: iterationExecutions,
      });
    } else {
      const [execution] = iterationExecutions;
      executed.push({
        nodeId: node.id,
        type: node.type,
        routeId: execution.routeId,
        batchId: execution.batchId,
        status: execution.status,
        actionCount: execution.actionCount,
        attempts: execution.attempts,
      });
    }
  }

  if (!dryRun) {
    const completedAt = Date.now();
    const workflowDurationMs = Math.max(
      0,
      completedAt - Date.parse(initialRun.createdAt ?? segmentStartedAt),
    );
    await writeAndCommit(runId, {
      runStatus: 'active',
      telemetry: {
        kind: 'segment',
        batchId: `segment-${Date.now()}`,
        startedAt: segmentStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - segmentStarted,
        workflowDurationMs,
        status: 'success',
      },
    });
  }
  const workflowDurationMs = Math.max(
    0,
    Date.now() - Date.parse(initialRun.createdAt ?? segmentStartedAt),
  );
  console.log(JSON.stringify({
    status: dryRun ? 'ready' : 'workflow-segment-complete',
    runId,
    executed,
    skipped,
    durationMs: Date.now() - segmentStarted,
    workflowDurationMs,
    next: executed.length >= maxNodes ? 'max-nodes-reached' : 'end-of-recipe',
  }, null, 2));
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
