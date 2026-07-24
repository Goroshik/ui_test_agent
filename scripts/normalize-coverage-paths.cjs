// Windows compat shim for crap4ts: the v8 coverage reporter writes
// coverage-final.json with backslash paths, but crap4ts's Istanbul adapter
// compares an already forward-slashed cwd prefix against the raw (backslash)
// path, so `startsWith` never matches, the prefix is never stripped, and every
// function reports 0% coverage. Rewriting the paths to forward slashes lets
// crap4ts match coverage onto the complexity data correctly.
// No-op on POSIX (no backslashes to replace).
const fs = require('fs');
const path = require('path');

const input = process.argv[2] || path.join('coverage', 'coverage-final.json');
const output = process.argv[3] || input;

const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const normalized = {};

for (const [key, value] of Object.entries(raw)) {
  if (value && typeof value === 'object' && typeof value.path === 'string') {
    value.path = value.path.replace(/\\/g, '/');
  }
  normalized[key.replace(/\\/g, '/')] = value;
}

fs.writeFileSync(output, JSON.stringify(normalized));
console.log(`normalized ${Object.keys(normalized).length} coverage paths -> ${output}`);
