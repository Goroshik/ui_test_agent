import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ValidationViolation {
  file: string;
  line: number;
  rule: string;
  message: string;
  snippet: string;
}

export interface ValidationResult {
  file: string;
  violations: ValidationViolation[];
  passed: boolean;
}

// ─── Rules ────────────────────────────────────────────────────────────────────

interface Rule {
  name: string;
  check: (lines: string[], filePath: string) => ValidationViolation[];
}

// Patterns that should never appear in a Cypress spec — they're Playwright,
// Jest, or otherwise wrong. Each entry: [rule-name, regex, human message].
const FORBIDDEN_PATTERNS: Array<[string, RegExp, string]> = [
  ['no-playwright-fill',     /\.\s*fill\s*\(/,                'Playwright `.fill()` — use `cy.get(...).clear().type(...)` instead'],
  ['no-playwright-page',     /\bawait\s+page\b|\bpage\.(locator|goto|getBy)/, 'Playwright `page.*` API — Cypress has no `page` object'],
  ['no-getby-helpers',       /\bgetBy(TestId|Role|Text|Label|Title|Placeholder)\s*\(/, 'Playwright `getBy*()` helper — use SELECTORS.X.Y with cy.get'],
  ['no-jest-expect',         /^\s*expect\s*\(/m,              'Jest/Playwright `expect()` — use Cypress `.should()` chains'],
  ['no-async-it',            /\bit\s*\([^,]*,\s*async\s/,     'Cypress chains are not promises — remove `async` from it()'],
  ['no-async-beforeeach',    /\bbeforeEach\s*\(\s*async\s/,   'No `async` in beforeEach — Cypress chains queue automatically'],
  ['no-await-cy',            /\bawait\s+cy\./,                '`await cy.*` is wrong — Cypress commands are chainable, not awaitable'],
  ['no-playwright-press',    /\.\s*press\s*\(\s*['"]/,        'Playwright `.press()` — use cy.get(sel).type("{enter}")'],
  ['no-locator-method',      /\.locator\s*\(/,                'Playwright `.locator()` — use cy.get(SELECTORS.X.Y)'],
  ['no-hardcoded-credentials', /(['"])(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\1/, 'Hardcoded email — use Cypress.env(\'email\')'],
];

const RULES: Rule[] = [
  {
    // Rule 0: forbidden cross-framework / API patterns
    name: 'forbidden-patterns',
    check(lines, file) {
      const violations: ValidationViolation[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // skip pure comment lines
        if (/^\s*\/\//.test(line)) continue;
        for (const [name, re, msg] of FORBIDDEN_PATTERNS) {
          const r = new RegExp(re.source, re.flags.includes('m') ? re.flags : re.flags + 'm');
          if (r.test(line)) {
            violations.push({
              file,
              line: i + 1,
              rule: name,
              message: msg,
              snippet: line.trim(),
            });
          }
        }
      }
      return violations;
    },
  },
  {
    // Rule 1: no hardcoded selector strings in cy.get()
    name: 'no-hardcoded-selectors',
    check(lines, file) {
      const violations: ValidationViolation[] = [];
      // Match cy.get('...') or cy.get("...") or cy.get(`...`) where value starts with . # [ or a tag
      const re = /cy\.get\(\s*['"`]([.#\[a-z][^'"`]*?)['"`]\s*\)/gi;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) {
          violations.push({
            file,
            line: i + 1,
            rule: 'no-hardcoded-selectors',
            message: `Hardcoded selector: "${m[1]}" — use SELECTORS.X.Y instead`,
            snippet: line.trim(),
          });
        }
      }
      return violations;
    },
  },
  {
    // Rule 2: no numeric cy.wait()
    name: 'no-numeric-wait',
    check(lines, file) {
      const violations: ValidationViolation[] = [];
      const re = /cy\.wait\(\s*\d+\s*\)/g;
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          violations.push({
            file,
            line: i + 1,
            rule: 'no-numeric-wait',
            message: 'cy.wait(number) is forbidden — use cy.wait(\'@alias\') instead',
            snippet: lines[i].trim(),
          });
        }
      }
      return violations;
    },
  },
  {
    // Rule 3: cy.intercept() must appear before cy.visit() inside beforeEach
    name: 'intercept-before-visit',
    check(lines, file) {
      const violations: ValidationViolation[] = [];
      let inBeforeEach = false;
      let depth = 0;
      let seenVisit = false;
      let beforeEachDepth = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/beforeEach\s*\(/.test(line)) {
          inBeforeEach = true;
          seenVisit = false;
          beforeEachDepth = depth;
        }

        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        depth += opens - closes;

        if (inBeforeEach && depth <= beforeEachDepth) {
          inBeforeEach = false;
          seenVisit = false;
        }

        if (inBeforeEach) {
          if (/cy\.visit\s*\(/.test(line)) seenVisit = true;
          if (seenVisit && /cy\.intercept\s*\(/.test(line)) {
            violations.push({
              file,
              line: i + 1,
              rule: 'intercept-before-visit',
              message: 'cy.intercept() must be placed before cy.visit() in beforeEach',
              snippet: line.trim(),
            });
          }
        }
      }
      return violations;
    },
  },
  {
    // Rule 4: SELECTORS import must be present if cy.get(SELECTORS...) is used
    name: 'selectors-import',
    check(lines, file) {
      const usesSelectors = lines.some((l) => /SELECTORS\./.test(l));
      if (!usesSelectors) return [];

      const hasImport = lines.some((l) =>
        /import\s*\{[^}]*SELECTORS[^}]*\}\s*from/.test(l),
      );

      if (!hasImport) {
        return [{
          file,
          line: 1,
          rule: 'selectors-import',
          message: 'SELECTORS is used but not imported from ../../support/selectors',
          snippet: lines[0]?.trim() ?? '',
        }];
      }
      return [];
    },
  },
];

// ─── Validator ────────────────────────────────────────────────────────────────

export class TestValidator {
  private knownFixtures: Set<string> = new Set();

  async validateDir(testDir: string, fixturesDir?: string): Promise<ValidationResult[]> {
    if (fixturesDir && existsSync(fixturesDir)) {
      const entries = await readdir(fixturesDir);
      this.knownFixtures = new Set(entries.filter((f) => f.endsWith('.json')));
    }
    const files = await this._collectTestFiles(testDir);
    if (files.length === 0) {
      console.log('[TestValidator] No .cy.js files found in', testDir);
      return [];
    }
    console.log(`[TestValidator] Validating ${files.length} test file(s)… (${this.knownFixtures.size} fixtures available)`);
    return Promise.all(files.map((f) => this.validateFile(f)));
  }

  async validateFile(filePath: string): Promise<ValidationResult> {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const allViolations: ValidationViolation[] = [];

    for (const rule of RULES) {
      allViolations.push(...rule.check(lines, filePath));
    }

    // Extra rule that needs cross-file state (the fixtures index).
    allViolations.push(...this._checkFixtureRefs(lines, filePath));

    return {
      file: filePath,
      violations: allViolations,
      passed: allViolations.length === 0,
    };
  }

  /** Flag `cy.intercept(..., { fixture: 'X.json' })` where X.json is missing. */
  private _checkFixtureRefs(lines: string[], file: string): ValidationViolation[] {
    if (this.knownFixtures.size === 0) return [];
    const re = /\bfixture\s*:\s*['"`]([^'"`]+?)['"`]/g;
    const violations: ValidationViolation[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        const name = m[1].replace(/^\.?\//, '');
        const withExt = name.endsWith('.json') ? name : `${name}.json`;
        if (!this.knownFixtures.has(withExt)) {
          violations.push({
            file,
            line: i + 1,
            rule: 'missing-fixture',
            message: `Fixture "${name}" does not exist in cypress/fixtures/`,
            snippet: line.trim(),
          });
        }
      }
    }
    return violations;
  }

  private async _collectTestFiles(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    const files: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this._collectTestFiles(full)));
      } else if (entry.isFile() && entry.name.endsWith('.cy.js')) {
        files.push(full);
      }
    }
    return files;
  }
}

// ─── Report formatting ────────────────────────────────────────────────────────

function printReport(results: ValidationResult[]): boolean {
  let totalViolations = 0;

  for (const result of results) {
    if (result.passed) {
      console.log(`  ✓ ${result.file}`);
      continue;
    }

    console.log(`\n  ✗ ${result.file} (${result.violations.length} violation(s))`);
    for (const v of result.violations) {
      console.log(`    Line ${v.line} [${v.rule}]: ${v.message}`);
      console.log(`      > ${v.snippet}`);
    }
    totalViolations += result.violations.length;
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  console.log(`\n[TestValidator] Results: ${passed} passed, ${failed} failed, ${totalViolations} violation(s)`);
  return totalViolations === 0;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.replace(/\\/g, '/') === __filename.replace(/\\/g, '/');
if (isMain) {
  config({ path: resolve(__dirname, '..', '..', '.env') });

  const cypressDir = resolve(__dirname, '..', '..', 'cypress-tests');
  const testDir = join(cypressDir, 'cypress', 'e2e');
  const fixturesDir = join(cypressDir, 'cypress', 'fixtures');

  console.log('[TestValidator] Scanning:', testDir, '\n');

  const validator = new TestValidator();
  const results = await validator.validateDir(testDir, fixturesDir);

  if (results.length === 0) {
    console.log('[TestValidator] No test files to validate');
    process.exit(0);
  }

  const ok = printReport(results);
  process.exit(ok ? 0 : 1);
}
