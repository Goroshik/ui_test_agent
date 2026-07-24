import { describe, it, expect } from 'vitest';
import { SelectorsGenerator } from './selectors-generator.js';
import type { ComponentSelectors } from '../pipeline/types.js';

function selectors(overrides: Partial<ComponentSelectors> = {}): ComponentSelectors {
  return { preferred: '', aria: '', testid: null, css: null, xpath: null, ...overrides };
}

const best = (overrides: Partial<ComponentSelectors>): string =>
  new SelectorsGenerator()['_bestSelector'](selectors(overrides));

describe('SelectorsGenerator._bestSelector', () => {
  it('uses a testid that is already a full attribute selector as-is', () => {
    expect(best({ testid: '[data-testid="submit"]' })).toBe('[data-testid="submit"]');
  });

  it('accepts any data- attribute selector without rewrapping', () => {
    expect(best({ testid: '[data-cy="submit"]' })).toBe('[data-cy="submit"]');
  });

  it('wraps a bare testid into an attribute selector', () => {
    expect(best({ testid: 'submit-btn' })).toBe('[data-testid="submit-btn"]');
  });

  it('prefers the testid over css and preferred', () => {
    expect(best({ testid: 'tid', css: '#css', preferred: '#pref' })).toBe('[data-testid="tid"]');
  });

  it('falls back to css when there is no testid', () => {
    expect(best({ css: '#login-form .btn', preferred: '#pref' })).toBe('#login-form .btn');
  });

  it('falls back to a data- preferred selector when css is absent', () => {
    expect(best({ preferred: '[data-qa="go"]' })).toBe('[data-qa="go"]');
  });

  it('returns the preferred selector even when it is not a data- attribute', () => {
    expect(best({ preferred: 'button[name="Go"]' })).toBe('button[name="Go"]');
  });

  it('returns an empty string when nothing is available', () => {
    expect(best({})).toBe('');
  });

  it('treats an empty testid as absent', () => {
    expect(best({ testid: '', css: '#css' })).toBe('#css');
  });

  it('treats an empty css as absent', () => {
    expect(best({ css: '', preferred: '#pref' })).toBe('#pref');
  });
});
