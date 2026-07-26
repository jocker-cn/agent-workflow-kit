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
    result[key] = value;
    index += 1;
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const envName = args.env;
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName ?? '')) {
    throw new Error('--env must name an uppercase environment variable');
  }
  if (!args.session) throw new Error('--session is required');
  if (!args.ref) throw new Error('--ref is required');

  const secret = process.env[envName];
  if (!secret) throw new Error(`${envName} is not set in the current process environment`);

  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const cliEntry = join(root, 'node_modules', '@playwright', 'cli', 'playwright-cli.js');
  const child = spawn(process.execPath, [cliEntry, `-s=${args.session}`, 'fill', args.ref, secret], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  const redact = (chunk) => chunk.toString().split(secret).join('[REDACTED]');
  child.stdout.on('data', (chunk) => process.stdout.write(redact(chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(redact(chunk)));

  child.on('error', (error) => {
    console.error(`Unable to run Playwright CLI: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
