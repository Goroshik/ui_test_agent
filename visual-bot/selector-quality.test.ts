import { describe, it, expect } from 'vitest';
import {
  isEphemeralRef,
  isStableSelector,
  isUsableSelector,
  upgradePreferred,
} from './selector-quality.js';
import type { ComponentSelectors } from './pipeline/types.js';

function selectors(overrides: Partial<ComponentSelectors> = {}): ComponentSelectors {
  return { preferred: '', aria: '', testid: null, css: null, xpath: null, ...overrides };
}

describe('isEphemeralRef', () => {
  it.each(['[data-ref="e7"]', '[data-ref="e123"]', '[data-ref=""]'])(
    'flags the Playwright handle %s',
    (selector) => {
      expect(isEphemeralRef(selector)).toBe(true);
    },
  );

  it('flags it despite surrounding whitespace', () => {
    expect(isEphemeralRef('  [data-ref="e7"] ')).toBe(true);
  });

  it.each(['[data-testid="save"]', '[data-cy="save"]', '#save', 'button:contains("Save")', ''])(
    'leaves the real selector %s alone',
    (selector) => {
      expect(isEphemeralRef(selector)).toBe(false);
    },
  );

  it('does not flag a legitimate attribute that merely starts similarly', () => {
    expect(isEphemeralRef('[data-reference="x"]')).toBe(false);
  });
});

describe('isStableSelector', () => {
  it.each(['[data-testid="a"]', '[data-cy="a"]', '[data-qa="a"]', '#main'])(
    'accepts %s',
    (selector) => {
      expect(isStableSelector(selector)).toBe(true);
    },
  );

  it.each(['[data-ref="e7"]', 'button:contains("Save")', '.btn', 'input[aria-label="Email"]', ''])(
    'rejects %s',
    (selector) => {
      expect(isStableSelector(selector)).toBe(false);
    },
  );
});

describe('isUsableSelector', () => {
  it('accepts a real selector', () => {
    expect(isUsableSelector('button:contains("Save")')).toBe(true);
  });

  it('rejects an ephemeral ref', () => {
    expect(isUsableSelector('[data-ref="e7"]')).toBe(false);
  });

  it.each([['empty', ''], ['whitespace', '   '], ['null', null], ['undefined', undefined]])(
    'rejects %s',
    (_label, selector) => {
      expect(isUsableSelector(selector)).toBe(false);
    },
  );
});

describe('upgradePreferred', () => {
  it('promotes a testid found on a later run over the earlier fallback', () => {
    const merged = selectors({ testid: '[data-testid="save"]', aria: 'button[name="Save"]' });
    expect(upgradePreferred('button[name="Save"]', merged)).toBe('[data-testid="save"]');
  });

  it('promotes a testid over an ephemeral ref', () => {
    const merged = selectors({ testid: '[data-testid="save"]' });
    expect(upgradePreferred('[data-ref="e7"]', merged)).toBe('[data-testid="save"]');
  });

  it('replaces an ephemeral ref with any real selector', () => {
    const merged = selectors({ aria: 'button[name="Save"]' });
    expect(upgradePreferred('[data-ref="e7"]', merged)).toBe('button[name="Save"]');
  });

  it('prefers css over aria when filling an empty preferred', () => {
    const merged = selectors({ aria: 'button[name="Save"]', css: '.save-btn' });
    expect(upgradePreferred('', merged)).toBe('.save-btn');
  });

  it('keeps a selector that is already good', () => {
    const merged = selectors({ aria: 'button[name="Other"]', css: '.other' });
    expect(upgradePreferred('[data-testid="save"]', merged)).toBe('[data-testid="save"]');
  });

  it('never downgrades a real selector to a weaker one', () => {
    const merged = selectors({ css: '.generated-hash-x1y2' });
    expect(upgradePreferred('#stable-id', merged)).toBe('#stable-id');
  });

  it('returns nothing when there is nothing usable to return', () => {
    expect(upgradePreferred('[data-ref="e7"]', selectors())).toBe('');
  });

  it('returns nothing rather than an ephemeral ref hiding in css', () => {
    expect(upgradePreferred('', selectors({ css: '[data-ref="e9"]' }))).toBe('');
  });

  it('ignores an ephemeral ref stored as the testid', () => {
    const merged = selectors({ testid: '[data-ref="e7"]', aria: 'button[name="Save"]' });
    expect(upgradePreferred('', merged)).toBe('button[name="Save"]');
  });

  it('is idempotent — merging twice does not drift', () => {
    const merged = selectors({ testid: '[data-testid="save"]' });
    const once = upgradePreferred('[data-ref="e7"]', merged);
    expect(upgradePreferred(once, merged)).toBe(once);
  });
});
