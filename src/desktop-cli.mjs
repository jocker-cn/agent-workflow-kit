#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './cache-store.mjs';

const WINAPP_CLI = resolve(
  ROOT,
  'node_modules',
  '@microsoft',
  'winappcli',
  'dist',
  'cli.js',
);

export function validateDesktopCliArgs(args) {
  const command = args[0] ?? '';
  if (command === 'screenshot' && args.includes('--focus')) {
    throw new Error('Do not use screenshot --focus for window activation; use pnpm desktop:window');
  }
  if (!['screenshot', 'record'].includes(command)) return;
  const outputIndex = args.indexOf('--output');
  if (outputIndex < 0 || !args[outputIndex + 1]) return;
  const output = resolve(ROOT, args[outputIndex + 1]);
  const runsRoot = resolve(ROOT, '.workflow-runs');
  const fromRuns = relative(runsRoot, output).replaceAll('\\', '/');
  if (fromRuns.startsWith('..') || isAbsolute(fromRuns)) return;
  if (!/^[a-z0-9-]+\/(?:evidence|diagnostics)\/[a-z][a-z0-9-]+\/.+\.(?:png|mp4)$/i.test(fromRuns)) {
    throw new Error(
      'Desktop screenshots and recordings inside a run must be under '
      + '.workflow-runs/<run-id>/evidence/<transaction-id>/ or diagnostics/<transaction-id>/',
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  validateDesktopCliArgs(args);
  const child = spawn(process.execPath, [WINAPP_CLI, 'ui', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

const isEntryPoint = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}

