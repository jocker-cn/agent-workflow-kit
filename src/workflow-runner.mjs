#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

function hasValidAuthorization(run, nodeId) {
  const authorization = run.authorizations?.[nodeId];
  return Boolean(authorization && !authorization.invalidatedAt);
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

    if ((node.barrier === 'risk' || node.risk === 'irreversible') && !hasValidAuthorization(run, node.id)) {
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
          description: node.description,
        },
      }, null, 2));
      return;
    }

    const resolution = resolveWorkflowRecipe(definition, transactionValues(run, explicitValues), node.id);
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

    if (dryRun) {
      executed.push({
        nodeId: node.id,
        type: node.type,
        routeId: selectedRoute.routeId,
        actionCount: selectedRoute.actions.length,
        mode: 'dry-run',
      });
      continue;
    }

    if (node.type === 'decision' || node.type === 'report') {
      const payload = localBoundary(node, selectedRoute);
      const computed = localComputationPayload(node, run, explicitValues);
      payload.facts = computed.facts;
      payload.outputs = computed.outputs;
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

    let result;
    let executionError = null;
    let attempts = 0;
    do {
      attempts += 1;
      executionError = null;
      try {
        result = await executeNode(runId, node.id, explicitAssignments);
      } catch (error) {
        executionError = error;
      }
      const reason = executionError?.message ?? result?.reason ?? '';
      if ((!executionError && result?.status === 'success') || attempts > retries || !isTransientFailure(reason)) {
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
      console.log(JSON.stringify({
        status: 'repair-required',
        runId,
        executed,
        skipped,
        failedNode: node.id,
        failure: { reason: executionError.message, completedActions: [], attempts },
        resume: { from: node.id },
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    executed.push({
      nodeId: node.id,
      type: node.type,
      routeId: result.routeId,
      batchId: result.batchId,
      status: result.status,
      actionCount: result.results?.length ?? 0,
      attempts,
    });
    await commitBoundary(runId, result.commitFile);
    if (result.status !== 'success') {
      console.log(JSON.stringify({
        status: 'repair-required',
        runId,
        executed,
        skipped,
        failedNode: node.id,
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
