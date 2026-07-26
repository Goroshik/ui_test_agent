import { describe, it, expect } from 'vitest';
import { parseDiffJson } from './utils.js';

describe('parseDiffJson', () => {
  it('returns null for empty input', () => {
    expect(parseDiffJson('')).toBeNull();
  });

  it('parses a clean JSON object', () => {
    expect(parseDiffJson('{"changed": true, "summary": "layout shifted"}')).toEqual({
      changed: true,
      summary: 'layout shifted',
    });
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const input = 'Here is the result:\n{"changed": false, "summary": "no diff"}\nDone.';
    expect(parseDiffJson(input)).toEqual({ changed: false, summary: 'no diff' });
  });

  it('coerces a missing "changed" field to false', () => {
    expect(parseDiffJson('{"summary": "ok"}')).toEqual({ changed: false, summary: 'ok' });
  });

  it('coerces a non-string "summary" field to an empty string', () => {
    expect(parseDiffJson('{"changed": true, "summary": 42}')).toEqual({ changed: true, summary: '' });
  });

  it('returns null for malformed JSON', () => {
    expect(parseDiffJson('{not valid json')).toBeNull();
  });

  it('returns null when there is no brace pair to extract', () => {
    expect(parseDiffJson('no json here')).toBeNull();
  });
});
