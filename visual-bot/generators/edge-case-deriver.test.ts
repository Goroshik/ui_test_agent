import { describe, it, expect } from 'vitest';
import { deriveEdgeCases } from './edge-case-deriver.js';
import type { ComponentRecord, ValidationConstraints } from '../pipeline/types.js';

function makeConstraints(overrides: Partial<ValidationConstraints> = {}): ValidationConstraints {
  return {
    required: false,
    disabled: false,
    readonly: false,
    inputType: 'text',
    minLength: null,
    maxLength: null,
    min: null,
    max: null,
    step: null,
    pattern: null,
    ...overrides,
  };
}

function makeComponent(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: 'login__email',
    label: 'Email input',
    componentType: 'textbox',
    pages: ['/login'],
    lastSeen: new Date().toISOString(),
    selectors: { preferred: '[data-testid="email"]', aria: '', testid: 'email', css: null, xpath: null },
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

describe('deriveEdgeCases', () => {
  it('returns no constraint-based cases when there are no constraints', () => {
    const cases = deriveEdgeCases(makeComponent({ constraints: null }));
    expect(cases).toEqual([]);
  });

  it('skips constraint-derived cases entirely for non-text-like input types', () => {
    const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ inputType: 'checkbox' }) }));
    expect(cases).toEqual([]);
  });

  it('treats a missing inputType (null) as text-like, not as an unknown type to skip', () => {
    const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ inputType: null }) }));
    expect(cases.find((c) => c.type === 'xss-injection')).toBeDefined();
  });

  describe('required / length constraints', () => {
    it('derives a required-empty case with the exact guidance text the test generator prompts on', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ required: true }) }));
      const required = cases.find((c) => c.type === 'required-empty');
      expect(required).toMatchObject({
        action: 'fill',
        input: '',
        expected: 'validation error — field is required, form not submitted',
        source: 'dom-constraint',
      });
    });

    it('does not derive a required-empty case when the field is optional', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ required: false }) }));
      expect(cases.filter((c) => c.type === 'required-empty')).toEqual([]);
    });

    it('derives a maxlength-exceeded case one character past the limit, with matching guidance text', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ maxLength: 5 }) }));
      const c = cases.find((x) => x.type === 'maxlength-exceeded');
      expect(c).toMatchObject({
        action: 'fill',
        input: 'aaaaaa', // maxLength + 1 chars
        expected: 'input truncated to 5 chars or rejected',
        description: 'Email input maxlength=5 → 6 chars',
        source: 'dom-constraint',
      });
    });

    it('ignores a non-positive maxLength', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ maxLength: 0 }) }));
      expect(cases.filter((x) => x.type === 'maxlength-exceeded')).toEqual([]);
    });

    it('derives a minlength-short case one character under the limit, with matching guidance text', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ minLength: 4 }) }));
      const c = cases.find((x) => x.type === 'minlength-short');
      expect(c).toMatchObject({
        input: 'aaa', // minLength - 1 chars
        expected: 'validation error — too short',
        description: 'Email input minlength=4 → 3 chars',
      });
    });

    it('does not derive a minlength-short case when minLength is 1 or less', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ minLength: 1 }) }));
      expect(cases.filter((x) => x.type === 'minlength-short')).toEqual([]);
    });
  });

  describe('typed inputs (email / url / number / pattern)', () => {
    it('derives four invalid-email cases for an email input', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ inputType: 'email' }) }));
      const emails = cases.filter((c) => c.type === 'invalid-email');
      expect(emails).toHaveLength(4);
      expect(emails.map((c) => c.input)).toContain('missing@tld');
    });

    it('does not derive invalid-email cases for a non-email input', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ inputType: 'text' }) }));
      expect(cases.find((c) => c.type === 'invalid-email')).toBeUndefined();
    });

    it('derives an invalid-url case for a url input', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ inputType: 'url' }) }));
      expect(cases.find((c) => c.type === 'invalid-url')).toBeDefined();
    });

    it('derives out-of-range cases at min-1 and max+1 for a number input', () => {
      const cases = deriveEdgeCases(
        makeComponent({ constraints: makeConstraints({ inputType: 'number', min: '10', max: '20' }) }),
      );
      const ranges = cases.filter((c) => c.type === 'out-of-range');
      expect(ranges.map((c) => c.input).sort()).toEqual(['21', '9']);
    });

    it('always derives a wrong-type case for a number input, and skips the static XSS catalog', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ inputType: 'number' }) }));
      expect(cases.find((c) => c.type === 'wrong-type')).toBeDefined();
      expect(cases.find((c) => c.type === 'xss-injection')).toBeUndefined();
    });

    it('derives a pattern-mismatch case when a pattern is set', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ pattern: '^[0-9]+$' }) }));
      expect(cases.find((c) => c.type === 'pattern-mismatch')).toBeDefined();
    });
  });

  describe('static catalog', () => {
    it('derives an xss-injection case for any non-number text-like input', () => {
      const cases = deriveEdgeCases(makeComponent({ constraints: makeConstraints() }));
      const xss = cases.find((c) => c.type === 'xss-injection');
      expect(xss?.input).toBe('<script>alert(1)</script>');
    });

    it('derives a whitespace-only case only when the field is required', () => {
      const requiredCases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ required: true }) }));
      expect(requiredCases.find((c) => c.type === 'whitespace-only')).toBeDefined();

      const optionalCases = deriveEdgeCases(makeComponent({ constraints: makeConstraints({ required: false }) }));
      expect(optionalCases.find((c) => c.type === 'whitespace-only')).toBeUndefined();
    });
  });

  describe('state-derived cases', () => {
    it('derives a disabled case from states.disabled_when', () => {
      const cases = deriveEdgeCases(makeComponent({ states: { disabled_when: 'form is invalid' } }));
      const c = cases.find((x) => x.type === 'disabled');
      expect(c?.description).toContain('form is invalid');
    });

    it('derives a loading-state case from states.loading_after', () => {
      const cases = deriveEdgeCases(makeComponent({ states: { loading_after: 'submit click' } }));
      expect(cases.find((c) => c.type === 'loading-state')).toBeDefined();
    });
  });

  describe('network-observed cases', () => {
    it('derives a network-error case for an observed action, capped at one per status', () => {
      const cases = deriveEdgeCases(
        makeComponent({
          actions: [
            { type: 'click', network: { method: 'POST', urlPattern: '/api/login', expectedStatus: 200 } },
          ],
        }),
      );
      const errors = cases.filter((c) => c.type === 'network-error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        action: 'click',
        expected: 'error message shown, UI recoverable, no crash',
        description: 'POST /api/login → 500',
        source: 'network-observed',
      });
    });

    it('derives 401/422 cases for mutating HTTP methods but not for GET', () => {
      const mutating = deriveEdgeCases(
        makeComponent({
          actions: [{ type: 'click', network: { method: 'POST', urlPattern: '/api/x', expectedStatus: 200 } }],
        }),
      );
      const statuses = mutating.filter((c) => c.type === 'network-status');
      expect(statuses).toHaveLength(2);
      const case401 = statuses.find((c) => c.description === 'POST /api/x → 401');
      const case422 = statuses.find((c) => c.description === 'POST /api/x → 422');
      expect(case401).toMatchObject({ expected: 'app handles 401 gracefully', source: 'network-observed' });
      expect(case422).toMatchObject({ expected: 'app handles 422 gracefully', source: 'network-observed' });

      const readOnly = deriveEdgeCases(
        makeComponent({
          actions: [{ type: 'click', network: { method: 'GET', urlPattern: '/api/x', expectedStatus: 200 } }],
        }),
      );
      expect(readOnly.filter((c) => c.type === 'network-status')).toHaveLength(0);
    });

    it('dedupes identical cases produced by multiple actions', () => {
      const action = { type: 'click' as const, network: { method: 'POST', urlPattern: '/api/x', expectedStatus: 200 } };
      const cases = deriveEdgeCases(makeComponent({ actions: [action, action] }));
      const errors = cases.filter((c) => c.type === 'network-error');
      expect(errors).toHaveLength(1);
    });

    it('ignores actions with no observed network call', () => {
      const cases = deriveEdgeCases(makeComponent({ actions: [{ type: 'click' }] }));
      expect(cases.filter((c) => c.source === 'network-observed')).toHaveLength(0);
    });
  });
});
