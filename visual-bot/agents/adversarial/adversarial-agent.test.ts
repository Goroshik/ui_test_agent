import { describe, it, expect } from 'vitest';
import { AdversarialAgent } from './adversarial-agent.js';
import type {
  ComponentRecord,
  ComponentRegistry,
  ValidationConstraints,
} from '../../pipeline/types.js';

interface PageStateLike {
  url: string;
  alertTexts: string[];
  invalidFieldCount: number;
}

function constraints(overrides: Partial<ValidationConstraints> = {}): ValidationConstraints {
  return {
    required: false,
    disabled: false,
    readonly: false,
    inputType: null,
    minLength: null,
    maxLength: null,
    min: null,
    max: null,
    step: null,
    pattern: null,
    ...overrides,
  };
}

function record(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: 'cmp-1',
    label: 'Email',
    componentType: 'textbox',
    pages: ['/login'],
    lastSeen: '2026-01-01T00:00:00.000Z',
    selectors: { preferred: '#email', aria: '', testid: null, css: null, xpath: null },
    actions: [],
    states: {},
    assertions: { pre_interaction: [], post_interaction: [] },
    constraints: null,
    confidence: 'high',
    seenCount: 1,
    manualOverride: false,
    notes: '',
    ...overrides,
  };
}

function registry(...components: ComponentRecord[]): ComponentRegistry {
  return {
    version: '1.0',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    components: Object.fromEntries(components.map((c) => [c.id, c])),
  };
}

function state(overrides: Partial<PageStateLike> = {}): PageStateLike {
  return { url: 'https://app.test/login', alertTexts: [], invalidFieldCount: 0, ...overrides };
}

describe('AdversarialAgent._describeExpectation', () => {
  const describeExpectation = (
    urlChanged: boolean,
    after: PageStateLike,
    status: number | null,
  ): string => new AdversarialAgent()['_describeExpectation'](urlChanged, after, status);

  it('reports acceptance when the url changed', () => {
    expect(describeExpectation(true, state(), null)).toContain('app accepted the input');
  });

  it('prefers navigation over every other signal', () => {
    const result = describeExpectation(true, state({ alertTexts: ['bad email'], invalidFieldCount: 2 }), 500);
    expect(result).toContain('navigation occurred');
  });

  it('quotes the first alert text when one is present', () => {
    expect(describeExpectation(false, state({ alertTexts: ['Email is invalid'] }), null)).toBe(
      'validation error shown: "Email is invalid"',
    );
  });

  it('uses only the first of several alert texts', () => {
    expect(describeExpectation(false, state({ alertTexts: ['first', 'second'] }), null)).toContain('"first"');
  });

  it('prefers an alert over an invalid-field count', () => {
    const result = describeExpectation(false, state({ alertTexts: ['boom'], invalidFieldCount: 3 }), null);
    expect(result).toContain('validation error shown');
  });

  it('reports an invalid field when there is no alert', () => {
    expect(describeExpectation(false, state({ invalidFieldCount: 1 }), null)).toContain(
      'field marked invalid',
    );
  });

  it('prefers an invalid field over a server status', () => {
    expect(describeExpectation(false, state({ invalidFieldCount: 1 }), 422)).toContain(
      'field marked invalid',
    );
  });

  it('reports a server rejection for a 4xx status', () => {
    expect(describeExpectation(false, state(), 422)).toBe('server rejected with 422');
  });

  it('reports a server rejection for a 5xx status', () => {
    expect(describeExpectation(false, state(), 500)).toBe('server rejected with 500');
  });

  it('does not treat a 2xx or 3xx status as a rejection', () => {
    expect(describeExpectation(false, state(), 200)).toContain('silent rejection');
    expect(describeExpectation(false, state(), 302)).toContain('silent rejection');
  });

  it('falls back to silent rejection when nothing is observable', () => {
    expect(describeExpectation(false, state(), null)).toBe(
      'form not submitted, no visible error (silent rejection)',
    );
  });

  it('treats status 0 as no status rather than a rejection', () => {
    expect(describeExpectation(false, state(), 0)).toContain('silent rejection');
  });
});

describe('AdversarialAgent._inputsByPage', () => {
  const inputsByPage = (
    reg: ComponentRegistry,
  ): Map<string, { inputs: ComponentRecord[]; submit: ComponentRecord | null }> =>
    new AdversarialAgent()['_inputsByPage'](reg);

  it('returns an empty map when nothing is constrained', () => {
    expect(inputsByPage(registry(record())).size).toBe(0);
  });

  it('collects a constrained textbox', () => {
    const input = record({ constraints: constraints({ required: true }) });
    const result = inputsByPage(registry(input));

    expect(result.size).toBe(1);
    expect(result.get('/login')?.inputs).toEqual([input]);
  });

  it('groups inputs by their first page', () => {
    const a = record({ id: 'a', constraints: constraints(), pages: ['/login'] });
    const b = record({ id: 'b', constraints: constraints(), pages: ['/signup'] });
    const result = inputsByPage(registry(a, b));

    expect([...result.keys()].sort()).toEqual(['/login', '/signup']);
  });

  it('accumulates several inputs on one page', () => {
    const a = record({ id: 'a', constraints: constraints() });
    const b = record({ id: 'b', constraints: constraints() });
    expect(inputsByPage(registry(a, b)).get('/login')?.inputs).toHaveLength(2);
  });

  it('defaults a component with no pages to "/"', () => {
    const input = record({ constraints: constraints(), pages: [] });
    expect(inputsByPage(registry(input)).has('/')).toBe(true);
  });

  it('includes a non-textbox component when it has an inputType', () => {
    const input = record({
      componentType: 'combobox',
      constraints: constraints({ inputType: 'email' }),
    });
    expect(inputsByPage(registry(input)).size).toBe(1);
  });

  it('excludes a non-textbox component whose constraints carry no inputType', () => {
    const input = record({ componentType: 'button', constraints: constraints() });
    expect(inputsByPage(registry(input)).size).toBe(0);
  });

  it('attaches a submit button found by label', () => {
    const input = record({ id: 'i', constraints: constraints() });
    const submit = record({ id: 's', label: 'Sign in', componentType: 'button' });

    expect(inputsByPage(registry(input, submit)).get('/login')?.submit).toEqual(submit);
  });

  // The label regex covers these phrasings.
  for (const label of ['Sign in', 'Log in', 'Login', 'Submit', 'Continue', 'Next', 'Save']) {
    it(`recognizes a submit button labelled "${label}"`, () => {
      const input = record({ id: 'i', constraints: constraints() });
      const submit = record({ id: 's', label, componentType: 'button' });
      expect(inputsByPage(registry(input, submit)).get('/login')?.submit?.id).toBe('s');
    });
  }

  it('recognizes a submit button by its network action rather than its label', () => {
    const input = record({ id: 'i', constraints: constraints() });
    const submit = record({
      id: 's',
      label: 'Go',
      componentType: 'button',
      actions: [{ type: 'click', network: { method: 'POST', urlPattern: '/api/login', expectedStatus: 200 } }],
    });

    expect(inputsByPage(registry(input, submit)).get('/login')?.submit?.id).toBe('s');
  });

  it('leaves submit null when no candidate matches', () => {
    const input = record({ id: 'i', constraints: constraints() });
    const other = record({ id: 'o', label: 'Cancel', componentType: 'button' });

    expect(inputsByPage(registry(input, other)).get('/login')?.submit).toBeNull();
  });

  it('does not borrow a submit button from a different page', () => {
    const input = record({ id: 'i', constraints: constraints(), pages: ['/login'] });
    const submit = record({ id: 's', label: 'Submit', componentType: 'button', pages: ['/other'] });

    expect(inputsByPage(registry(input, submit)).get('/login')?.submit).toBeNull();
  });

  it('returns an empty map for an empty registry', () => {
    expect(inputsByPage(registry()).size).toBe(0);
  });
});
