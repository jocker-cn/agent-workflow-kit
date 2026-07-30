import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const ROOT = resolve(process.cwd());
export const CACHE_ROOT = join(ROOT, '.workflow-cache');
const PROMPTS_ROOT = join(ROOT, '.github', 'prompts');
const ALLOWED_CACHE_FILES = [
  /^definitions\/prompt-[a-f0-9]{12}\/[a-f0-9]{16}\.json$/,
  /^pages\/prompt-[a-f0-9]{12}\/shared\/[a-z][a-z0-9-]*\.json$/,
];
const ALLOWED_CACHE_DIRECTORIES = [
  /^definitions$/,
  /^definitions\/prompt-[a-f0-9]{12}$/,
  /^pages$/,
  /^pages\/prompt-[a-f0-9]{12}$/,
  /^pages\/prompt-[a-f0-9]{12}\/shared$/,
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function portablePath(value) {
  return value.split(sep).join('/');
}

export async function cacheHygieneViolations(directory = CACHE_ROOT) {
  if (!existsSync(directory)) return [];
  const violations = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const path = join(current, entry.name);
      const cacheRelative = portablePath(relative(CACHE_ROOT, path));
      if (entry.isDirectory()) {
        if (ALLOWED_CACHE_DIRECTORIES.some((pattern) => pattern.test(cacheRelative))) {
          await visit(path);
        } else {
          violations.push(portablePath(relative(ROOT, path)));
        }
      } else if (entry.isFile()) {
        if (!ALLOWED_CACHE_FILES.some((pattern) => pattern.test(cacheRelative))) {
          violations.push(portablePath(relative(ROOT, path)));
        }
      } else {
        violations.push(portablePath(relative(ROOT, path)));
      }
    }));
  };
  await visit(directory);
  return violations.sort();
}

export async function assertCacheHygiene() {
  const violations = await cacheHygieneViolations();
  if (violations.length > 0) {
    throw new Error(
      `.workflow-cache contains non-canonical files: ${violations.join(', ')}`,
    );
  }
}

export async function resolvePromptIdentity(promptFile) {
  if (!promptFile) throw new Error('--prompt is required');
  const absolutePath = resolve(ROOT, promptFile);
  const relativeToPrompts = relative(PROMPTS_ROOT, absolutePath);
  if (relativeToPrompts.startsWith('..') || isAbsolute(relativeToPrompts)) {
    throw new Error('Prompt files must be inside .github/prompts');
  }
  if (!absolutePath.endsWith('.prompt.md')) {
    throw new Error('Prompt files must use the .prompt.md extension');
  }
  if (!existsSync(absolutePath)) throw new Error(`Prompt file not found: ${promptFile}`);

  const content = await readFile(absolutePath, 'utf8');
  const relativePath = portablePath(relative(ROOT, absolutePath));
  const promptKey = `prompt-${sha256(portablePath(relativeToPrompts)).slice(0, 12)}`;
  const promptHash = sha256(content).slice(0, 16);
  return {
    id: basename(absolutePath, '.prompt.md'),
    path: relativePath,
    key: promptKey,
    hash: promptHash,
    scope: `${promptKey}/${promptHash}`,
  };
}

async function promptFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return promptFiles(path);
    return entry.isFile() && entry.name.endsWith('.prompt.md') ? [path] : [];
  }));
  return nested.flat();
}

export async function listPromptIdentities() {
  const files = await promptFiles(PROMPTS_ROOT);
  return Promise.all(files.sort().map(resolvePromptIdentity));
}

export async function resolvePromptSelection({ prompt, promptKey } = {}) {
  if (prompt && promptKey) throw new Error('Use either --prompt or --prompt-key, not both');
  if (prompt) return resolvePromptIdentity(prompt);
  const identities = await listPromptIdentities();
  if (promptKey) {
    const identity = identities.find((item) => item.key === promptKey);
    if (!identity) throw new Error(`Prompt key not found: ${promptKey}`);
    return identity;
  }
  if (identities.length === 1) return identities[0];
  if (identities.length === 0) throw new Error('No Prompt files found in .github/prompts');
  throw new Error('Multiple Prompt files found; use --prompt-key from cachectl list');
}

export function cachePaths(identity) {
  return {
    definitionPath: join(CACHE_ROOT, 'definitions', identity.key, `${identity.hash}.json`),
    pagesDir: join(CACHE_ROOT, 'pages', identity.key, 'shared'),
    legacyPagesDir: join(CACHE_ROOT, 'pages', identity.key, identity.hash),
  };
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function ensurePromptCache(identity) {
  const paths = cachePaths(identity);
  await mkdir(paths.pagesDir, { recursive: true });
  if (existsSync(paths.legacyPagesDir)) {
    const legacyPages = (await readdir(paths.legacyPagesDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    await Promise.all(legacyPages.map(async (entry) => {
      const destination = join(paths.pagesDir, entry.name);
      if (!existsSync(destination)) {
        await copyFile(join(paths.legacyPagesDir, entry.name), destination);
      }
    }));
  }
  if (!existsSync(paths.definitionPath)) {
    const now = new Date().toISOString();
    await atomicWriteJson(paths.definitionPath, {
      schemaVersion: 7,
      prompt: identity,
      compiled: {
        version: 1,
        workflow: {
          name: '',
          summary: '',
          description: '',
        },
        inputs: [],
        facts: [],
        outputs: [],
        policies: [],
        constraints: [],
        nodes: [],
        steps: [],
        branches: [],
      },
      createdAt: now,
      updatedAt: now,
    });
  }
  return paths;
}

export function cacheDisplayPaths(paths) {
  return {
    definition: portablePath(relative(ROOT, paths.definitionPath)),
    pages: portablePath(relative(ROOT, paths.pagesDir)),
  };
}

export function candidateId(strategy, target) {
  return `candidate-${sha256(`${strategy}\0${target}`).slice(0, 12)}`;
}

export function routeSignature(when = {}) {
  const entries = Object.entries(when)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  return entries.length === 0 ? 'default' : entries.join(';');
}

export function normalizeDefinition(definition) {
  definition.schemaVersion ??= 1;
  definition.compiled ??= {};
  definition.compiled.version ??= 1;
  definition.compiled.workflow ??= {
    name: '',
    summary: '',
    description: '',
  };
  definition.compiled.inputs ??= [];
  definition.compiled.facts ??= [];
  definition.compiled.outputs ??= [];
  definition.compiled.policies ??= [];
  definition.compiled.constraints ??= [];
  definition.compiled.nodes ??= [];
  definition.compiled.steps ??= [];
  definition.compiled.branches ??= [];
  return definition;
}

function nestedValue(values, dottedKey) {
  return dottedKey.split('.').reduce((current, part) => current?.[part], values);
}

function normalizedScalar(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return value;
}

export function resolveWorkflowRecipe(definition, values = {}, onlyNode = null) {
  const resolved = [];
  const pending = [];
  const unknown = [];
  const ambiguous = [];
  for (const node of normalizeDefinition(definition).compiled.nodes) {
    if (onlyNode && node.id !== onlyNode) continue;
    node.requires ??= [];
    node.produces ??= [];
    node.collects ??= [];
    node.asserts ??= [];
    node.computes ??= [];
    node.authorization ??= {
      mode: node.barrier === 'risk' ? 'runtime' : node.risk === 'read' ? 'not-required' : 'prompt',
      scope: node.id,
      count: null,
      countFrom: '',
      maxCount: null,
      constraints: [],
    };
    node.iteration ??= null;
    node.dependsOn ??= [];
    node.routes ??= [];
    const enabled = node.routes.filter((route) => route.status !== 'disabled');
    const conditional = enabled.filter((route) => Object.keys(route.when).length > 0);
    const candidates = (conditional.length > 0 ? conditional : enabled)
      .filter((route) => Object.entries(route.when)
        .every(([key, expected]) => normalizedScalar(nestedValue(values, key)) === normalizedScalar(expected)))
      .sort((left, right) => Object.keys(right.when).length - Object.keys(left.when).length);
    const missingRouteFacts = conditional.length > 0
      ? node.dependsOn.filter((key) => nestedValue(values, key) === undefined)
      : [];
    const missingRequirements = node.requires
      .filter((key) => nestedValue(values, key) === undefined);
    const missing = [...new Set([...missingRouteFacts, ...missingRequirements])];
    if (missing.length > 0) {
      pending.push({
        nodeId: node.id,
        dependsOn: node.dependsOn,
        requires: node.requires,
        missing,
      });
      continue;
    }
    if (candidates.length === 0) {
      unknown.push({
        nodeId: node.id,
        dependsOn: node.dependsOn,
        observed: Object.fromEntries(node.dependsOn.map((key) => [key, nestedValue(values, key)])),
      });
      continue;
    }
    const specificity = Object.keys(candidates[0].when).length;
    const equallySpecific = candidates.filter((route) => Object.keys(route.when).length === specificity);
    if (equallySpecific.length > 1) {
      ambiguous.push({ nodeId: node.id, routes: equallySpecific.map((route) => route.id) });
      continue;
    }
    const route = candidates[0];
    if (route.status === 'unlearned') {
      unknown.push({
        nodeId: node.id,
        routeId: route.id,
        routeSignature: route.signature,
        reason: 'route-unlearned',
      });
      continue;
    }
    resolved.push({
      nodeId: node.id,
      title: node.title,
      description: node.description ?? '',
      type: node.type,
      affinity: node.affinity ?? {},
      requires: node.requires,
      produces: node.produces,
      collects: node.collects,
      asserts: node.asserts,
      computes: node.computes,
      barrier: node.barrier ?? 'none',
      risk: node.risk ?? 'read',
      authorization: node.authorization,
      iteration: node.iteration,
      routeId: route.id,
      routeSignature: route.signature,
      actions: route.actions,
      postcondition: route.postcondition,
      expectation: route.expectation ?? null,
      transitionTimeoutMs: route.transitionTimeoutMs ?? 10000,
    });
  }
  return {
    status: ambiguous.length > 0
      ? 'ambiguous'
      : unknown.length > 0
        ? 'needs-learning'
        : pending.length > 0
          ? 'needs-facts'
          : 'ready',
    resolved,
    pending,
    unknown,
    ambiguous,
  };
}
