#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CACHE_ROOT,
  ROOT,
  atomicWriteJson,
  cacheDisplayPaths,
  cachePaths,
  candidateId,
  ensurePromptCache,
  listPromptIdentities,
  normalizeDefinition,
  readJson,
  resolvePromptSelection,
  resolveWorkflowRecipe,
  routeSignature,
} from './cache-store.mjs';

const ACTION_STRATEGIES = new Set(['locator', 'css', 'vision', 'page']);
const ACTION_RESULTS = new Set(['success', 'failure']);
const ACTION_OPERATIONS = new Set([
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'extract',
  'switch-page',
  'wait',
]);
const LOCATOR_KINDS = new Set(['role', 'text', 'label', 'placeholder', 'testid']);
const NODE_TYPES = new Set(['browser', 'decision', 'human', 'report']);
const ROUTE_STATUSES = new Set(['learned', 'unlearned', 'disabled']);

function usage(exitCode = 0) {
  console.log(`
Prompt-scoped workflow cache CLI

Commands:
  list
  prepare [--prompt <file> | --prompt-key <key>]
  status [--prompt <file> | --prompt-key <key>]
  show [--prompt <file> | --prompt-key <key>]
  recipe-show [prompt selection]
  recipe-node [prompt selection] --id <node-id> --title <text>
              [--description <text>] [--node-class <browser|decision|human|report>]
              [--depends-on <fact-key>]...
  recipe-route [prompt selection] --node <node-id> --id <route-id>
               [--when key=value]... [--action <page-id>[@variant]/<action-name>]...
               [--postcondition <text>]
               [--expect-text <text> | --expect-url <glob> | --expect-action <action-ref>]
               [--transition-timeout-ms <milliseconds>]
               [--status <learned|unlearned|disabled>]
  recipe-resolve [prompt selection] [--value key=value]...
  definition-step [prompt selection] --id <step-id> --title <text> [--after <step-id>]
  definition-branch [prompt selection] --name <name> --condition <text> --route key=value...
  page-init [prompt selection] --page <page-id> --origin <origin> --route <pattern>
            [--variant <variant-id>] [--context key=value]...
            [--title <text>] [--anchor <text>]... [--viewport <width>x<height>]
  page-show [prompt selection] --page <page-id> [--variant <variant-id>]
  action-learn [prompt selection] --page <page-id> --name <action-name>
               --strategy <locator|css|vision|page> --target <value> --postcondition <text>
               [--variant <variant-id>] [--operation <operation>]
               [--locator-kind <role|text|label|placeholder|testid>] [--role <aria-role>]
               [--value-from <input-or-fact-key>] [--extract-to <fact-key>]
               [--extract-attribute <attribute-name>] [--tab-role <role-name>]
               [--has-text-from <input-or-fact-key>] [--match-mode <strict|first|all>]
               [--nth <zero-based-index>]
               [--wait-for <visible|hidden|attached|detached|stable>]
               [--timeout-ms <milliseconds>] [--stable-ms <milliseconds>]
  action-result [prompt selection] --page <page-id> --name <action-name>
                --candidate <candidate-id> --status <success|failure>
                [--variant <variant-id>] [--reason <text>] [timing fields]
  action-result-batch [prompt selection] --file <project-relative-json>
  page-invalidate [prompt selection] --page <page-id> [--variant <variant-id>] --reason <text>
  clear [prompt selection] [--scope <current|pages|workflow>] [--apply <true|false>]

Prompt selection is --prompt <path> or the shell-safe --prompt-key <key>. If the workspace has
exactly one Prompt file, selection can be omitted.

Definitions are versioned by Prompt content hash. Page actions are reusable across versions of the
same Prompt file. Snapshot refs, secrets, and run variables must never be cached.

Workflow recipes contain reusable nodes and locally guarded routes. Business instance values such
as order.id stay in run state; only values that change the path belong in route --when guards.

clear is preview-only unless --apply true is supplied. "current" removes the current definition
version, "pages" removes reusable page caches, and "workflow" removes all definition versions and
page caches belonging to the selected Prompt file.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, ...rest] = normalized;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'help') {
      flags.help = ['true'];
      continue;
    }
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

function parseAssignments(values = [], label = '--value') {
  return Object.fromEntries(values.map((value) => {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error(`${label} must use key=value format`);
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

function parseActionRef(value) {
  const separator = value.indexOf('/');
  if (separator < 1 || separator === value.length - 1) {
    throw new Error('--action must use page-id/action-name format');
  }
  const pageAndVariant = value.slice(0, separator).split('@');
  if (pageAndVariant.length > 2) throw new Error('--action page may contain one @variant suffix');
  return {
    page: safeName(pageAndVariant[0], 'action page id'),
    variant: safeName(pageAndVariant[1] ?? 'default', 'action variant id'),
    action: safeName(value.slice(separator + 1), 'action name'),
  };
}

function expandAssignments(assignments) {
  const expanded = {};
  for (const [key, value] of Object.entries(assignments)) {
    const parts = key.split('.');
    let cursor = expanded;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
    cursor[parts.at(-1)] = value;
  }
  return expanded;
}

function bumpRecipe(definition) {
  definition.schemaVersion = Math.max(definition.schemaVersion ?? 1, 4);
  definition.compiled.version += 1;
  definition.updatedAt = new Date().toISOString();
}

function normalizePage(page) {
  if (page.variants) {
    page.schemaVersion = 2;
    return page;
  }
  const {
    fingerprint = {},
    actions = {},
    invalidatedAt = null,
    invalidationReason = '',
  } = page;
  return {
    schemaVersion: 2,
    prompt: page.prompt,
    id: page.id,
    variants: {
      default: {
        id: 'default',
        context: {},
        fingerprint,
        actions,
        invalidatedAt,
        invalidationReason,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      },
    },
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function variantId(flags) {
  return safeName(one(flags, 'variant', false) ?? 'default', 'variant id');
}

function getVariant(page, id) {
  const variant = page.variants[id];
  if (!variant) throw new Error(`Page variant not found: ${page.id}/${id}`);
  return variant;
}

async function readProjectJson(file) {
  const absolute = resolve(ROOT, file);
  const pathFromRoot = relative(ROOT, absolute);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error('--file must be inside the project');
  }
  return JSON.parse(await readFile(absolute, 'utf8'));
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
  return { path, page: normalizePage(await readJson(path)) };
}

function compilationStatus(definition) {
  const normalized = normalizeDefinition(definition);
  if (normalized.compiled.nodes.length === 0) return 'uncompiled';
  if (
    normalized.schemaVersion < 4
    || normalized.compiled.nodes.some((node) => !node.description || !node.affinity)
  ) {
    return 'needs-recompile';
  }
  return 'ready';
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help' || flags.help) usage();

  if (command === 'list') {
    console.log(JSON.stringify(await listPromptIdentities(), null, 2));
    return;
  }

  if (command === 'clear') {
    const identity = await resolvePromptSelection({
      prompt: one(flags, 'prompt', false),
      promptKey: one(flags, 'prompt-key', false),
    });
    const paths = cachePaths(identity);
    const scope = one(flags, 'scope', false) ?? 'current';
    if (!['current', 'pages', 'workflow'].includes(scope)) {
      throw new Error('--scope must be current, pages, or workflow');
    }
    const definitionRoot = dirname(paths.definitionPath);
    const pagesRoot = join(CACHE_ROOT, 'pages', identity.key);
    const targets = scope === 'current'
      ? [paths.definitionPath]
      : scope === 'pages'
        ? [pagesRoot]
        : [definitionRoot, pagesRoot];
    for (const target of targets) {
      const relativeTarget = relative(CACHE_ROOT, resolve(target));
      if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget) || relativeTarget === '') {
        throw new Error(`Refusing to clear unsafe cache target: ${target}`);
      }
    }
    const apply = (one(flags, 'apply', false) ?? 'false') === 'true';
    const result = {
      status: apply ? 'cleared' : 'preview',
      scope,
      prompt: identity,
      targets: targets.map((target) => relative(ROOT, target).replaceAll('\\', '/')),
      existingTargets: targets
        .filter((target) => existsSync(target))
        .map((target) => relative(ROOT, target).replaceAll('\\', '/')),
    };
    if (apply) {
      await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true })));
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { identity, paths } = await loadScope(flags);

  if (command === 'prepare' || command === 'status') {
    const definition = await readJson(paths.definitionPath);
    console.log(JSON.stringify({
      prompt: identity,
      cache: cacheDisplayPaths(paths),
      compilerStatus: compilationStatus(definition),
      recipeVersion: normalizeDefinition(definition).compiled.version,
    }, null, 2));
    return;
  }

  if (command === 'show') {
    const definition = normalizeDefinition(await readJson(paths.definitionPath));
    const { readdir } = await import('node:fs/promises');
    const pages = (await readdir(paths.pagesDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .sort();
    console.log(JSON.stringify({ definition, pages }, null, 2));
    return;
  }

  if (command === 'recipe-show') {
    const definition = normalizeDefinition(await readJson(paths.definitionPath));
    console.log(JSON.stringify({
      prompt: definition.prompt,
      version: definition.compiled.version,
      nodes: definition.compiled.nodes,
    }, null, 2));
    return;
  }

  if (command === 'recipe-node') {
    const definition = normalizeDefinition(await readJson(paths.definitionPath));
    const id = safeName(one(flags, 'id'), 'node id');
    const type = one(flags, 'node-class', false) ?? 'browser';
    if (!NODE_TYPES.has(type)) {
      throw new Error(`Node type must be one of: ${[...NODE_TYPES].join(', ')}`);
    }
    const now = new Date().toISOString();
    const existing = definition.compiled.nodes.find((node) => node.id === id);
    const node = {
      ...existing,
      id,
      title: one(flags, 'title'),
      description: one(flags, 'description', false) ?? existing?.description ?? one(flags, 'title'),
      type,
      dependsOn: [...new Set(flags['depends-on'] ?? existing?.dependsOn ?? [])].sort(),
      routes: existing?.routes ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) definition.compiled.nodes.splice(definition.compiled.nodes.indexOf(existing), 1, node);
    else definition.compiled.nodes.push(node);
    bumpRecipe(definition);
    await atomicWriteJson(paths.definitionPath, definition);
    console.log(`Recipe node cached: ${id} (version ${definition.compiled.version})`);
    return;
  }

  if (command === 'recipe-route') {
    const definition = normalizeDefinition(await readJson(paths.definitionPath));
    const nodeId = safeName(one(flags, 'node'), 'node id');
    const node = definition.compiled.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Recipe node not found: ${nodeId}`);
    const id = safeName(one(flags, 'id'), 'route id');
    const status = one(flags, 'status', false) ?? 'learned';
    if (!ROUTE_STATUSES.has(status)) {
      throw new Error(`Route status must be one of: ${[...ROUTE_STATUSES].join(', ')}`);
    }
    const when = parseAssignments(flags.when ?? [], '--when');
    for (const key of Object.keys(when)) {
      if (!node.dependsOn.includes(key)) {
        throw new Error(`Route guard ${key} is not declared in ${nodeId}.dependsOn`);
      }
    }
    const actions = (flags.action ?? []).map(parseActionRef);
    if (status === 'learned' && node.type === 'browser' && actions.length === 0) {
      throw new Error('A learned browser route requires at least one --action');
    }
    const now = new Date().toISOString();
    const transitionTimeoutMs = Number(one(flags, 'transition-timeout-ms', false) ?? 10000);
    if (!Number.isFinite(transitionTimeoutMs) || transitionTimeoutMs < 0) {
      throw new Error('--transition-timeout-ms must be a non-negative number');
    }
    const existing = node.routes.find((route) => route.id === id);
    const route = {
      id,
      when,
      signature: routeSignature(when),
      status,
      actions,
      postcondition: one(flags, 'postcondition', false) ?? '',
      expectation: one(flags, 'expect-text', false)
        ? { kind: 'text', value: one(flags, 'expect-text', false) }
        : one(flags, 'expect-url', false)
          ? { kind: 'url', value: one(flags, 'expect-url', false) }
          : one(flags, 'expect-action', false)
            ? { kind: 'action', ...parseActionRef(one(flags, 'expect-action', false)) }
            : null,
      transitionTimeoutMs,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) node.routes.splice(node.routes.indexOf(existing), 1, route);
    else node.routes.push(route);
    node.updatedAt = now;
    bumpRecipe(definition);
    await atomicWriteJson(paths.definitionPath, definition);
    console.log(`Recipe route cached: ${nodeId}/${id} (version ${definition.compiled.version})`);
    return;
  }

  if (command === 'recipe-resolve') {
    const definition = normalizeDefinition(await readJson(paths.definitionPath));
    const values = expandAssignments(parseAssignments(flags.value ?? [], '--value'));
    const resolution = resolveWorkflowRecipe(definition, values);
    console.log(JSON.stringify({
      prompt: identity,
      recipeVersion: definition.compiled.version,
      ...resolution,
    }, null, 2));
    return;
  }

  if (command === 'definition-step') {
    const definition = normalizeDefinition(await readJson(paths.definitionPath));
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
    const definition = normalizeDefinition(await readJson(paths.definitionPath));
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
    const page = existsSync(path)
      ? normalizePage(await readJson(path))
      : {
          schemaVersion: 2,
          prompt: identity,
          id: pageId,
          variants: {},
          createdAt: now,
          updatedAt: now,
        };
    const id = variantId(flags);
    const existing = page.variants[id];
    const anchors = [...new Set([...(existing?.fingerprint?.anchors ?? []), ...(flags.anchor ?? [])])];
    page.variants[id] = {
      id,
      context: parseAssignments(flags.context ?? [], '--context'),
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
    page.schemaVersion = 2;
    page.prompt = identity;
    page.updatedAt = now;
    await atomicWriteJson(path, page);
    console.log(`Page cache ready: ${pageId}/${id}`);
    return;
  }

  if (command === 'page-show') {
    const { page } = await loadPage(paths, one(flags, 'page'));
    const id = variantId(flags);
    console.log(JSON.stringify({
      schemaVersion: 2,
      prompt: page.prompt,
      pageId: page.id,
      ...getVariant(page, id),
    }, null, 2));
    return;
  }

  if (command === 'action-learn') {
    const { path, page } = await loadPage(paths, one(flags, 'page'));
    const variant = getVariant(page, variantId(flags));
    const name = safeName(one(flags, 'name'), 'action name');
    const strategy = one(flags, 'strategy');
    if (!ACTION_STRATEGIES.has(strategy)) {
      throw new Error(`Action strategy must be one of: ${[...ACTION_STRATEGIES].join(', ')}`);
    }
    if (strategy === 'vision' && (!variant.fingerprint.viewport || variant.fingerprint.anchors.length === 0)) {
      throw new Error('Vision actions require a cached viewport and at least one visual anchor');
    }
    const operation = one(flags, 'operation', false) ?? 'click';
    if (!ACTION_OPERATIONS.has(operation)) {
      throw new Error(`Action operation must be one of: ${[...ACTION_OPERATIONS].join(', ')}`);
    }
    if (['fill', 'select'].includes(operation) && !one(flags, 'value-from', false)) {
      throw new Error(`${operation} actions require --value-from`);
    }
    if (operation === 'extract' && !one(flags, 'extract-to', false)) {
      throw new Error('extract actions require --extract-to');
    }
    const waitFor = one(flags, 'wait-for', false) ?? 'visible';
    if (operation === 'wait' && !['visible', 'hidden', 'attached', 'detached', 'stable'].includes(waitFor)) {
      throw new Error('--wait-for must be visible, hidden, attached, detached, or stable');
    }
    if (strategy === 'vision' && (operation !== 'click' || !/^\d+,\d+$/.test(one(flags, 'target')))) {
      throw new Error('Vision fast-path actions currently require --operation click and --target x,y');
    }
    if (strategy === 'page' && operation !== 'switch-page') {
      throw new Error('Page strategy requires --operation switch-page and a URL glob target');
    }
    if (operation === 'switch-page' && strategy !== 'page') {
      throw new Error('switch-page actions require --strategy page');
    }
    const extractAttribute = one(flags, 'extract-attribute', false) ?? '';
    if (extractAttribute && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(extractAttribute)) {
      throw new Error('--extract-attribute must be a valid HTML attribute name');
    }
    const target = one(flags, 'target');
    const matchMode = one(flags, 'match-mode', false) ?? 'strict';
    if (!['strict', 'first', 'all'].includes(matchMode)) {
      throw new Error('--match-mode must be strict, first, or all');
    }
    const nthValue = one(flags, 'nth', false);
    const nth = nthValue === undefined ? null : Number(nthValue);
    if (nth !== null && (!Number.isInteger(nth) || nth < 0)) {
      throw new Error('--nth must be a non-negative integer');
    }
    const timeoutMs = Number(one(flags, 'timeout-ms', false) ?? 10000);
    const stableMs = Number(one(flags, 'stable-ms', false) ?? 300);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('--timeout-ms must be non-negative');
    if (!Number.isFinite(stableMs) || stableMs < 0) throw new Error('--stable-ms must be non-negative');
    const locatorKind = one(flags, 'locator-kind', false);
    if (locatorKind && !LOCATOR_KINDS.has(locatorKind)) {
      throw new Error(`Locator kind must be one of: ${[...LOCATOR_KINDS].join(', ')}`);
    }
    if (locatorKind === 'role' && !one(flags, 'role', false)) {
      throw new Error('Role locators require --role');
    }
    const selector = strategy === 'css'
      ? { kind: 'css', value: target }
      : locatorKind
        ? {
            kind: locatorKind,
            value: target,
            ...(locatorKind === 'role' ? { role: one(flags, 'role', false) } : {}),
          }
        : null;
    const point = strategy === 'vision'
      ? Object.fromEntries(['x', 'y'].map((key, index) => [key, Number(target.split(',')[index])]))
      : null;
    const id = candidateId(strategy, selector ? JSON.stringify(selector) : target);
    const now = new Date().toISOString();
    const action = variant.actions[name] ??= {
      name,
      operation,
      valueFrom: '',
      extractTo: '',
      extractAttribute: '',
      tabRole: '',
      hasTextFrom: '',
      matchMode: 'strict',
      nth: null,
      waitFor: 'visible',
      timeoutMs: 10000,
      stableMs: 300,
      postcondition: '',
      candidates: [],
      createdAt: now,
      updatedAt: now,
    };
    action.operation = operation;
    action.valueFrom = one(flags, 'value-from', false) ?? action.valueFrom ?? '';
    action.extractTo = one(flags, 'extract-to', false) ?? action.extractTo ?? '';
    action.extractAttribute = extractAttribute || action.extractAttribute || '';
    action.tabRole = one(flags, 'tab-role', false) ?? action.tabRole ?? '';
    action.hasTextFrom = one(flags, 'has-text-from', false) ?? action.hasTextFrom ?? '';
    action.matchMode = matchMode;
    action.nth = nth;
    action.waitFor = waitFor;
    action.timeoutMs = timeoutMs;
    action.stableMs = stableMs;
    action.postcondition = one(flags, 'postcondition');
    const existing = action.candidates.find((candidate) => candidate.id === id);
    if (existing) {
      existing.updatedAt = now;
      if (selector) existing.selector = selector;
    } else {
      action.candidates.unshift({
        id,
        strategy,
        target,
        ...(selector ? { selector } : {}),
        ...(point ? { point } : {}),
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        learnedAt: now,
        updatedAt: now,
      });
    }
    action.updatedAt = now;
    variant.invalidatedAt = null;
    variant.invalidationReason = '';
    variant.updatedAt = now;
    page.updatedAt = now;
    await atomicWriteJson(path, page);
    console.log(`Action candidate cached: ${name} ${id}`);
    return;
  }

  if (command === 'action-result') {
    const { path, page } = await loadPage(paths, one(flags, 'page'));
    const variant = getVariant(page, variantId(flags));
    const name = safeName(one(flags, 'name'), 'action name');
    const action = variant.actions[name];
    if (!action) throw new Error(`Cached action not found: ${name}`);
    const candidate = action.candidates.find((item) => item.id === one(flags, 'candidate'));
    if (!candidate) throw new Error(`Action candidate not found: ${one(flags, 'candidate')}`);
    const status = one(flags, 'status');
    if (!ACTION_RESULTS.has(status)) {
      throw new Error(`Action result must be one of: ${[...ACTION_RESULTS].join(', ')}`);
    }
    const now = new Date().toISOString();
    const execution = {
      startedAt: one(flags, 'started-at', false) ?? '',
      endedAt: one(flags, 'ended-at', false) ?? now,
      durationMs: Number(one(flags, 'duration-ms', false) ?? 0),
      cacheHit: (one(flags, 'cache-hit', false) ?? 'true') === 'true',
      postconditionDurationMs: Number(one(flags, 'postcondition-duration-ms', false) ?? 0),
      status,
      reason: one(flags, 'reason', false) ?? '',
    };
    if (!Number.isFinite(execution.durationMs) || execution.durationMs < 0) {
      throw new Error('--duration-ms must be a non-negative number');
    }
    if (!Number.isFinite(execution.postconditionDurationMs) || execution.postconditionDurationMs < 0) {
      throw new Error('--postcondition-duration-ms must be a non-negative number');
    }
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
    candidate.lastExecution = execution;
    candidate.updatedAt = now;
    action.history ??= [];
    action.history.push({ candidateId: candidate.id, ...execution });
    action.history = action.history.slice(-20);
    action.updatedAt = now;
    variant.updatedAt = now;
    page.updatedAt = now;
    await atomicWriteJson(path, page);
    console.log(`Action result recorded: ${name} ${status}`);
    return;
  }

  if (command === 'action-result-batch') {
    const payload = await readProjectJson(one(flags, 'file'));
    if (!Array.isArray(payload.results) || payload.results.length === 0) {
      throw new Error('Batch file must contain a non-empty results array');
    }
    const loadedPages = new Map();
    const now = new Date().toISOString();
    for (const result of payload.results) {
      const pageId = safeName(result.page, 'page id');
      let loaded = loadedPages.get(pageId);
      if (!loaded) {
        loaded = await loadPage(paths, pageId);
        loadedPages.set(pageId, loaded);
      }
      const variant = getVariant(loaded.page, safeName(result.variant ?? 'default', 'variant id'));
      const actionName = safeName(result.name, 'action name');
      const action = variant.actions[actionName];
      if (!action) throw new Error(`Cached action not found: ${pageId}/${actionName}`);
      const candidate = action.candidates.find((item) => item.id === result.candidate);
      if (!candidate) throw new Error(`Action candidate not found: ${result.candidate}`);
      if (!ACTION_RESULTS.has(result.status)) throw new Error(`Invalid action status: ${result.status}`);
      const execution = {
        batchId: payload.batchId ?? '',
        startedAt: result.startedAt ?? '',
        endedAt: result.endedAt ?? now,
        durationMs: Number(result.durationMs ?? 0),
        cacheHit: result.cacheHit ?? true,
        postconditionDurationMs: Number(result.postconditionDurationMs ?? 0),
        status: result.status,
        reason: result.reason ?? '',
      };
      if (result.status === 'success') {
        candidate.successCount += 1;
        candidate.consecutiveFailures = 0;
        candidate.lastSuccessAt = execution.endedAt;
        delete candidate.lastFailureReason;
      } else {
        candidate.failureCount += 1;
        candidate.consecutiveFailures += 1;
        candidate.lastFailureAt = execution.endedAt;
        candidate.lastFailureReason = execution.reason;
      }
      candidate.lastExecution = execution;
      candidate.updatedAt = now;
      action.history ??= [];
      action.history.push({ candidateId: candidate.id, ...execution });
      action.history = action.history.slice(-20);
      action.updatedAt = now;
      variant.updatedAt = now;
      loaded.page.updatedAt = now;
    }
    await Promise.all([...loadedPages.values()].map(({ path, page }) => atomicWriteJson(path, page)));
    console.log(`Action results recorded: ${payload.results.length} in batch ${payload.batchId ?? 'unnamed'}`);
    return;
  }

  if (command === 'page-invalidate') {
    const { path, page } = await loadPage(paths, one(flags, 'page'));
    const variant = getVariant(page, variantId(flags));
    variant.invalidatedAt = new Date().toISOString();
    variant.invalidationReason = one(flags, 'reason');
    variant.updatedAt = variant.invalidatedAt;
    page.updatedAt = variant.invalidatedAt;
    await atomicWriteJson(path, page);
    console.log(`Page cache invalidated: ${page.id}/${variant.id}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
