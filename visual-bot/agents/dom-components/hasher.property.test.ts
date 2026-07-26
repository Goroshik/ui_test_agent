import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashContent } from './hasher.js';

describe('hashContent (property)', () => {
  it('is deterministic: the same content always hashes to the same value', () => {
    fc.assert(
      fc.property(fc.string(), (content) => {
        expect(hashContent(content)).toBe(hashContent(content));
      }),
    );
  });

  it('always returns a 32-character lowercase hex digest', () => {
    fc.assert(
      fc.property(fc.string(), (content) => {
        expect(hashContent(content)).toMatch(/^[0-9a-f]{32}$/);
      }),
    );
  });
});
