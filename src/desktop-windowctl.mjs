#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { activateWindow } from './windows-window.mjs';

function parseArgs(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    if (!token?.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    flags[token.slice(2)] = value;
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const hwnd = Number(flags.hwnd);
  if (!Number.isInteger(hwnd) || hwnd <= 0) throw new Error('--hwnd must be a positive integer');
  const mode = flags.mode ?? 'restore';
  if (!['activate', 'restore'].includes(mode)) throw new Error('--mode must be activate or restore');
  const timeoutMs = Number(flags['timeout-ms'] ?? 3000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be positive');
  console.log(JSON.stringify(await activateWindow(hwnd, {
    restore: mode === 'restore',
    timeoutMs,
  }), null, 2));
}

const isEntryPoint = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}

