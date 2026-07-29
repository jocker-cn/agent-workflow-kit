#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  atomicWriteJson,
  ensurePromptCache,
  normalizeDefinition,
  readJson,
  resolvePromptSelection,
  routeSignature,
} from './cache-store.mjs';

const NODE_TYPES = new Set(['browser', 'decision', 'human', 'report']);
const BARRIERS = new Set(['none', 'human', 'decision', 'risk', 'context']);
const RISKS = new Set(['read', 'reversible', 'irreversible']);
const AUTHORIZATION_MODES = new Set(['not-required', 'prompt', 'runtime']);

function usage(exitCode = 0) {
  console.log(`
Compile an Agent-produced workflow intent into an optimized cached Workflow Recipe.

Usage:
  pnpm compile -- --file <project-relative-json>
                  [--prompt <file> | --prompt-key <key>] [--dry-run true]

The input is an internal compiler artifact, not a user-authored configuration file. It contains
descriptive workflow metadata, fact sources, hard constraints, and candidate page transactions.
The compiler orders by data dependencies, prefers transactions with the same page affinity, and
fuses compatible same-page work. Prompt sentence order is only a soft hint.
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

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeAssertions(values = [], label = 'asserts') {
  return values.map((assertion, index) => {
    if (!assertion?.key || assertion.value === undefined) {
      throw new Error(`${label}[${index}] requires key and value`);
    }
    return {
      key: assertion.key,
      value: assertion.value,
      description: assertion.description?.trim() ?? '',
    };
  });
}

function normalizeComputations(values = [], label = 'computes') {
  return values.map((computation, index) => {
    if (!computation?.key || !computation.op) {
      throw new Error(`${label}[${index}] requires key and op`);
    }
    const target = computation.target ?? 'fact';
    if (!['fact', 'output'].includes(target)) {
      throw new Error(`${label}[${index}].target must be fact or output`);
    }
    return {
      ...structuredClone(computation),
      key: computation.key,
      op: computation.op,
      target,
      description: computation.description?.trim() ?? '',
    };
  });
}

function affinityKey(affinity = {}) {
  return [
    affinity.system ?? '',
    affinity.page ?? '',
    affinity.state ?? '',
    affinity.tab ?? 'main',
    affinity.variant ?? 'default',
  ].join('\0');
}

function normalizeAuthorization(raw, { id, risk, requestedBarrier }) {
  const source = typeof raw === 'string' ? { mode: raw } : raw;
  let mode = source?.mode;
  if (!mode) {
    if (requestedBarrier === 'risk' || (requestedBarrier === 'human' && risk !== 'read')) mode = 'runtime';
    else if (risk === 'read') mode = 'not-required';
    else if (risk === 'reversible') mode = 'prompt';
    else throw new Error(
      `Irreversible transaction ${id} must declare authorization.mode as prompt or runtime`,
    );
  }
  if (!AUTHORIZATION_MODES.has(mode)) {
    throw new Error(`Unsupported authorization mode: ${mode}`);
  }
  if (risk === 'irreversible' && mode === 'not-required') {
    throw new Error(`Irreversible transaction ${id} cannot use authorization.mode not-required`);
  }
  const count = source?.count;
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
    throw new Error(`${id}.authorization.count must be a positive integer`);
  }
  const maxCount = source?.maxCount;
  if (maxCount !== undefined && (!Number.isInteger(maxCount) || maxCount < 1)) {
    throw new Error(`${id}.authorization.maxCount must be a positive integer`);
  }
  return {
    mode,
    scope: source?.scope?.trim() || id,
    count: count ?? null,
    countFrom: source?.countFrom?.trim() || '',
    maxCount: maxCount ?? null,
    constraints: unique(source?.constraints),
  };
}

function normalizeTransaction(raw, index) {
  const id = safeName(raw.id, `transactions[${index}].id`);
  const type = raw.type ?? 'browser';
  const risk = raw.risk ?? 'read';
  if (!NODE_TYPES.has(type)) throw new Error(`Unsupported transaction type: ${type}`);
  if (!RISKS.has(risk)) throw new Error(`Unsupported risk: ${risk}`);
  const authorization = normalizeAuthorization(raw.authorization, {
    id,
    risk,
    requestedBarrier: raw.barrier ?? (type === 'human' ? 'human' : undefined),
  });
  const barrier = raw.barrier ?? (
    type === 'human'
      ? 'human'
      : authorization.mode === 'runtime'
        ? 'risk'
        : type === 'decision'
          ? 'decision'
          : 'none'
  );
  if (!BARRIERS.has(barrier)) throw new Error(`Unsupported barrier: ${barrier}`);
  if (authorization.mode === 'runtime' && !['risk', 'human'].includes(barrier)) {
    throw new Error(`Runtime authorization for ${id} requires a risk or human barrier`);
  }
  if (authorization.mode === 'prompt' && barrier === 'risk') {
    throw new Error(`Prompt-authorized transaction ${id} cannot also declare a risk barrier`);
  }
  return {
    id,
    title: raw.title?.trim() || id,
    description: raw.description?.trim() || raw.businessGoal?.trim() || raw.title?.trim() || id,
    type,
    affinity: {
      system: raw.affinity?.system ?? '',
      page: raw.affinity?.page ?? '',
      state: raw.affinity?.state ?? '',
      tab: raw.affinity?.tab ?? 'main',
      variant: raw.affinity?.variant ?? 'default',
    },
    requires: unique(raw.requires),
    produces: unique(raw.produces),
    collects: unique(raw.collects),
    asserts: normalizeAssertions(raw.asserts, `${id}.asserts`),
    computes: normalizeComputations(raw.computes, `${id}.computes`),
    after: unique(raw.after).map((value) => safeName(value, `${id}.after`)),
    barrier,
    risk,
    authorization,
    operations: (raw.operations ?? []).map((operation, operationIndex) => ({
      id: safeName(operation.id ?? `operation-${operationIndex + 1}`, `${id}.operations.id`),
      kind: operation.kind ?? 'interact',
      description: operation.description?.trim() || operation.id || `Operation ${operationIndex + 1}`,
      reads: unique(operation.reads),
      writes: unique(operation.writes),
    })),
    dependsOn: unique(raw.dependsOn),
    routes: Array.isArray(raw.routes) ? raw.routes : [],
    sourceNodeIds: [id],
    sourceOrder: index,
  };
}

function addDependency(dependencies, nodeId, dependencyId, reason) {
  if (nodeId === dependencyId) return;
  const item = dependencies.get(nodeId);
  if (!item) throw new Error(`Unknown transaction in dependency: ${nodeId}`);
  if (!dependencies.has(dependencyId)) throw new Error(`Unknown dependency transaction: ${dependencyId}`);
  item.set(dependencyId, reason);
}

function dependencyGraph(transactions, constraints = []) {
  const dependencies = new Map(transactions.map((node) => [node.id, new Map()]));
  const producers = new Map();
  for (const node of transactions) {
    for (const fact of node.produces) {
      if (producers.has(fact)) {
        throw new Error(`Fact ${fact} is produced by both ${producers.get(fact)} and ${node.id}`);
      }
      producers.set(fact, node.id);
    }
  }
  for (const node of transactions) {
    for (const after of node.after) addDependency(dependencies, node.id, after, 'explicit-after');
    for (const fact of node.requires) {
      if (producers.has(fact)) addDependency(dependencies, node.id, producers.get(fact), `fact:${fact}`);
    }
  }
  for (const constraint of constraints) {
    const before = safeName(constraint.before, 'constraint.before');
    const after = safeName(constraint.after, 'constraint.after');
    addDependency(dependencies, after, before, constraint.reason ?? 'hard-constraint');
  }
  return dependencies;
}

function scheduleTransactions(transactions, dependencies) {
  const remaining = new Map(transactions.map((node) => [node.id, node]));
  const completed = new Set();
  const ordered = [];
  let preferredAffinity = '';
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((node) => (
      [...dependencies.get(node.id).keys()].every((dependency) => completed.has(dependency))
    ));
    if (ready.length === 0) {
      const cycle = [...remaining.keys()].map((id) => ({
        id,
        waitingFor: [...dependencies.get(id).keys()].filter((dependency) => !completed.has(dependency)),
      }));
      throw new Error(`Workflow dependencies contain a cycle: ${JSON.stringify(cycle)}`);
    }
    ready.sort((left, right) => {
      const leftAffinity = affinityKey(left.affinity) === preferredAffinity ? 0 : 1;
      const rightAffinity = affinityKey(right.affinity) === preferredAffinity ? 0 : 1;
      return leftAffinity - rightAffinity || left.sourceOrder - right.sourceOrder;
    });
    const selected = ready[0];
    ordered.push(selected);
    completed.add(selected.id);
    remaining.delete(selected.id);
    preferredAffinity = selected.barrier === 'none' ? affinityKey(selected.affinity) : '';
  }
  return ordered;
}

function canFuse(left, right) {
  return left.type === 'browser'
    && right.type === 'browser'
    && left.barrier === 'none'
    && right.barrier === 'none'
    && left.risk !== 'irreversible'
    && right.risk !== 'irreversible'
    && left.authorization.mode === right.authorization.mode
    && (
      left.authorization.mode === 'not-required'
      || JSON.stringify(left.authorization) === JSON.stringify(right.authorization)
    )
    && left.routes.length === 0
    && right.routes.length === 0
    && affinityKey(left.affinity) === affinityKey(right.affinity);
}

function fuseTransactions(ordered) {
  const fused = [];
  for (const node of ordered) {
    const previous = fused.at(-1);
    if (!previous || !canFuse(previous, node)) {
      fused.push(structuredClone(node));
      continue;
    }
    previous.title = `${previous.title}；${node.title}`;
    previous.description = `${previous.description}\n${node.description}`;
    previous.operations.push(...node.operations);
    previous.sourceNodeIds.push(...node.sourceNodeIds);
    previous.produces = unique([...previous.produces, ...node.produces]);
    previous.collects = unique([...previous.collects, ...node.collects]);
    previous.asserts.push(...node.asserts);
    previous.computes.push(...node.computes);
    const producedInside = new Set(previous.produces);
    previous.requires = unique([...previous.requires, ...node.requires])
      .filter((fact) => !producedInside.has(fact));
    previous.dependsOn = unique([...previous.dependsOn, ...node.dependsOn]);
    previous.after = unique([...previous.after, ...node.after])
      .filter((id) => !previous.sourceNodeIds.includes(id));
  }
  return fused;
}

function canonicalizeFusedReferences(nodes) {
  const canonicalBySource = new Map();
  for (const node of nodes) {
    for (const sourceId of node.sourceNodeIds) canonicalBySource.set(sourceId, node.id);
  }
  for (const node of nodes) {
    node.after = unique(node.after.map((id) => canonicalBySource.get(id) ?? id))
      .filter((id) => id !== node.id);
  }
  return nodes;
}

export function compileWorkflowSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Compiler input must be a JSON object');
  if (!Array.isArray(spec.transactions) || spec.transactions.length === 0) {
    throw new Error('Compiler input requires a non-empty transactions array');
  }
  const transactions = spec.transactions.map(normalizeTransaction);
  const ids = new Set();
  for (const transaction of transactions) {
    if (ids.has(transaction.id)) throw new Error(`Duplicate transaction id: ${transaction.id}`);
    ids.add(transaction.id);
  }
  const dependencies = dependencyGraph(transactions, spec.constraints ?? []);
  const ordered = scheduleTransactions(transactions, dependencies);
  const nodes = canonicalizeFusedReferences(fuseTransactions(ordered)).map((node, index) => ({
    id: node.id,
    title: node.title,
    description: node.description,
    type: node.type,
    affinity: node.affinity,
    requires: node.requires,
    produces: node.produces,
    collects: node.collects,
    asserts: node.asserts,
    computes: node.computes,
    dependsOn: node.dependsOn,
    after: node.after,
    barrier: node.barrier,
    risk: node.risk,
    authorization: node.authorization,
    operations: node.operations,
    sourceNodeIds: node.sourceNodeIds,
    executionOrder: index,
    routes: node.routes,
  }));
  const validationWarnings = nodes.flatMap((node) => {
    const supplied = new Set([
      ...node.collects,
      ...node.asserts.map((assertion) => assertion.key),
      ...node.computes.filter((computation) => computation.target === 'fact').map((computation) => computation.key),
    ]);
    const missing = node.produces.filter((key) => !supplied.has(key));
    return missing.length === 0 ? [] : [{
      nodeId: node.id,
      reason: 'Declared produced facts have no collect, assert, or compute source',
      facts: missing,
    }];
  });
  return {
    workflow: {
      name: spec.workflow?.name ?? '',
      summary: spec.workflow?.summary ?? '',
      description: spec.workflow?.description ?? '',
    },
    inputs: spec.inputs ?? [],
    facts: spec.facts ?? [],
    outputs: spec.outputs ?? [],
    policies: spec.policies ?? [],
    constraints: spec.constraints ?? [],
    nodes,
    validationWarnings,
    optimization: {
      sourceTransactionCount: transactions.length,
      executableTransactionCount: nodes.length,
      fusedTransactionCount: transactions.length - nodes.length,
      strategy: 'dependency-order-page-affinity-fusion',
    },
  };
}

function routeSetBySignature(node) {
  const routes = (node?.routes ?? []).filter((route) => route.status !== 'disabled');
  return new Map(routes.map((route) => [route.signature ?? routeSignature(route.when ?? {}), route]));
}

function migrateRoutes(node, previousNodes) {
  const sources = node.sourceNodeIds
    .map((id) => previousNodes.get(id))
    .filter(Boolean);
  if (sources.length === 0) return { routes: [], warning: null, createdAt: null };
  if (sources.length === 1) {
    return {
      routes: structuredClone(sources[0].routes ?? []),
      warning: null,
      createdAt: sources[0].createdAt ?? null,
    };
  }
  const routeSets = sources.map(routeSetBySignature);
  const signatures = [...routeSets[0].keys()];
  const compatible = signatures.length > 0
    && routeSets.every((routes) => (
      routes.size === signatures.length && signatures.every((signature) => routes.has(signature))
    ));
  if (!compatible) {
    return {
      routes: [],
      warning: {
        nodeId: node.id,
        sourceNodeIds: node.sourceNodeIds,
        reason: 'Fused source nodes have incompatible learned route guards; relearning is required',
      },
      createdAt: sources.map((source) => source.createdAt).filter(Boolean).sort()[0] ?? null,
    };
  }
  const routes = signatures.map((signature) => {
    const parts = routeSets.map((routesForNode) => routesForNode.get(signature));
    const finalRoute = parts.at(-1);
    const actions = [];
    const actionKeys = new Set();
    for (const part of parts) {
      for (const action of part.actions ?? []) {
        const key = `${action.page}@${action.variant ?? 'default'}/${action.action}`;
        if (!actionKeys.has(key)) {
          actions.push(structuredClone(action));
          actionKeys.add(key);
        }
      }
    }
    return {
      ...structuredClone(parts[0]),
      id: parts[0].id,
      status: parts.every((part) => part.status === 'learned') ? 'learned' : 'unlearned',
      actions,
      postcondition: finalRoute.postcondition ?? '',
      expectation: finalRoute.expectation ?? null,
      transitionTimeoutMs: Math.max(...parts.map((part) => part.transitionTimeoutMs ?? 10000)),
      createdAt: parts.map((part) => part.createdAt).filter(Boolean).sort()[0] ?? finalRoute.createdAt,
      updatedAt: new Date().toISOString(),
    };
  });
  return {
    routes,
    warning: null,
    createdAt: sources.map((source) => source.createdAt).filter(Boolean).sort()[0] ?? null,
  };
}

async function readProjectJson(file) {
  const absolute = resolve(ROOT, file);
  const pathFromRoot = relative(ROOT, absolute);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error('--file must be inside the project');
  }
  return JSON.parse(await readFile(absolute, 'utf8'));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) usage();
  const file = one(flags, 'file');
  if (!existsSync(resolve(ROOT, file))) throw new Error(`Compiler input not found: ${file}`);
  const identity = await resolvePromptSelection({
    prompt: one(flags, 'prompt', false),
    promptKey: one(flags, 'prompt-key', false),
  });
  const paths = await ensurePromptCache(identity);
  const compiled = compileWorkflowSpec(await readProjectJson(file));
  if ((one(flags, 'dry-run', false) ?? 'false') === 'true') {
    console.log(JSON.stringify({ prompt: identity, compiled }, null, 2));
    return;
  }
  const definition = normalizeDefinition(await readJson(paths.definitionPath));
  const now = new Date().toISOString();
  const previousNodes = new Map(definition.compiled.nodes.map((node) => [node.id, node]));
  const migrationWarnings = [];
  compiled.nodes = compiled.nodes.map((node) => {
    const migration = migrateRoutes(node, previousNodes);
    if (migration.warning) migrationWarnings.push(migration.warning);
    return {
      ...node,
      routes: node.routes.length > 0 ? node.routes : migration.routes,
      createdAt: migration.createdAt ?? now,
      updatedAt: now,
    };
  });
  compiled.migrationWarnings = migrationWarnings;
  definition.schemaVersion = 5;
  definition.compiled = {
    ...definition.compiled,
    ...compiled,
    version: (definition.compiled.version ?? 0) + 1,
  };
  definition.updatedAt = now;
  await atomicWriteJson(paths.definitionPath, definition);
  console.log(JSON.stringify({
    status: 'compiled',
    prompt: identity,
    recipeVersion: definition.compiled.version,
    optimization: compiled.optimization,
    validationWarnings: compiled.validationWarnings,
    migrationWarnings,
    nodes: compiled.nodes.map(({
      id, title, affinity, requires, produces, barrier, risk, authorization, sourceNodeIds,
    }) => ({
      id,
      title,
      affinity,
      requires,
      produces,
      barrier,
      risk,
      authorization,
      sourceNodeIds,
    })),
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
