// Quality gate runner: typecheck -> lint -> coverage -> CRAP -> mutation.
// Runs every step in order and STOPS at the first failure with a non-zero exit
// code (2, so it also blocks the Claude Code Stop hook). Never weaken a step to
// make this pass — fix the code or the tests.
const { spawnSync } = require('child_process');
const path = require('path');

// Always run from the project root, regardless of the caller's cwd (hooks may
// fire from a parent workspace directory).
process.chdir(path.resolve(__dirname, '..'));

const node = process.execPath;

const steps = [
  ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['lint', ['node_modules/eslint/bin/eslint.js', 'visual-bot']],
  ['coverage', ['node_modules/vitest/vitest.mjs', 'run', '--coverage']],
  [
    'crap:normalize',
    [
      'scripts/normalize-coverage-paths.cjs',
      'coverage/coverage-final.json',
      'coverage/coverage-final.norm.json',
    ],
  ],
  ['crap', ['node_modules/crap4ts/dist/cli.js', '-c', 'coverage/coverage-final.norm.json']],
  ['mutation', ['node_modules/@stryker-mutator/core/bin/stryker.js', 'run']],
];

for (const [name, args] of steps) {
  console.log(`\n=== gate: ${name} ===`);
  const result = spawnSync(node, args, { stdio: 'inherit' });

  if (result.status !== 0) {
    console.error(`\n[gate] FAILED at "${name}" (exit ${result.status}).`);
    console.error(
      '[gate] Fix the code or the tests. Do NOT lower thresholds, add eslint-disable/@ts-ignore, or skip tests.',
    );
    process.exit(2);
  }
}

console.log('\n[gate] OK - all checks passed.');
