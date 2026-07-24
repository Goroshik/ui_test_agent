import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveConfidence, type ConfidenceLevel } from './identity-resolution-agent.js';

const level: fc.Arbitrary<ConfidenceLevel> = fc.constantFrom('high', 'medium', 'low');
const rank: Record<ConfidenceLevel, number> = { high: 2, medium: 1, low: 0 };

describe('resolveConfidence (property)', () => {
  it('is commutative: resolveConfidence(a, b) === resolveConfidence(b, a)', () => {
    fc.assert(
      fc.property(level, level, (a, b) => {
        expect(resolveConfidence(a, b)).toBe(resolveConfidence(b, a));
      }),
    );
  });

  it('is idempotent: resolveConfidence(a, a) === a', () => {
    fc.assert(
      fc.property(level, (a) => {
        expect(resolveConfidence(a, a)).toBe(a);
      }),
    );
  });

  it('is monotonic: the result never ranks below either input (it only upgrades, never downgrades)', () => {
    fc.assert(
      fc.property(level, level, (a, b) => {
        const result = resolveConfidence(a, b);
        expect(rank[result]).toBeGreaterThanOrEqual(rank[a]);
        expect(rank[result]).toBeGreaterThanOrEqual(rank[b]);
      }),
    );
  });

  it('is closed over the input pair: the result always equals a or b', () => {
    fc.assert(
      fc.property(level, level, (a, b) => {
        const result = resolveConfidence(a, b);
        expect([a, b]).toContain(result);
      }),
    );
  });

  it('is associative when chained, matching the natural max ordering low < medium < high', () => {
    fc.assert(
      fc.property(level, level, level, (a, b, c) => {
        const leftFirst = resolveConfidence(resolveConfidence(a, b), c);
        const rightFirst = resolveConfidence(a, resolveConfidence(b, c));
        expect(leftFirst).toBe(rightFirst);
      }),
    );
  });
});
