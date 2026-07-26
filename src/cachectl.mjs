#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteJson,
  cacheDisplayPaths,
  cachePaths,
  candidateId,
  ensurePromptCache,
  listPromptIdentities,
  readJson,
  resolvePromptSelection,
} from './cache-store.mjs';

const ACTION_STRATEGIES = new Set(['locator', 'css', 'vision']);
const ACTION_RESULTS = new Set(['success', 'failure']);

function usage(exitCode = 0) {
  console.log(`
Prompt-scoped workflow cache CLI

Commands:
  list
  prepare [--prompt <file> | --prompt-key <key>]
  show [--prompt <file> | --prompt-key <key>]
  definition-step [prompt selection] --id <step-id> --title <text> [--after <step-id>]
  definition-branch [prompt selection] --name <name> --condition <text> --route key=value...
  page-init [prompt selection] --page <page-id> --origin <origin> --route <pattern>
            [--title <text>] [--anchor <text>]... [--viewport <width>x<height>]
  page-show [prompt selection] --page <page-id>
  action-learn [prompt selection] --page <page-id> --name <action-name>
               --strategy <locator|css|vision> --target <value> --postcondition <text>
  action-result [prompt selection] --page <page-id> --name <action-name>
                --candidate <candidate-id> --status <success|failure> [--reason <text>]
  page-invalidate [prompt selection] --page <page-id> --reason <text>

Prompt selection is --prompt <path> or the shell-safe --prompt-key <key>. If the workspace has
exactly one Prompt file, selection can be omitted.

Definitions and page actions are isolated by both prompt file identity and prompt content hash.
Changing a prompt automatically creates a new cache version. Snapshot refs, secrets, and run
variables must never be cached.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
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
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`${label} must use lowercase letters, digits, and hyphens`);
  }
  return value;
}

function parseRoutes(values = []) {
  if (values.length === 0) throw new Error('At least one --route key=value is required');
  return Object.fromEntries(values.map((value) => {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error('--route must use key=value format');
    return [safeName(value.slice(0, separator), 'route name'), value.slice(separator + 1)];
  }));
}

function pagePath(paths, pageId) {
  return join(paths.pagesDir, `${safeName(pageId, 'page id')}.json`);
}

async function loadScope(flags) {
  const identity = await resolvePromptSelection({
    prompt: one(flags, 'prompt', false),
    promptKey: one(flags, 'prompt-key', false),
  });
  const paths = await ensurePromptCache(identity);
  return { identity, paths };
}

async function loadPage(paths, pageId) {
  const path = pagePath(paths, pageId);
  if (!existsSync(path)) throw new Error(`Page cache not found: ${pageId}`);
  return { path, page: await readJson(path) };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') usage();

  if (command === 'list') {
    console.log(JSON.stringify(await listPromptIdentities(), null, 2));
    return;
  }

  const { identity, paths } = await loadScope(flags);

  if (command === 'prepare') {
    console.log(JSON.stringify({
      prompt: identity,
      cache: cacheDisplayPaths(paths),
    }, null, 2));
    return;
  }

  if (command === 'show') {
    const definition = await readJson(paths.definitionPath);
    const { readdir } = await import('node:fs/promises');
    const pages = (await readdir(paths.pagesDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .sort();
    console.log(JSON.stringify({ definition, pages }, null, 2));
    return;
  }

  if (command === 'definition-step') {
    const definition = await readJson(paths.definitionPath);
    const id = safeName(one(flags, 'id'), 'step id');
    const existingIndex = definition.compiled.steps.findIndex((step) => step.id === id);
    const step = {
      id,
      title: one(flags, 'title'),
      updatedAt: new Date().toISOString(),
    };
    if (existingIndex >= 0) definition.compiled.steps.splice(existingIndex, 1);
    const after = one(flags, 'after', false);
    if (after) {
      const afterIndex = definition.compiled.steps.findIndex((item) => item.id === safeName(after, 'after step id'));
      if (afterIndex < 0) throw new Error(`Definition step not found: ${after}`);
      definition.compiled.steps.splice(afterIndex + 1, 0, step);
    } else {
      definition.compiled.steps.push(step);
    }
    definition.updatedAt = new Date().toISOString();
    await atomicWriteJson(paths.definitionPath, definition);
    console.log(`Definition step cached: ${id}`);
    return;
  }

  if (command === 'definition-branch') {
    const definition = await readJson(paths.definitionPath);
    const name = safeName(one(flags, 'name'), 'branch name');
    const branch = {
      name,
      condition: one(flags, 'condition'),
      routes: parseRoutes(flags.route),
      updatedAt: new Date().toISOString(),
    };
    const existingIndex = definition.compiled.branches.findIndex((item) => item.name === name);
    if (existingIndex >= 0) definition.compiled.branches[existingIndex] = branch;
    else definition.compiled.branches.push(branch);
    definition.updatedAt = new Date().toISOString();
    await atomicWriteJson(paths.definitionPath, definition);
    console.log(`Definition branch cached: ${name}`);
    return;
  }

  if (command === 'page-init') {
    const pageId = safeName(one(flags, 'page'), 'page id');
    const path = pagePath(paths, pageId);
    const now = new Date().toISOString();
    const existing = existsSync(path) ? await readJson(path) : null;
    const anchors = [...new Set([...(existing?.fingerprint?.anchors ?? []), ...(flags.anchor ?? [])])];
    const page = {
      schemaVersion: 1,
      prompt: identity,
      id: pageId,
      fingerprint: {
        origin: one(flags, 'origin'),
        route: one(flags, 'route'),
        title: one(flags, 'title', false) ?? existing?.fingerprint?.title ?? '',
        anchors,
        viewport: one(flags, 'viewport', false) ?? existing?.fingerprint?.viewport ?? '',
      },
      actions: existing?.actions ?? {},
      invalidatedAt: null,
      invalidationReason: '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await atomicWriteJson(path, page);
    console.log(`Page cache ready: ${pageId}`);
    return;
  }

  if (command === 'page-show') {
    const { page } = await loadPage(paths, one(flags, 'page'));
    console.log(JSON.stringify(page, null, 2));
    return;
  }

  if (command === 'action-learn') {
    const { path, page } = await loadPage(paths, one(flags, 'page'));
    const name = safeName(one(flags, 'name'), 'action name');
    const strategy = one(flags, 'strategy');
    if (!ACTION_STRATEGIES.has(strategy)) {
      throw new Error(`Action strategy must be one of: ${[...ACTION_STRATEGIES].join(', ')}`);
    }
    if (strategy === 'vision' && (!page.fingerprint.viewport || page.fingerprint.anchors.length === 0)) {
      throw new Error('Vision actions require a cached viewport and at least one visual anchor');
    }
    const target = one(flags, 'target');
    const id = candidateId(strategy, target);
    const now = new Date().toISOString();
    const action = page.actions[name] ??= {
      name,
      postcondition: '',
      candidates: [],
      createdAt: now,
      updatedAt: now,
    };
    action.postcondition = one(flags, 'postcondition');
    const existing = action.candidates.find((candidate) => candidate.id === id);
    if (existing) {
      existing.updatedAt = now;
    } else {
      action.candidates.unshift({
        id,
        strategy,
        target,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        learnedAt: now,
        updatedAt: now,
      });
    }
    action.updatedAt = now;
    page.invalidatedAt = null;
    page.invalidationReason = '';
    page.updatedAt = now;
    await atomicWriteJson(path, page);
    console.log(`Action candidate cached: ${name} ${id}`);
    return;
  }

  if (command === 'action-result') {
    const { path, page } = await loadPage(paths, one(flags, 'page'));
    const name = safeName(one(flags, 'name'), 'action name');
    const action = page.actions[name];
    if (!action) throw new Error(`Cached action not found: ${name}`);
    const candidate = action.candidates.find((item) => item.id === one(flags, 'candidate'));
    if (!candidate) throw new Error(`Action candidate not found: ${one(flags, 'candidate')}`);
    const status = one(flags, 'status');
    if (!ACTION_RESULTS.has(status)) {
      throw new Error(`Action result must be one of: ${[...ACTION_RESULTS].join(', ')}`);
    }
    const now = new Date().toISOString();
    if (status === 'success') {
      candidate.successCount += 1;
      candidate.consecutiveFailures = 0;
      candidate.lastSuccessAt = now;
      delete candidate.lastFailureReason;
    } else {
      candidate.failureCount += 1;
      candidate.consecutiveFailures += 1;
      candidate.lastFailureAt = now;
      candidate.lastFailureReason = one(flags, 'reason', false) ?? '';
    }
    candidate.updatedAt = now;
    action.updatedAt = now;
    page.updatedAt = now;
    await atomicWriteJson(path, page);
    console.log(`Action result recorded: ${name} ${status}`);
    return;
  }

  if (command === 'page-invalidate') {
    const { path, page } = await loadPage(paths, one(flags, 'page'));
    page.invalidatedAt = new Date().toISOString();
    page.invalidationReason = one(flags, 'reason');
    page.updatedAt = page.invalidatedAt;
    await atomicWriteJson(path, page);
    console.log(`Page cache invalidated: ${page.id}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
