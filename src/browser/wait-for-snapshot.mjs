#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith('--')) throw new Error(`Unexpected argument: ${option}`);
    const key = option.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    (result[key] ??= []).push(value);
    index += 1;
  }
  return result;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `Playwright CLI exited with ${code}`)));
  });
}

try {
  if (process.argv.slice(2).includes('--help')) {
    console.log('Usage: pnpm browser:wait --session <session> --present <text> [--present <text>] [--absent <text>] [--timeout-ms <milliseconds>] [--interval-ms <milliseconds>]');
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));
  const session = args.session?.[0];
  const present = args.present ?? [];
  const absent = args.absent ?? [];
  const timeoutMs = Number(args['timeout-ms']?.[0] ?? 600000);
  const intervalMs = Number(args['interval-ms']?.[0] ?? 3000);
  if (!session) throw new Error('--session is required');
  if (present.length === 0) throw new Error('At least one --present text is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be at least 1000');
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new Error('--interval-ms must be at least 250');

  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const cliEntry = join(root, 'node_modules', '@playwright', 'cli', 'playwright-cli.js');
  const deadline = Date.now() + timeoutMs;
  process.stdout.write('Waiting for the browser state to change. Complete any required user step in the visible browser.\n');

  while (Date.now() < deadline) {
    const snapshot = await run(process.execPath, [cliEntry, `-s=${session}`, 'snapshot', '--raw']);
    if (present.every((text) => snapshot.includes(text)) && absent.every((text) => !snapshot.includes(text))) {
      console.log('Expected browser state detected.');
      process.exitCode = 0;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (process.exitCode !== 0) throw new Error('Timed out waiting for the expected browser state');
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
