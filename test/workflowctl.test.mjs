import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const workflowctl = join(root, 'src', 'workflowctl.mjs');

function run(...args) {
  return execFileSync(process.execPath, [workflowctl, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runId(output) {
  const match = output.match(/Created workflow run: ([a-z0-9-]+)/);
  assert.ok(match, `Expected a run id in: ${output}`);
  return match[1];
}

async function removeRun(id) {
  const path = join(root, '.workflow-runs', id);
  if (existsSync(path)) await rm(path, { recursive: true, force: true });
}

test('generic workflow stores inputs, data, evidence, and review', async (t) => {
  const id = runId(run('init', '--workflow', 'example', '--summary', 'test', '--input', 'service=demo'));
  t.after(() => removeRun(id));
  run('phase', '--run', id, '--to', 'COLLECT');
  run('set', '--run', id, '--key', 'result.url', '--value', 'https://example.com');
  run('evidence', '--run', id, '--kind', 'page', '--value', 'https://example.com');
  const review = run('review', '--run', id);
  assert.match(review, /service: demo/);
  assert.match(review, /url: https:\/\/example\.com/);
});

test('change-request contract enforces ordered phases and submit confirmation gate', async (t) => {
  const id = runId(run('init', '--workflow', 'change-request', '--summary', 'test'));
  t.after(() => removeRun(id));
  assert.throws(() => run('phase', '--run', id, '--to', 'REVIEW'), /Contract requires phase BUILD/);

  for (const [key, value] of Object.entries({
    'build.number': '1', 'build.url': 'https://build', 'build.image': 'registry/image:1',
    'reports.sonar.status': 'passed', 'reports.foss.status': 'passed',
    'cr.id': 'CR-1', 'cr.url': 'https://cr/1', 'pipeline.status': 'created',
  })) run('set', '--run', id, '--key', key, '--value', value);
  for (const kind of ['build', 'sonar', 'foss', 'cr', 'pipeline']) run('evidence', '--run', id, '--kind', kind, '--value', `https://evidence/${kind}`);
  for (const phase of ['BUILD', 'COLLECT_ARTIFACTS', 'CREATE_CR_DRAFT', 'FILL_CR', 'CREATE_PIPELINE', 'REVIEW', 'WAIT_FOR_CONFIRMATION']) {
    run('phase', '--run', id, '--to', phase);
  }
  assert.throws(() => run('phase', '--run', id, '--to', 'SUBMIT'), /requires confirmation/);
  run('confirm', '--run', id, '--action', 'submit', '--by', 'test-user');
  assert.match(run('phase', '--run', id, '--to', 'SUBMIT'), /Phase: SUBMIT/);
});

test('secret helper fails before browser launch when its environment variable is missing', () => {
  const helper = join(root, 'src', 'browser', 'fill-secret.mjs');
  const result = spawnSync(process.execPath, [helper, '--env', 'MISSING_SECRET', '--session', 'test', '--ref', 'e1'], { cwd: root, encoding: 'utf8', env: { ...process.env, MISSING_SECRET: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MISSING_SECRET is not set/);
});

test('bilibili contract preserves the manual-verification checkpoint', async (t) => {
  const id = runId(run('init', '--workflow', 'bilibili-video-metrics', '--summary', 'test'));
  t.after(() => removeRun(id));
  run('phase', '--run', id, '--to', 'LOGIN');
  assert.throws(() => run('phase', '--run', id, '--to', 'SEARCH'), /Contract requires phase WAIT_FOR_USER_VERIFICATION/);
  assert.match(run('phase', '--run', id, '--to', 'WAIT_FOR_USER_VERIFICATION'), /Phase: WAIT_FOR_USER_VERIFICATION/);
  assert.match(run('pause', '--run', id, '--reason', 'waiting for SMS'), /Waiting at WAIT_FOR_USER_VERIFICATION/);
  assert.throws(() => run('phase', '--run', id, '--to', 'SEARCH'), /Run is waiting/);
  assert.match(run('resume', '--run', id), /Resumed at WAIT_FOR_USER_VERIFICATION/);
  assert.equal(run('latest', '--workflow', 'bilibili-video-metrics').trim(), id);
});

test('official Playwright CLI Skill is installed and business Skills stay business-focused', () => {
  const officialSkill = join(root, '.agents', 'skills', 'playwright-cli', 'SKILL.md');
  assert.equal(existsSync(officialSkill), true);
  const bilibiliSkill = readFileSync(join(root, 'skills', 'bilibili-video-metrics', 'SKILL.md'), 'utf8');
  const crSkill = readFileSync(join(root, 'skills', 'cr-automation', 'SKILL.md'), 'utf8');
  assert.match(bilibiliSkill, /common project runtime/);
  assert.match(bilibiliSkill, /requested by the user; default to rank 1/);
  assert.match(crSkill, /common project runtime/);
  assert.doesNotMatch(bilibiliSkill, /## Operating loop/);
  assert.doesNotMatch(crSkill, /## Browser operating loop/);
  assert.doesNotMatch(bilibiliSkill, /pnpm browser:fill-secret/);
  assert.doesNotMatch(bilibiliSkill, /pnpm output/);
});
