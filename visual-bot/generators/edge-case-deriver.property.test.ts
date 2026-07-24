import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { dedupe } from './edge-case-deriver.js';
import type { EdgeCaseType, TestEdgeCase } from './test-planner.js';

const edgeCaseType: fc.Arbitrary<EdgeCaseType> = fc.constantFrom(
  'empty-state', 'disabled', 'network-error', 'network-timeout', 'loading-state', 'hidden',
  'required-empty', 'maxlength-exceeded', 'minlength-short', 'pattern-mismatch', 'invalid-email',
  'invalid-url', 'out-of-range', 'wrong-type', 'whitespace-only', 'xss-injection', 'sql-injection',
  'network-status',
);

// Small alphabets for component/input/description so fast-check actually
// produces key collisions worth deduping, instead of near-always-unique strings.
const smallString = fc.constantFrom('a', 'b', 'c');

// `input` is always present here (rather than fc.option'd) purely to sidestep
// exactOptionalPropertyTypes friction with fast-check's record typing — the
// invariants below don't depend on whether `input` is optional.
const testEdgeCase: fc.Arbitrary<TestEdgeCase> = fc.record({
  type: edgeCaseType,
  component: smallString,
  description: smallString,
  input: smallString,
});

function dedupeKey(c: TestEdgeCase): string {
  return `${c.type}|${c.component}|${c.input ?? ''}|${c.description}`;
}

describe('dedupe (property)', () => {
  it('never returns more elements than it was given', () => {
    fc.assert(
      fc.property(fc.array(testEdgeCase), (cases) => {
        expect(dedupe(cases).length).toBeLessThanOrEqual(cases.length);
      }),
    );
  });

  it('produces no duplicate keys in its output', () => {
    fc.assert(
      fc.property(fc.array(testEdgeCase), (cases) => {
        const keys = dedupe(cases).map(dedupeKey);
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it('is idempotent: deduping an already-deduped array changes nothing', () => {
    fc.assert(
      fc.property(fc.array(testEdgeCase), (cases) => {
        const once = dedupe(cases);
        const twice = dedupe(once);
        expect(twice).toEqual(once);
      }),
    );
  });

  it('keeps only elements that were present in the input (no fabrication)', () => {
    fc.assert(
      fc.property(fc.array(testEdgeCase), (cases) => {
        const inputKeys = new Set(cases.map(dedupeKey));
        for (const c of dedupe(cases)) {
          expect(inputKeys.has(dedupeKey(c))).toBe(true);
        }
      }),
    );
  });

  it('preserves the relative order of first occurrences (stable dedup)', () => {
    fc.assert(
      fc.property(fc.array(testEdgeCase), (cases) => {
        const result = dedupe(cases);
        const firstIndexInInput = result.map((c) => cases.findIndex((x) => dedupeKey(x) === dedupeKey(c)));
        const sorted = [...firstIndexInInput].sort((a, b) => a - b);
        expect(firstIndexInInput).toEqual(sorted);
      }),
    );
  });
});
