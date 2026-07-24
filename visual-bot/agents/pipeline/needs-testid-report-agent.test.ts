import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { NeedsTestIdReportAgent } from './needs-testid-report-agent.js';
import type {
  ClassifiedComponent,
  ComponentAction,
  ComponentRecord,
  ComponentSelectors,
} from '../../pipeline/types.js';

/** The classification helpers never touch the client. */
function makeAgent(): NeedsTestIdReportAgent {
  return new NeedsTestIdReportAgent({} as unknown as OpenAI, 'test-model');
}

function selectors(overrides: Partial<ComponentSelectors> = {}): ComponentSelectors {
  return { preferred: '', aria: '', testid: null, css: null, xpath: null, ...overrides };
}

function record(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: 'cmp-1',
    label: 'Submit',
    componentType: 'button',
    pages: ['/login'],
    lastSeen: '2026-01-01T00:00:00.000Z',
    selectors: selectors(),
    actions: [],
    states: {},
    assertions: { pre_interaction: [], post_interaction: [] },
    confidence: 'high',
    seenCount: 1,
    manualOverride: false,
    notes: '',
    ...overrides,
  };
}

const clickAction: ComponentAction = { type: 'click' };

describe('NeedsTestIdReportAgent._findStableSelector', () => {
  const find = (testid: string | null, css: string | null, preferred: string): string | null =>
    makeAgent()['_findStableSelector'](testid, css, preferred);

  it('prefers a present testid above everything else', () => {
    expect(find('submit-btn', '#other', '[data-testid="p"]')).toBe('submit-btn');
  });

  it('treats the literal string "null" as no testid', () => {
    expect(find('null', null, '')).toBeNull();
  });

  it('accepts a data-testid css attribute selector', () => {
    expect(find(null, '[data-testid="submit"]', '')).toBe('[data-testid="submit"]');
  });

  // The regex accepts testid|cy|qa|test for css.
  for (const attr of ['testid', 'cy', 'qa', 'test']) {
    it(`accepts a data-${attr} css attribute selector`, () => {
      const css = `[data-${attr}="submit"]`;
      expect(find(null, css, '')).toBe(css);
    });
  }

  it('accepts a simple id css selector', () => {
    expect(find(null, '#login-submit', '')).toBe('#login-submit');
  });

  it('rejects an id selector that is not a lone simple id', () => {
    expect(find(null, '#form .btn', '')).toBeNull();
  });

  it('rejects a class css selector', () => {
    expect(find(null, '.btn-primary', '')).toBeNull();
  });

  it('does not consult preferred when a css value is present but unstable', () => {
    // css short-circuits with `return null`, so a stable `preferred` is ignored.
    expect(find(null, '.btn', '[data-testid="ignored"]')).toBeNull();
  });

  it('falls back to a stable preferred selector when css is absent', () => {
    expect(find(null, null, '[data-testid="from-preferred"]')).toBe('[data-testid="from-preferred"]');
  });

  // preferred only accepts testid|cy|qa — data-test is NOT valid here.
  it('rejects a data-test preferred selector', () => {
    expect(find(null, null, '[data-test="nope"]')).toBeNull();
  });

  it('returns null when nothing stable exists', () => {
    expect(find(null, null, 'link[name="Home"]')).toBeNull();
  });

  it('returns null for all-empty input', () => {
    expect(find(null, null, '')).toBeNull();
  });
});

describe('NeedsTestIdReportAgent._determineSelector', () => {
  const determine = (
    sel: ComponentSelectors,
    interacted: boolean,
  ): ReturnType<NeedsTestIdReportAgent['_determineSelector']> =>
    makeAgent()['_determineSelector'](sel, interacted);

  it('marks a component with a stable selector as ready and non-blocking', () => {
    const result = determine(selectors({ testid: 'submit-btn' }), true);
    expect(result).toEqual({
      quality: 'stable',
      classification: 'ready',
      blocking: false,
      currentBestSelector: 'submit-btn',
    });
  });

  it('stays ready even when the component was never interacted with', () => {
    expect(determine(selectors({ testid: 'x' }), false).classification).toBe('ready');
  });

  it('flags an interacted component with only a text-based selector as blocking', () => {
    const result = determine(selectors({ css: 'link[name="Home"]' }), true);
    expect(result).toEqual({
      quality: 'text-based',
      classification: 'needs-attention',
      blocking: true,
      currentBestSelector: 'link[name="Home"]',
    });
  });

  it('demotes a non-interacted text-based component to low-priority', () => {
    const result = determine(selectors({ css: 'link[name="Home"]' }), false);
    expect(result.classification).toBe('low-priority');
    expect(result.blocking).toBe(false);
  });

  it('falls back to the preferred selector when css is absent', () => {
    const result = determine(selectors({ preferred: 'button[name="Go"]' }), true);
    expect(result.quality).toBe('text-based');
    expect(result.currentBestSelector).toBe('button[name="Go"]');
  });

  it('reports quality "none" and a placeholder when no selector exists at all', () => {
    const result = determine(selectors(), true);
    expect(result.quality).toBe('none');
    expect(result.currentBestSelector).toBe('(none)');
    expect(result.blocking).toBe(true);
  });

  it('treats a missing preferred as an empty string rather than undefined', () => {
    const result = determine(selectors({ preferred: '' }), false);
    expect(result.currentBestSelector).toBe('(none)');
  });
});

describe('NeedsTestIdReportAgent._classify', () => {
  const classify = (c: ComponentRecord): ClassifiedComponent => makeAgent()['_classify'](c);

  it('marks a component with no actions as not interacted', () => {
    const result = classify(record());
    expect(result.interactedByUser).toBe(false);
    expect(result.userAction).toBeNull();
  });

  it('reports the first action type as the user action', () => {
    const result = classify(record({ actions: [{ type: 'fill' }, { type: 'click' }] }));
    expect(result.interactedByUser).toBe(true);
    expect(result.userAction).toBe('fill');
  });

  it('carries identity fields straight through', () => {
    const result = classify(
      record({ id: 'cmp-9', label: 'Email', componentType: 'textbox', pages: ['/signup'] }),
    );
    expect(result.componentId).toBe('cmp-9');
    expect(result.label).toBe('Email');
    expect(result.ariaRole).toBe('textbox');
    expect(result.ariaName).toBe('Email');
    expect(result.page).toBe('/signup');
  });

  it('defaults the page to "/" when the record lists none', () => {
    expect(classify(record({ pages: [] })).page).toBe('/');
  });

  it('nulls an empty componentType and label rather than passing empty strings', () => {
    const result = classify(record({ componentType: '', label: '' }));
    expect(result.ariaRole).toBeNull();
    expect(result.ariaName).toBeNull();
  });

  it('always starts with no suggestion', () => {
    expect(classify(record()).suggestion).toBeNull();
  });

  it('produces a blocking classification for an interacted unstable component', () => {
    const result = classify(
      record({ actions: [clickAction], selectors: selectors({ css: '.btn' }) }),
    );
    expect(result.classification).toBe('needs-attention');
    expect(result.blocking).toBe(true);
    expect(result.selectorQuality).toBe('text-based');
  });

  it('produces a ready classification for a stable component', () => {
    const result = classify(
      record({ actions: [clickAction], selectors: selectors({ testid: 'go' }) }),
    );
    expect(result.classification).toBe('ready');
    expect(result.blocking).toBe(false);
    expect(result.currentBestSelector).toBe('go');
  });
});

describe('NeedsTestIdReportAgent._applySuggestions', () => {
  function classified(id: string): ClassifiedComponent {
    return {
      componentId: id,
      page: '/login',
      ariaRole: 'button',
      ariaName: 'Submit',
      label: 'Submit',
      interactedByUser: true,
      userAction: 'click',
      currentBestSelector: '.btn',
      selectorQuality: 'text-based',
      classification: 'needs-attention',
      blocking: true,
      suggestion: null,
    };
  }

  const apply = (text: string, list: ClassifiedComponent[]): void =>
    makeAgent()['_applySuggestions'](text, list);

  it('attaches a suggestion matched by component id', () => {
    const list = [classified('cmp-1')];
    apply('[{"id":"cmp-1","suggestedTestId":"login-submit","reason":"purpose"}]', list);

    expect(list[0]?.suggestion).toEqual({
      suggestedTestId: 'login-submit',
      reason: 'purpose',
    });
  });

  it('extracts the JSON array out of surrounding prose', () => {
    const list = [classified('cmp-1')];
    apply('Sure!\n[{"id":"cmp-1","suggestedTestId":"a","reason":"b"}]\nHope that helps.', list);

    expect(list[0]?.suggestion?.suggestedTestId).toBe('a');
  });

  it('leaves the list untouched when the response has no array', () => {
    const list = [classified('cmp-1')];
    apply('I could not determine any ids.', list);

    expect(list[0]?.suggestion).toBeNull();
  });

  it('ignores entries whose id matches nothing in the list', () => {
    const list = [classified('cmp-1')];
    apply('[{"id":"other","suggestedTestId":"x","reason":"y"}]', list);

    expect(list[0]?.suggestion).toBeNull();
  });

  it('skips an entry with an empty suggestedTestId', () => {
    const list = [classified('cmp-1')];
    apply('[{"id":"cmp-1","suggestedTestId":"","reason":"y"}]', list);

    expect(list[0]?.suggestion).toBeNull();
  });

  it('defaults a missing reason to an empty string', () => {
    const list = [classified('cmp-1')];
    apply('[{"id":"cmp-1","suggestedTestId":"only-id"}]', list);

    expect(list[0]?.suggestion).toEqual({ suggestedTestId: 'only-id', reason: '' });
  });

  it('applies suggestions across several components independently', () => {
    const list = [classified('a'), classified('b'), classified('c')];
    apply(
      '[{"id":"a","suggestedTestId":"id-a","reason":"ra"},{"id":"c","suggestedTestId":"id-c","reason":"rc"}]',
      list,
    );

    expect(list[0]?.suggestion?.suggestedTestId).toBe('id-a');
    expect(list[1]?.suggestion).toBeNull();
    expect(list[2]?.suggestion?.suggestedTestId).toBe('id-c');
  });

  it('propagates a parse error for a malformed array', () => {
    const list = [classified('cmp-1')];
    // The regex matches, but the content is not valid JSON — JSON.parse throws.
    expect(() => apply('[{"id": broken}]', list)).toThrow();
  });
});
