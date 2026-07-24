import { describe, it, expect } from 'vitest';
import { FixturesGenerator } from './fixtures-generator.js';

const valueForType = (key: string, type: unknown): unknown =>
  new FixturesGenerator()['_valueForType'](key, type);

describe('FixturesGenerator._valueForType', () => {
  it('builds an id-shaped example for an id type', () => {
    expect(valueForType('user', 'id')).toBe('user-123');
  });

  it('matches "id" case-insensitively and as a substring', () => {
    expect(valueForType('order', 'UUID')).toBe('order-123');
    expect(valueForType('order', 'identifier')).toBe('order-123');
  });

  it('builds a path for a url type', () => {
    expect(valueForType('avatar', 'url')).toBe('/example/avatar');
  });

  for (const numeric of ['number', 'int', 'integer', 'float']) {
    it(`returns 0 for the "${numeric}" type`, () => {
      expect(valueForType('count', numeric)).toBe(0);
    });
  }

  it('returns true for a boolean type', () => {
    expect(valueForType('active', 'bool')).toBe(true);
    expect(valueForType('active', 'boolean')).toBe(true);
  });

  it('returns an empty array for an array type', () => {
    expect(valueForType('items', 'array')).toEqual([]);
  });

  it('falls back to a labelled example string for an unknown type', () => {
    expect(valueForType('title', 'string')).toBe('example-title');
    expect(valueForType('title', 'mystery')).toBe('example-title');
  });

  it('stringifies a non-string type before matching', () => {
    expect(valueForType('count', 42)).toBe('example-count');
    expect(valueForType('flag', null)).toBe('example-flag');
    expect(valueForType('flag', undefined)).toBe('example-flag');
  });

  // Precedence is decided by check order, not by specificity.
  it('prefers the id branch over url when both substrings appear', () => {
    expect(valueForType('x', 'id-url')).toBe('x-123');
  });

  it('prefers the url branch over number when both appear', () => {
    expect(valueForType('x', 'url-number')).toBe('/example/x');
  });

  it('prefers the number branch over bool when both appear', () => {
    expect(valueForType('x', 'int-bool')).toBe(0);
  });

  it('prefers the bool branch over array when both appear', () => {
    expect(valueForType('x', 'bool-array')).toBe(true);
  });
});
