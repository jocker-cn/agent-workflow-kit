#!/usr/bin/env node

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  cacheDisplayPaths,
  ensurePromptCache,
  resolvePromptSelection,
} from './cache-store.mjs';

const ROOT = resolve(process.cwd());
const RUNS_DIR = join(ROOT, '.workflow-runs');
const STEP_STATUSES = new Set(['pending', 'in_progress', 'completed', 'skipped', 'blocked']);

function usage(exitCode = 0) {
  console.log(`
Prompt workflow state CLI

Commands:
  init --summary <text> [--intent <sanitized-workflow>]
       [--prompt-file <path> | --prompt-key <key>]
       [--workflow-name <name>] [--input key=value]...
  show --run <run-id>
  latest [--workflow-name <name>] [--input key=value]...
  context --run <run-id>
  plan-add --run <run-id> --id <step-id> --title <text> [--after <step-id>]
  step --run <run-id> --id <step-id> --status <status> [--note <text>]
  fact --run <run-id> --key <a.b.c> --value <value> [--source <visible-source>]
  decision --run <run-id> --name <name> --selected <branch> --reason <text> [--condition <text>]
  checkpoint --run <run-id> --step <step-id> --next <action> [--system <name>] [--url <url>]
  pause --run <run-id> --reason <text> [--until <observable-condition>]
  resume --run <run-id>
  output --run <run-id> --key <a.b.c> --value <value>
  evidence --run <run-id> --kind <kind> --value <path-or-url> [--note <text>]
  commit --run <run-id> --file <project-relative-json>
  review --run <run-id>
  confirm --run <run-id> --action <action> --by <name>
  complete --run <run-id>

The user's prompt is the workflow definition. Each execution has immutable inputs and isolated
state. The Agent maintains the dynamic plan, facts, decisions, and recovery cursor.
Use commit once per meaningful business boundary to save steps, facts, decisions, outputs,
evidence, route selection, cursor, and telemetry in one process.
`);
  process.exit(exitCode);
}

function args(argv) {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, ...rest] = normalized;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    (flags[key] ??= []).push(value);
    index += 1;
  }
  return { command, flags };
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

function safePart(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workflow';
}

function runDir(runId) {
  if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('Invalid run id');
  return join(RUNS_DIR, runId);
}

function setPath(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  if (parts.some((part) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(part))) {
    throw new Error('Keys must use dot-separated alphanumeric names');
  }
  let cursor = target;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
  cursor[parts.at(-1)] = value;
}

function parseInputs(values = []) {
  const inputs = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error('--input must use key=value format');
    setPath(inputs, value.slice(0, separator), value.slice(separator + 1));
  }
  return inputs;
}

function containsValues(target, expected) {
  if (expected === null || typeof expected !== 'object') return target === expected;
  return Object.entries(expected).every(([key, value]) => containsValues(target?.[key], value));
}

function normalizeRun(run) {
  run.schemaVersion ??= 1;
  run.name ??= run.workflow ?? 'prompt-workflow';
  run.intent ??= run.summary ?? '';
  run.prompt ??= null;
  run.inputs ??= {};
  run.plan ??= [];
  run.facts ??= {};
  run.factHistory ??= [];
  run.decisions ??= [];
  run.cursor ??= {
    currentStep: run.phase && run.phase !== 'INIT' ? run.phase.toLowerCase() : null,
    nextAction: '',
    system: '',
    lastUrl: '',
    at: run.updatedAt ?? run.createdAt,
  };
  run.data ??= {};
  run.waitHistory ??= [];
  run.evidenceCount ??= 0;
  run.evidenceSummary ??= {};
  run.evidenceRecent ??= [];
  run.authorizations ??= {};
  run.recipe ??= {
    version: null,
    selections: [],
  };
  run.executionHistory ??= [];
  return run;
}

async function readProjectJson(file) {
  const absolute = resolve(ROOT, file);
  const pathFromRoot = relative(ROOT, absolute);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error('--file must be inside the project');
  }
  return JSON.parse(await readFile(absolute, 'utf8'));
}

async function loadRun(runId) {
  const statePath = join(runDir(runId), 'state.json');
  if (!existsSync(statePath)) throw new Error(`Run not found: ${runId}`);
  return normalizeRun(JSON.parse(await readFile(statePath, 'utf8')));
}

async function latestRun(name, inputs = {}) {
  const safeWorkflow = name ? safeName(name, 'name') : null;
  if (!existsSync(RUNS_DIR)) throw new Error('No workflow runs found');
  const { readdir } = await import('node:fs/promises');
  const runIds = await readdir(RUNS_DIR, { withFileTypes: true });
  const runs = await Promise.all(runIds
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        return await loadRun(entry.name);
      } catch {
        return null;
      }
    }));
  const run = runs
    .filter((item) => item
      && item.status !== 'completed'
      && (!safeWorkflow || item.name === safeWorkflow)
      && containsValues(item.inputs, inputs))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!run) {
    const inputDescription = Object.keys(inputs).length ? ' with the requested inputs' : '';
    throw new Error(`No resumable runs found${safeWorkflow ? ` for ${safeWorkflow}` : ''}${inputDescription}`);
  }
  return run;
}

async function saveRun(run) {
  run.schemaVersion = 2;
  run.updatedAt = new Date().toISOString();
  const statePath = join(runDir(run.runId), 'state.json');
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, statePath);
}

function invalidateAuthorizations(run, reason) {
  const invalidatedAt = new Date().toISOString();
  for (const authorization of Object.values(run.authorizations)) {
    if (!authorization.invalidatedAt) {
      authorization.invalidatedAt = invalidatedAt;
      authorization.invalidationReason = reason;
    }
  }
}

function findStep(run, id) {
  const step = run.plan.find((item) => item.id === id);
  if (!step) throw new Error(`Plan step not found: ${id}`);
  return step;
}

async function addEvidence(runId, kind, value, note = '') {
  const item = { at: new Date().toISOString(), kind, value, note };
  await appendFile(join(runDir(runId), 'evidence.jsonl'), `${JSON.stringify(item)}\n`, 'utf8');
  return item;
}

function toMarkdown(value, depth = 0) {
  const indent = '  '.repeat(depth);
  if (value === null || typeof value !== 'object') return `${value ?? 'N/A'}`;
  const entries = Object.entries(value);
  if (entries.length === 0) return 'N/A';
  return entries.map(([key, child]) => {
    if (child !== null && typeof child === 'object') {
      return `${indent}- ${key}:\n${toMarkdown(child, depth + 1)}`;
    }
    return `${indent}- ${key}: ${child ?? 'N/A'}`;
  }).join('\n');
}

function planMarkdown(plan) {
  if (plan.length === 0) return 'N/A';
  return plan.map((step) => {
    const note = step.note ? ` — ${step.note}` : '';
    return `- [${step.status}] ${step.id}: ${step.title}${note}`;
  }).join('\n');
}

function decisionsMarkdown(decisions) {
  if (decisions.length === 0) return 'N/A';
  return decisions.map((decision) => {
    const condition = decision.condition ? `; condition: ${decision.condition}` : '';
    return `- ${decision.name}: **${decision.selected}** — ${decision.reason}${condition}`;
  }).join('\n');
}

function authorizationsForDisplay(authorizations) {
  return Object.fromEntries(Object.entries(authorizations).map(([action, authorization]) => [
    action,
    {
      by: authorization.by,
      at: authorization.at,
      valid: !authorization.invalidatedAt,
      invalidatedAt: authorization.invalidatedAt,
      invalidationReason: authorization.invalidationReason,
    },
  ]));
}

function contextText(run, title = 'Workflow resume context') {
  const waiting = run.waiting
    ? `- Reason: ${run.waiting.reason}\n- Until: ${run.waiting.until || 'N/A'}\n- Since: ${run.waiting.at}`
    : 'N/A';
  return `# ${title}

- Run: \`${run.runId}\`
- Browser session: \`${run.runId}\`
- Name: ${run.name}
- Status: **${run.status}**
- Summary: ${run.summary}
- Intent: ${run.intent}
- Prompt cache: ${run.prompt?.scope ?? 'N/A'}
- Evidence items: ${run.evidenceCount}

## Inputs

${toMarkdown(run.inputs)}

## Plan

${planMarkdown(run.plan)}

## Facts

${toMarkdown(run.facts)}

## Decisions

${decisionsMarkdown(run.decisions)}

## Recipe

${toMarkdown(run.recipe)}

## Cursor

${toMarkdown(run.cursor)}

## Waiting

${waiting}

## Outputs

${toMarkdown(run.data)}

## Authorizations

${toMarkdown(authorizationsForDisplay(run.authorizations))}

## Evidence summary

${toMarkdown(run.evidenceSummary)}

## Recent evidence

${toMarkdown(run.evidenceRecent)}

## Recent execution telemetry

${toMarkdown(run.executionHistory.slice(-10))}
`;
}

async function main() {
  const { command, flags } = args(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') usage();

  if (command === 'init') {
    const name = safeName(
      one(flags, 'workflow-name', false) ?? one(flags, 'name', false) ?? 'prompt-workflow',
      'name',
    );
    const summary = one(flags, 'summary');
    const createdAt = new Date().toISOString();
    const runId = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${safePart(name)}-${randomUUID().slice(0, 6)}`;
    const promptFile = one(flags, 'prompt-file', false);
    const promptKey = one(flags, 'prompt-key', false);
    let prompt = null;
    if (promptFile || promptKey) {
      const identity = await resolvePromptSelection({ prompt: promptFile, promptKey });
      const paths = await ensurePromptCache(identity);
      prompt = { ...identity, cache: cacheDisplayPaths(paths) };
    }
    const run = {
      schemaVersion: 2,
      runId,
      name,
      summary,
      intent: one(flags, 'intent', false) ?? summary,
      prompt,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      inputs: parseInputs(flags.input),
      plan: [],
      facts: {},
      factHistory: [],
      decisions: [],
      cursor: {
        currentStep: null,
        nextAction: '',
        system: '',
        lastUrl: '',
        at: createdAt,
      },
      data: {},
      waiting: null,
      waitHistory: [],
      evidenceCount: 0,
      evidenceSummary: {},
      evidenceRecent: [],
      authorizations: {},
      recipe: {
        version: null,
        selections: [],
      },
      executionHistory: [],
    };
    await mkdir(runDir(runId), { recursive: true });
    await saveRun(run);
    await writeFile(join(runDir(runId), 'evidence.jsonl'), '', 'utf8');
    await writeFile(join(runDir(runId), 'events.jsonl'), '', 'utf8');
    console.log(`Created workflow run: ${runId}`);
    console.log(`State: ${join('.workflow-runs', runId, 'state.json')}`);
    return;
  }

  if (command === 'latest') {
    const run = await latestRun(
      one(flags, 'workflow-name', false) ?? one(flags, 'name', false),
      parseInputs(flags.input),
    );
    console.log(run.runId);
    return;
  }

  const runId = one(flags, 'run');
  const run = await loadRun(runId);

  if (command === 'show') {
    console.log(JSON.stringify(run, null, 2));
    return;
  }

  if (command === 'context') {
    console.log(contextText(run));
    return;
  }

  if (command === 'plan-add') {
    if (run.status === 'completed') throw new Error('Completed runs cannot be changed');
    const id = safeName(one(flags, 'id'), 'step id');
    if (run.plan.some((step) => step.id === id)) throw new Error(`Plan step already exists: ${id}`);
    const step = {
      id,
      title: one(flags, 'title'),
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const after = one(flags, 'after', false);
    if (after) {
      const index = run.plan.findIndex((item) => item.id === safeName(after, 'after step id'));
      if (index < 0) throw new Error(`Plan step not found: ${after}`);
      run.plan.splice(index + 1, 0, step);
    } else {
      run.plan.push(step);
    }
    await saveRun(run);
    console.log(`Plan step added: ${id}`);
    return;
  }

  if (command === 'step') {
    if (run.status === 'waiting') throw new Error('Run is waiting; resume it before changing a step');
    if (run.status === 'completed') throw new Error('Completed runs cannot be changed');
    const id = safeName(one(flags, 'id'), 'step id');
    const status = one(flags, 'status');
    if (!STEP_STATUSES.has(status)) {
      throw new Error(`Step status must be one of: ${[...STEP_STATUSES].join(', ')}`);
    }
    const step = findStep(run, id);
    step.status = status;
    step.updatedAt = new Date().toISOString();
    const note = one(flags, 'note', false);
    if (note) step.note = note;
    if (status === 'in_progress') {
      run.cursor.currentStep = id;
      run.cursor.nextAction = step.title;
      run.cursor.at = step.updatedAt;
    }
    await saveRun(run);
    console.log(`Step ${id}: ${status}`);
    return;
  }

  if (command === 'fact') {
    if (run.status === 'completed') throw new Error('Completed runs cannot be changed');
    const key = one(flags, 'key');
    const value = one(flags, 'value');
    const source = one(flags, 'source', false) ?? '';
    const at = new Date().toISOString();
    setPath(run.facts, key, value);
    run.factHistory.push({ key, value, source, at });
    invalidateAuthorizations(run, `Fact changed: ${key}`);
    await saveRun(run);
    console.log(`Fact recorded: ${key}`);
    return;
  }

  if (command === 'decision') {
    if (run.status === 'completed') throw new Error('Completed runs cannot be changed');
    const name = safeName(one(flags, 'name'), 'decision name');
    const decision = {
      name,
      condition: one(flags, 'condition', false) ?? '',
      selected: one(flags, 'selected'),
      reason: one(flags, 'reason'),
      at: new Date().toISOString(),
    };
    run.decisions.push(decision);
    invalidateAuthorizations(run, `Decision changed: ${name}`);
    await saveRun(run);
    console.log(`Decision recorded: ${name} -> ${decision.selected}`);
    return;
  }

  if (command === 'checkpoint') {
    if (run.status === 'completed') throw new Error('Completed runs cannot be changed');
    const stepId = safeName(one(flags, 'step'), 'step id');
    const step = findStep(run, stepId);
    if (step.status === 'completed' || step.status === 'skipped') {
      throw new Error(`Cannot checkpoint inactive step ${stepId} with status ${step.status}`);
    }
    step.status = 'in_progress';
    step.updatedAt = new Date().toISOString();
    run.cursor = {
      currentStep: stepId,
      nextAction: one(flags, 'next'),
      system: one(flags, 'system', false) ?? run.cursor.system ?? '',
      lastUrl: one(flags, 'url', false) ?? run.cursor.lastUrl ?? '',
      at: step.updatedAt,
    };
    await saveRun(run);
    console.log(`Checkpoint saved at ${stepId}.`);
    return;
  }

  if (command === 'pause') {
    if (run.status !== 'active') throw new Error(`Run cannot be paused while ${run.status}`);
    run.status = 'waiting';
    run.waiting = {
      reason: one(flags, 'reason'),
      until: one(flags, 'until', false) ?? '',
      step: run.cursor.currentStep,
      system: run.cursor.system,
      lastUrl: run.cursor.lastUrl,
      at: new Date().toISOString(),
    };
    await saveRun(run);
    console.log(`Waiting${run.cursor.currentStep ? ` at ${run.cursor.currentStep}` : ''}.`);
    return;
  }

  if (command === 'resume') {
    if (run.status !== 'waiting') throw new Error('Run is not waiting');
    run.waitHistory.push({ ...run.waiting, resumedAt: new Date().toISOString() });
    run.status = 'active';
    run.waiting = null;
    await saveRun(run);
    console.log(`Resumed${run.cursor.currentStep ? ` at ${run.cursor.currentStep}` : ''}.`);
    return;
  }

  if (command === 'output' || command === 'set') {
    if (run.status === 'completed') throw new Error('Completed runs cannot be changed');
    const key = one(flags, 'key');
    setPath(run.data, key, one(flags, 'value'));
    invalidateAuthorizations(run, `Output changed: ${key}`);
    await saveRun(run);
    console.log('Output saved.');
    return;
  }

  if (command === 'evidence') {
    const kind = one(flags, 'kind');
    const item = await addEvidence(runId, kind, one(flags, 'value'), one(flags, 'note', false) ?? '');
    run.evidenceCount += 1;
    run.evidenceSummary[kind] = (run.evidenceSummary[kind] ?? 0) + 1;
    run.evidenceRecent.push(item);
    run.evidenceRecent = run.evidenceRecent.slice(-20);
    await saveRun(run);
    console.log('Evidence recorded.');
    return;
  }

  if (command === 'commit') {
    if (run.status === 'completed') throw new Error('Completed runs cannot be changed');
    if (run.status === 'waiting') throw new Error('Run is waiting; resume it before committing');
    const payload = await readProjectJson(one(flags, 'file'));
    const at = new Date().toISOString();
    const steps = payload.steps ?? (payload.step ? [payload.step] : []);
    for (const update of steps) {
      const id = safeName(update.id, 'step id');
      let step = run.plan.find((item) => item.id === id);
      if (!step) {
        if (!update.title) throw new Error(`New step ${id} requires a title`);
        step = {
          id,
          title: update.title,
          status: 'pending',
          createdAt: at,
          updatedAt: at,
        };
        run.plan.push(step);
      }
      if (update.status) {
        if (!STEP_STATUSES.has(update.status)) throw new Error(`Invalid step status: ${update.status}`);
        step.status = update.status;
      }
      if (update.title) step.title = update.title;
      if (update.note) step.note = update.note;
      step.updatedAt = at;
    }

    for (const fact of payload.facts ?? []) {
      if (!fact.key || fact.value === undefined) throw new Error('Each fact requires key and value');
      setPath(run.facts, fact.key, fact.value);
      run.factHistory.push({
        key: fact.key,
        value: fact.value,
        source: fact.source ?? '',
        at,
      });
      invalidateAuthorizations(run, `Fact changed: ${fact.key}`);
    }

    for (const decision of payload.decisions ?? []) {
      const name = safeName(decision.name, 'decision name');
      if (decision.selected === undefined || !decision.reason) {
        throw new Error(`Decision ${name} requires selected and reason`);
      }
      run.decisions.push({
        name,
        condition: decision.condition ?? '',
        selected: decision.selected,
        reason: decision.reason,
        at,
      });
      invalidateAuthorizations(run, `Decision changed: ${name}`);
    }

    for (const output of payload.outputs ?? []) {
      if (!output.key || output.value === undefined) throw new Error('Each output requires key and value');
      setPath(run.data, output.key, output.value);
      invalidateAuthorizations(run, `Output changed: ${output.key}`);
    }

    if (payload.cursor) {
      const stepId = safeName(payload.cursor.step, 'cursor step id');
      findStep(run, stepId);
      run.cursor = {
        currentStep: stepId,
        nextAction: payload.cursor.next ?? '',
        system: payload.cursor.system ?? run.cursor.system ?? '',
        lastUrl: payload.cursor.url ?? run.cursor.lastUrl ?? '',
        at,
      };
    }

    if (payload.recipe) {
      if (payload.recipe.version !== undefined) run.recipe.version = payload.recipe.version;
      for (const selection of payload.recipe.selections ?? []) {
        const nodeId = safeName(selection.nodeId, 'recipe node id');
        const routeId = safeName(selection.routeId, 'recipe route id');
        run.recipe.selections = run.recipe.selections.filter((item) => item.nodeId !== nodeId);
        run.recipe.selections.push({
          nodeId,
          routeId,
          routeSignature: selection.routeSignature ?? 'default',
          at,
        });
      }
    }

    for (const evidence of payload.evidence ?? []) {
      if (!evidence.kind || !evidence.value) throw new Error('Each evidence item requires kind and value');
      const item = await addEvidence(runId, evidence.kind, evidence.value, evidence.note ?? '');
      run.evidenceCount += 1;
      run.evidenceSummary[evidence.kind] = (run.evidenceSummary[evidence.kind] ?? 0) + 1;
      run.evidenceRecent.push(item);
    }
    run.evidenceRecent = run.evidenceRecent.slice(-20);

    if (payload.telemetry) {
      const event = {
        at,
        batchId: payload.telemetry.batchId ?? '',
        nodeId: payload.telemetry.nodeId ?? '',
        routeId: payload.telemetry.routeId ?? '',
        startedAt: payload.telemetry.startedAt ?? '',
        endedAt: payload.telemetry.endedAt ?? at,
        durationMs: Number(payload.telemetry.durationMs ?? 0),
        orchestrationGapMs: Number(payload.telemetry.orchestrationGapMs ?? 0),
        status: payload.telemetry.status ?? 'success',
      };
      if (!Number.isFinite(event.durationMs) || event.durationMs < 0) {
        throw new Error('telemetry.durationMs must be a non-negative number');
      }
      if (!Number.isFinite(event.orchestrationGapMs) || event.orchestrationGapMs < 0) {
        throw new Error('telemetry.orchestrationGapMs must be a non-negative number');
      }
      run.executionHistory.push(event);
      run.executionHistory = run.executionHistory.slice(-100);
      await appendFile(join(runDir(runId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
    }

    await saveRun(run);
    console.log(`Workflow boundary committed: ${steps.map((step) => step.id).join(', ') || 'state-only'}`);
    return;
  }

  if (command === 'review') {
    const output = contextText(run, 'Workflow review');
    await writeFile(join(runDir(runId), 'review.md'), output, 'utf8');
    console.log(output);
    return;
  }

  if (command === 'confirm') {
    const action = safeName(one(flags, 'action'), 'action');
    run.authorizations[action] = {
      by: one(flags, 'by'),
      at: new Date().toISOString(),
    };
    await saveRun(run);
    console.log(`Confirmation recorded for ${action}. This command does not perform an external action.`);
    return;
  }

  if (command === 'complete') {
    if (run.status === 'waiting') throw new Error('Waiting runs must be resumed before completion');
    const unfinished = run.plan.filter((step) => !['completed', 'skipped'].includes(step.status));
    if (unfinished.length > 0) {
      throw new Error(`Cannot complete with unfinished steps: ${unfinished.map((step) => step.id).join(', ')}`);
    }
    run.status = 'completed';
    run.cursor.nextAction = '';
    run.cursor.at = new Date().toISOString();
    await saveRun(run);
    console.log('Workflow completed.');
    return;
  }

  // Compatibility for state created by the initial prototype.
  if (command === 'phase') {
    if (run.status === 'waiting') throw new Error('Run is waiting; resume it before changing phase');
    const next = one(flags, 'to').toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]*$/.test(next)) {
      throw new Error('Phase names use uppercase letters, digits, hyphens, or underscores');
    }
    run.phase = next;
    run.phaseHistory ??= [];
    run.phaseHistory.push({ name: next, at: new Date().toISOString() });
    if (next === 'DONE') run.status = 'completed';
    await saveRun(run);
    console.log(`Phase: ${next}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
