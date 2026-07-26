import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const ROOT = resolve(process.cwd());
export const CACHE_ROOT = join(ROOT, '.workflow-cache');
const PROMPTS_ROOT = join(ROOT, '.github', 'prompts');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function portablePath(value) {
  return value.split(sep).join('/');
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
    pagesDir: join(CACHE_ROOT, 'pages', identity.key, identity.hash),
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
  if (!existsSync(paths.definitionPath)) {
    const now = new Date().toISOString();
    await atomicWriteJson(paths.definitionPath, {
      schemaVersion: 1,
      prompt: identity,
      compiled: {
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
