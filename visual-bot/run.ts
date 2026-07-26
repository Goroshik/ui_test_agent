import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs, buildCommands, USAGE } from './steps.js';

// Thin shell on purpose: every decision lives in steps.ts, which is unit-tested.
// Keep this file free of function declarations so all logic stays testable.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const parsed = parseArgs(process.argv.slice(2));

if ('error' in parsed) {
  console.error(`${parsed.error}\n\n${USAGE}`);
  process.exit(1);
}

const commands = buildCommands(parsed);
console.log(`[run] ${parsed.steps.join(' → ')}  (${commands.length} command(s))`);

for (const command of commands) {
  console.log(`\n${'═'.repeat(60)}\n[run] ${command.label}\n${'═'.repeat(60)}`);

  const result = spawnSync(process.execPath, [tsx, resolve(repoRoot, command.script), ...command.args], {
    stdio: 'inherit',
    cwd: repoRoot,
    env: { ...process.env, ...command.env },
  });

  if (result.status !== 0) {
    console.error(`\n[run] FAILED at "${command.label}" (exit ${result.status}).`);
    console.error(`[run] Earlier steps are on disk — re-run from "${command.step}" once fixed.`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\n[run] Done: ${parsed.steps.join(' → ')}.`);
