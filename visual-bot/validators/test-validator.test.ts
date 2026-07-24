import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TestValidator } from './test-validator.js';
import type { ValidationViolation } from './test-validator.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Writes a spec file and validates it, returning only the named rule's hits. */
async function violationsFor(source: string, rule: string): Promise<ValidationViolation[]> {
  const dir = await tempDir('tv-spec-');
  const file = join(dir, 'sample.cy.js');
  await writeFile(file, source, 'utf-8');

  const result = await new TestValidator().validateFile(file);
  return result.violations.filter((v) => v.rule === rule);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('intercept-before-visit rule (scanInterceptBeforeVisitLine)', () => {
  const RULE = 'intercept-before-visit';

  it('flags cy.intercept after cy.visit inside beforeEach', async () => {
    const source = [
      'describe("a", () => {',
      '  beforeEach(() => {',
      '    cy.visit("/login");',
      '    cy.intercept("GET", "/api/me");',
      '  });',
      '});',
    ].join('\n');

    const violations = await violationsFor(source, RULE);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(4);
  });

  it('accepts cy.intercept before cy.visit inside beforeEach', async () => {
    const source = [
      'describe("a", () => {',
      '  beforeEach(() => {',
      '    cy.intercept("GET", "/api/me");',
      '    cy.visit("/login");',
      '  });',
      '});',
    ].join('\n');

    expect(await violationsFor(source, RULE)).toEqual([]);
  });

  it('ignores cy.intercept after cy.visit outside any beforeEach', async () => {
    const source = [
      'it("works", () => {',
      '  cy.visit("/login");',
      '  cy.intercept("GET", "/api/me");',
      '});',
    ].join('\n');

    expect(await violationsFor(source, RULE)).toEqual([]);
  });

  it('stops tracking once the beforeEach block closes', async () => {
    const source = [
      'describe("a", () => {',
      '  beforeEach(() => {',
      '    cy.visit("/login");',
      '  });',
      '  it("t", () => {',
      '    cy.intercept("GET", "/api/me");',
      '  });',
      '});',
    ].join('\n');

    expect(await violationsFor(source, RULE)).toEqual([]);
  });

  it('flags every offending intercept in the block', async () => {
    const source = [
      'beforeEach(() => {',
      '  cy.visit("/a");',
      '  cy.intercept("GET", "/api/one");',
      '  cy.intercept("GET", "/api/two");',
      '});',
    ].join('\n');

    expect(await violationsFor(source, RULE)).toHaveLength(2);
  });

  it('resets state across two separate beforeEach blocks', async () => {
    const source = [
      'describe("a", () => {',
      '  beforeEach(() => {',
      '    cy.visit("/a");',
      '  });',
      '});',
      'describe("b", () => {',
      '  beforeEach(() => {',
      '    cy.intercept("GET", "/api/b");',
      '    cy.visit("/b");',
      '  });',
      '});',
    ].join('\n');

    expect(await violationsFor(source, RULE)).toEqual([]);
  });

  it('handles a single-line beforeEach with visit then intercept', async () => {
    const source = 'beforeEach(() => { cy.visit("/a"); cy.intercept("GET", "/api"); });';
    // The whole block opens and closes on one line, so depth returns to its
    // starting value and the block is treated as already exited.
    expect(await violationsFor(source, RULE)).toEqual([]);
  });
});

describe('TestValidator._checkFixtureRefs', () => {
  const checkFixtureRefs = (
    fixtures: string[],
    lines: string[],
  ): ValidationViolation[] => {
    const validator = new TestValidator();
    validator['knownFixtures'] = new Set(fixtures);
    return validator['_checkFixtureRefs'](lines, 'spec.cy.js');
  };

  it('does nothing when no fixtures are indexed', () => {
    expect(checkFixtureRefs([], ['cy.intercept("GET", "/a", { fixture: "missing.json" });'])).toEqual([]);
  });

  it('accepts a fixture that exists', () => {
    expect(
      checkFixtureRefs(['users.json'], ['cy.intercept("GET", "/a", { fixture: "users.json" });']),
    ).toEqual([]);
  });

  it('flags a fixture that does not exist', () => {
    const violations = checkFixtureRefs(
      ['users.json'],
      ['cy.intercept("GET", "/a", { fixture: "orders.json" });'],
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('missing-fixture');
    expect(violations[0]?.message).toContain('orders.json');
    expect(violations[0]?.line).toBe(1);
  });

  it('appends .json when the reference omits the extension', () => {
    expect(checkFixtureRefs(['users.json'], ['{ fixture: "users" }'])).toEqual([]);
  });

  it('strips a leading ./ or / from the reference', () => {
    expect(checkFixtureRefs(['users.json'], ['{ fixture: "./users.json" }'])).toEqual([]);
    expect(checkFixtureRefs(['users.json'], ['{ fixture: "/users.json" }'])).toEqual([]);
  });

  it('accepts single, double and back quotes', () => {
    expect(checkFixtureRefs(['u.json'], ["{ fixture: 'u.json' }"])).toEqual([]);
    expect(checkFixtureRefs(['u.json'], ['{ fixture: "u.json" }'])).toEqual([]);
    expect(checkFixtureRefs(['u.json'], ['{ fixture: `u.json` }'])).toEqual([]);
  });

  it('tolerates whitespace around the colon', () => {
    expect(checkFixtureRefs(['u.json'], ['{ fixture   :   "u.json" }'])).toEqual([]);
  });

  it('flags several missing fixtures on the same line', () => {
    const violations = checkFixtureRefs(['ok.json'], ['{ fixture: "a.json" } { fixture: "b.json" }']);
    expect(violations).toHaveLength(2);
  });

  it('reports the correct 1-based line number', () => {
    const violations = checkFixtureRefs(['ok.json'], ['line one', 'line two', '{ fixture: "x.json" }']);
    expect(violations[0]?.line).toBe(3);
  });

  it('includes the trimmed source line as a snippet', () => {
    const violations = checkFixtureRefs(['ok.json'], ['     { fixture: "x.json" }     ']);
    expect(violations[0]?.snippet).toBe('{ fixture: "x.json" }');
  });

  it('ignores lines with no fixture reference', () => {
    expect(checkFixtureRefs(['ok.json'], ['cy.visit("/a");', '// nothing here'])).toEqual([]);
  });
});

describe('TestValidator._collectTestFiles (via validateDir)', () => {
  it('returns no results for a directory that does not exist', async () => {
    const results = await new TestValidator().validateDir(join(tmpdir(), 'tv-does-not-exist-xyz'));
    expect(results).toEqual([]);
  });

  it('finds .cy.js specs at the top level', async () => {
    const dir = await tempDir('tv-dir-');
    await writeFile(join(dir, 'a.cy.js'), 'cy.visit("/a");', 'utf-8');

    const results = await new TestValidator().validateDir(dir);
    expect(results).toHaveLength(1);
    expect(results[0]?.file).toContain('a.cy.js');
  });

  it('recurses into subdirectories', async () => {
    const dir = await tempDir('tv-dir-');
    await mkdir(join(dir, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(dir, 'a.cy.js'), '', 'utf-8');
    await writeFile(join(dir, 'nested', 'b.cy.js'), '', 'utf-8');
    await writeFile(join(dir, 'nested', 'deeper', 'c.cy.js'), '', 'utf-8');

    const results = await new TestValidator().validateDir(dir);
    expect(results).toHaveLength(3);
  });

  it('ignores files that are not .cy.js', async () => {
    const dir = await tempDir('tv-dir-');
    await writeFile(join(dir, 'notes.md'), '', 'utf-8');
    await writeFile(join(dir, 'helper.js'), '', 'utf-8');
    await writeFile(join(dir, 'spec.cy.ts'), '', 'utf-8');

    expect(await new TestValidator().validateDir(dir)).toEqual([]);
  });

  it('indexes the fixtures directory when one is supplied', async () => {
    const dir = await tempDir('tv-dir-');
    const fixtures = await tempDir('tv-fix-');
    await writeFile(join(fixtures, 'users.json'), '{}', 'utf-8');
    await writeFile(join(fixtures, 'readme.txt'), 'x', 'utf-8');
    await writeFile(
      join(dir, 'a.cy.js'),
      'cy.intercept("GET", "/a", { fixture: "users.json" });\ncy.intercept("GET", "/b", { fixture: "gone.json" });',
      'utf-8',
    );

    const results = await new TestValidator().validateDir(dir, fixtures);
    const missing = results[0]?.violations.filter((v) => v.rule === 'missing-fixture') ?? [];

    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('gone.json');
  });

  it('skips fixture indexing when the fixtures directory is absent', async () => {
    const dir = await tempDir('tv-dir-');
    await writeFile(join(dir, 'a.cy.js'), '{ fixture: "anything.json" }', 'utf-8');

    const results = await new TestValidator().validateDir(dir, join(tmpdir(), 'tv-no-fixtures-xyz'));
    expect(results[0]?.violations.filter((v) => v.rule === 'missing-fixture')).toEqual([]);
  });
});
