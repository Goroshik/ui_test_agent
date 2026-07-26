// Fast PostToolUse gate: after a .ts file under visual-bot/ is edited, run
// typecheck + lint on it. Exits 2 (blocking) with details on stderr so the agent
// must fix the issue rather than move on. Skips silently for non-source edits.
const { spawnSync } = require('child_process');
const path = require('path');

process.chdir(path.resolve(__dirname, '..', '..'));

const node = process.execPath;

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let filePath = '';
  try {
    filePath = (JSON.parse(input).tool_input || {}).file_path || '';
  } catch {
    process.exit(0);
  }

  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.endsWith('.ts') || !normalized.includes('/visual-bot/')) {
    process.exit(0);
  }

  const checks = [
    ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
    ['lint', ['node_modules/eslint/bin/eslint.js', normalized]],
  ];

  for (const [name, args] of checks) {
    const result = spawnSync(node, args, { encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(`\n[quick-check] ${name} failed after editing ${filePath}:\n`);
      process.stderr.write((result.stdout || '') + (result.stderr || ''));
      process.stderr.write(
        '\n[quick-check] Fix it before continuing — do not add eslint-disable / @ts-ignore.\n',
      );
      process.exit(2);
    }
  }

  process.exit(0);
});
