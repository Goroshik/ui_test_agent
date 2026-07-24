import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { AttentionMemory } from './attention-memory.js';

/** _isEntry never touches the client, so a bare stub is enough. */
function makeMemory(kind: 'screenshot' | 'snapshot' = 'screenshot'): AttentionMemory {
  const client = {} as unknown as OpenAI;
  return new AttentionMemory(client, 'test-model', kind);
}

/** A structurally valid persisted entry. */
function validEntry(): Record<string, unknown> {
  return {
    id: '1730000000000-abc123',
    kind: 'screenshot',
    key: 'navigate-example.com',
    summary: 'header label changed',
    rule: 'Check the header label after navigation.',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('AttentionMemory._isEntry', () => {
  const isEntry = (value: unknown): boolean => makeMemory()['_isEntry'](value);

  it('accepts a fully-formed screenshot entry', () => {
    expect(isEntry(validEntry())).toBe(true);
  });

  it('accepts a fully-formed snapshot entry', () => {
    expect(isEntry({ ...validEntry(), kind: 'snapshot' })).toBe(true);
  });

  it('rejects null and undefined', () => {
    expect(isEntry(null)).toBe(false);
    expect(isEntry(undefined)).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(isEntry({ ...validEntry(), kind: 'video' })).toBe(false);
  });

  it('rejects a missing kind', () => {
    const entry = validEntry();
    delete entry.kind;
    expect(isEntry(entry)).toBe(false);
  });

  // Each required string field, checked one at a time, so a mutation that drops
  // any single check is caught rather than masked by the others.
  const stringFields = ['id', 'key', 'summary', 'rule', 'createdAt'] as const;

  for (const field of stringFields) {
    it(`rejects an entry whose "${field}" is missing`, () => {
      const entry = validEntry();
      delete entry[field];
      expect(isEntry(entry)).toBe(false);
    });

    it(`rejects an entry whose "${field}" is not a string`, () => {
      expect(isEntry({ ...validEntry(), [field]: 42 })).toBe(false);
    });
  }

  it('accepts an entry carrying extra unknown fields', () => {
    expect(isEntry({ ...validEntry(), extra: 'ignored' })).toBe(true);
  });

  it('rejects an empty object', () => {
    expect(isEntry({})).toBe(false);
  });
});
