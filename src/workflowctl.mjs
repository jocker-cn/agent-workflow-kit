#!/usr/bin/env node

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(process.cwd());
const RUNS_DIR = join(ROOT, '.workflow-runs');

function usage(exitCode = 0) {
  console.log(`\nWorkflow state CLI\n\nCommands:\n  init --workflow <name> --summary <text> [--input key=value]...\n  show --run <run-id>\n  latest --workflow <name>\n  phase --run <run-id> --to <phase-name>\n  pause --run <run-id> --reason <text>\n  resume --run <run-id>\n  set --run <run-id> --key <a.b.c> --value <value>\n  evidence --run <run-id> --kind <kind> --value <path-or-url> [--note <text>]\n  review --run <run-id>\n  confirm --run <run-id> --action <action> --by <name>\n\nWorkflow contracts in workflows/<name>/workflow.yaml define phase order, required data, evidence, and gates.\n`);
  process.exit(exitCode);
}

function args(argv) {
  const [command, ...rest] = argv;
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
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new Error(`${label} must use lowercase letters, digits, and hyphens`);
  return value;
}

function safePart(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workflow';
}

function runDir(runId) {
  if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('Invalid run id');
  return join(RUNS_DIR, runId);
}

function getPath(target, dottedKey) {
  return dottedKey.split('.').reduce((value, part) => value?.[part], target);
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

async function loadContract(workflow) {
  const safeWorkflow = safeName(workflow, 'workflow');
  const path = join(ROOT, 'workflows', safeWorkflow, 'workflow.yaml');
  if (!existsSync(path)) return null;
  const contract = parseYaml(await readFile(path, 'utf8'));
  if (!contract || contract.id !== workflow || !Array.isArray(contract.phases) || contract.phases.length === 0) {
    throw new Error(`Invalid workflow contract: ${path}`);
  }
  return contract;
}

async function loadRun(runId) {
  const statePath = join(runDir(runId), 'state.json');
  if (!existsSync(statePath)) throw new Error(`Run not found: ${runId}`);
  return JSON.parse(await readFile(statePath, 'utf8'));
}

async function latestRun(workflow) {
  const safeWorkflow = safeName(workflow, 'workflow');
  if (!existsSync(RUNS_DIR)) throw new Error(`No runs found for workflow ${safeWorkflow}`);
  const { readdir } = await import('node:fs/promises');
  const runIds = await readdir(RUNS_DIR, { withFileTypes: true });
  const runs = await Promise.all(runIds
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try { return await loadRun(entry.name); } catch { return null; }
    }));
  const run = runs.filter((item) => item?.workflow === safeWorkflow && item.status !== 'completed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!run) throw new Error(`No resumable runs found for workflow ${safeWorkflow}`);
  return run;
}

async function saveRun(run) {
  run.updatedAt = new Date().toISOString();
  const statePath = join(runDir(run.runId), 'state.json');
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, statePath);
}

function validateRules(run, rules = {}, label) {
  const missingData = (rules.requiredData ?? []).filter((key) => {
    const value = getPath(run.data, key);
    return value === undefined || value === null || value === '';
  });
  const missingEvidence = (rules.requiredEvidenceKinds ?? []).filter((kind) => !(run.evidenceSummary?.[kind] > 0));
  if (missingData.length || missingEvidence.length) {
    const details = [
      missingData.length ? `data: ${missingData.join(', ')}` : '',
      missingEvidence.length ? `evidence: ${missingEvidence.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`${label} requirements are incomplete (${details})`);
  }
}

function transitionContract(run, contract, next) {
  if (!contract) return;
  const currentIndex = contract.phases.indexOf(run.phase);
  const nextIndex = contract.phases.indexOf(next);
  if (currentIndex < 0 || nextIndex < 0) throw new Error('Run phase is not defined by its workflow contract');
  if (nextIndex !== currentIndex + 1) throw new Error(`Contract requires phase ${contract.phases[currentIndex + 1] ?? 'none'} after ${run.phase}`);
  validateRules(run, contract.checks?.[next], `Phase ${next}`);
  for (const [action, gate] of Object.entries(contract.gates ?? {})) {
    if (gate.targetPhase === next && !run.authorizations?.[action]) {
      throw new Error(`Phase ${next} requires confirmation for action ${action}`);
    }
  }
}

async function addEvidence(runId, kind, value, note = '') {
  const item = { at: new Date().toISOString(), kind, value, note };
  await appendFile(join(runDir(runId), 'evidence.jsonl'), `${JSON.stringify(item)}\n`, 'utf8');
}

function toMarkdown(value, depth = 0) {
  const indent = '  '.repeat(depth);
  if (value === null || typeof value !== 'object') return `${value ?? 'N/A'}`;
  const entries = Object.entries(value);
  if (entries.length === 0) return 'N/A';
  return entries.map(([key, child]) => {
    if (child !== null && typeof child === 'object') return `${indent}- ${key}:\n${toMarkdown(child, depth + 1)}`;
    return `${indent}- ${key}: ${child ?? 'N/A'}`;
  }).join('\n');
}

function reviewText(run) {
  return `# Workflow review\n\n- Run: \`${run.runId}\`\n- Workflow: ${run.workflow}\n- Current phase: **${run.phase}**\n- Summary: ${run.summary}\n- Evidence items: ${run.evidenceCount}\n\n## Inputs\n\n${toMarkdown(run.inputs)}\n\n## Recorded data\n\n${toMarkdown(run.data)}\n\n## Authorizations\n\n${toMarkdown(run.authorizations)}\n`;
}

async function main() {
  const { command, flags } = args(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') usage();

  if (command === 'init') {
    const workflow = safeName(one(flags, 'workflow'), 'workflow');
    const contract = await loadContract(workflow);
    const createdAt = new Date().toISOString();
    const runId = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${safePart(workflow)}-${randomUUID().slice(0, 6)}`;
    const phase = contract?.initialPhase ?? 'INIT';
    const run = { runId, workflow, summary: one(flags, 'summary'), status: 'active', phase, phaseHistory: [{ name: phase, at: createdAt }], createdAt, updatedAt: createdAt, inputs: parseInputs(flags.input), data: {}, evidenceCount: 0, evidenceSummary: {}, authorizations: {} };
    await mkdir(runDir(runId), { recursive: true });
    await saveRun(run);
    await writeFile(join(runDir(runId), 'evidence.jsonl'), '', 'utf8');
    console.log(`Created workflow run: ${runId}`);
    console.log(`State: ${join('.workflow-runs', runId, 'state.json')}`);
    return;
  }

  if (command === 'latest') {
    const run = await latestRun(one(flags, 'workflow'));
    console.log(run.runId);
    return;
  }

  const runId = one(flags, 'run');
  const run = await loadRun(runId);
  const contract = await loadContract(run.workflow);

  if (command === 'show') {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  if (command === 'phase') {
    if (run.status === 'waiting') throw new Error('Run is waiting; resume it before changing phase');
    const next = one(flags, 'to').toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]*$/.test(next)) throw new Error('Phase names use uppercase letters, digits, hyphens, or underscores');
    if (next === run.phase) throw new Error(`Run is already in ${next}`);
    transitionContract(run, contract, next);
    run.phase = next;
    if (next === 'DONE') run.status = 'completed';
    run.phaseHistory.push({ name: next, at: new Date().toISOString() });
    await saveRun(run);
    console.log(`Phase: ${next}`);
    return;
  }
  if (command === 'pause') {
    if (run.status !== 'active') throw new Error(`Run cannot be paused while ${run.status}`);
    run.status = 'waiting';
    run.waiting = { reason: one(flags, 'reason'), at: new Date().toISOString(), phase: run.phase };
    await saveRun(run);
    console.log(`Waiting at ${run.phase}.`);
    return;
  }
  if (command === 'resume') {
    if (run.status !== 'waiting') throw new Error('Run is not waiting');
    run.status = 'active';
    delete run.waiting;
    await saveRun(run);
    console.log(`Resumed at ${run.phase}.`);
    return;
  }
  if (command === 'set') {
    setPath(run.data, one(flags, 'key'), one(flags, 'value'));
    await saveRun(run);
    console.log('Saved.');
    return;
  }
  if (command === 'evidence') {
    const kind = one(flags, 'kind');
    await addEvidence(runId, kind, one(flags, 'value'), one(flags, 'note', false) ?? '');
    run.evidenceCount += 1;
    run.evidenceSummary[kind] = (run.evidenceSummary[kind] ?? 0) + 1;
    await saveRun(run);
    console.log('Evidence recorded.');
    return;
  }
  if (command === 'review') {
    validateRules(run, contract?.checks?.REVIEW, 'Review');
    const output = reviewText(run);
    await writeFile(join(runDir(runId), 'review.md'), output, 'utf8');
    console.log(output);
    return;
  }
  if (command === 'confirm') {
    const action = safeName(one(flags, 'action'), 'action');
    const gate = contract?.gates?.[action];
    if (!gate) throw new Error(`Workflow ${run.workflow} has no confirmation gate for action ${action}`);
    if (gate.authorizationPhase && run.phase !== gate.authorizationPhase) throw new Error(`Action ${action} can be confirmed only in ${gate.authorizationPhase}`);
    validateRules(run, gate, `Confirmation for ${action}`);
    run.authorizations[action] = { by: one(flags, 'by'), at: new Date().toISOString() };
    await saveRun(run);
    console.log(`Confirmation recorded for ${action}. This command does not perform an external action.`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
