import type {
  ComponentRecord,
  ValidationConstraints,
} from '../pipeline/types.js';
import type { TestEdgeCase } from './test-planner.js';

/**
 * Derives GROUNDED edge cases from real evidence — DOM validation constraints
 * and observed network calls — instead of LLM guesses.
 *
 * Sources:
 *  1. component.constraints       → input-validation cases (required, maxlength…)
 *  2. component.actions[].network → real method/url/status the API was seen with
 *
 * A small static catalog (XSS/whitespace) is added for text inputs since those
 * are app-agnostic and almost always worth covering.
 */
export function deriveEdgeCases(component: ComponentRecord): TestEdgeCase[] {
  const cases: TestEdgeCase[] = [];
  const c = component.constraints;
  const id = component.id;
  const label = component.label;

  if (c && isTextLike(c)) {
    cases.push(...fromConstraints(id, label, c));
    cases.push(...staticCatalog(id, label, c));
  }

  if (component.states.disabled_when) {
    cases.push({
      type: 'disabled',
      component: id,
      description: `${label} is disabled when ${component.states.disabled_when}`,
      source: 'dom-constraint',
    });
  }
  if (component.states.loading_after) {
    cases.push({
      type: 'loading-state',
      component: id,
      description: `${label} shows loading state after ${component.states.loading_after}`,
      source: 'dom-constraint',
    });
  }

  cases.push(...fromNetwork(component));

  return dedupe(cases);
}

function isTextLike(c: ValidationConstraints): boolean {
  const t = (c.inputType ?? 'text').toLowerCase();
  return ['text', 'email', 'tel', 'url', 'password', 'search', 'number', ''].includes(t);
}

function fromConstraints(
  id: string,
  label: string,
  c: ValidationConstraints,
): TestEdgeCase[] {
  const out: TestEdgeCase[] = [];
  const type = (c.inputType ?? 'text').toLowerCase();

  if (c.required) {
    out.push({
      type: 'required-empty',
      component: id,
      action: 'fill',
      input: '',
      expected: 'validation error — field is required, form not submitted',
      description: `${label} is required → submit empty must be rejected`,
      source: 'dom-constraint',
    });
  }

  if (typeof c.maxLength === 'number' && c.maxLength > 0) {
    out.push({
      type: 'maxlength-exceeded',
      component: id,
      action: 'fill',
      input: 'a'.repeat(c.maxLength + 1),
      expected: `input truncated to ${c.maxLength} chars or rejected`,
      description: `${label} maxlength=${c.maxLength} → ${c.maxLength + 1} chars`,
      source: 'dom-constraint',
    });
  }

  if (typeof c.minLength === 'number' && c.minLength > 1) {
    out.push({
      type: 'minlength-short',
      component: id,
      action: 'fill',
      input: 'a'.repeat(c.minLength - 1),
      expected: 'validation error — too short',
      description: `${label} minlength=${c.minLength} → ${c.minLength - 1} chars`,
      source: 'dom-constraint',
    });
  }

  if (type === 'email') {
    for (const bad of ['plainaddress', 'missing@tld', '@no-local.com', 'spaces in@x.com']) {
      out.push({
        type: 'invalid-email',
        component: id,
        action: 'fill',
        input: bad,
        expected: 'validation error — invalid email',
        description: `${label} rejects invalid email "${bad}"`,
        source: 'dom-constraint',
      });
    }
  }

  if (type === 'url') {
    out.push({
      type: 'invalid-url',
      component: id,
      action: 'fill',
      input: 'not a url',
      expected: 'validation error — invalid URL',
      description: `${label} rejects malformed URL`,
      source: 'dom-constraint',
    });
  }

  if (type === 'number') {
    if (c.min !== null) {
      out.push({
        type: 'out-of-range',
        component: id,
        action: 'fill',
        input: String(Number(c.min) - 1),
        expected: `value below min ${c.min} rejected`,
        description: `${label} min=${c.min} → ${Number(c.min) - 1}`,
        source: 'dom-constraint',
      });
    }
    if (c.max !== null) {
      out.push({
        type: 'out-of-range',
        component: id,
        action: 'fill',
        input: String(Number(c.max) + 1),
        expected: `value above max ${c.max} rejected`,
        description: `${label} max=${c.max} → ${Number(c.max) + 1}`,
        source: 'dom-constraint',
      });
    }
    out.push({
      type: 'wrong-type',
      component: id,
      action: 'fill',
      input: 'abc',
      expected: 'non-numeric input rejected or ignored',
      description: `${label} is numeric → reject letters`,
      source: 'dom-constraint',
    });
  }

  if (c.pattern) {
    out.push({
      type: 'pattern-mismatch',
      component: id,
      action: 'fill',
      input: '!!!invalid!!!',
      expected: `value not matching /${c.pattern}/ rejected`,
      description: `${label} pattern=${c.pattern} → mismatching value`,
      source: 'dom-constraint',
    });
  }

  return out;
}

function staticCatalog(
  id: string,
  label: string,
  c: ValidationConstraints,
): TestEdgeCase[] {
  const type = (c.inputType ?? 'text').toLowerCase();
  if (type === 'number') return []; // not relevant for numeric inputs
  const out: TestEdgeCase[] = [];

  if (c.required) {
    out.push({
      type: 'whitespace-only',
      component: id,
      action: 'fill',
      input: '   ',
      expected: 'treated as empty — validation error',
      description: `${label} whitespace-only should be rejected like empty`,
      source: 'static-catalog',
    });
  }

  out.push({
    type: 'xss-injection',
    component: id,
    action: 'fill',
    input: '<script>alert(1)</script>',
    expected: 'value escaped, no script execution',
    description: `${label} must not execute injected script`,
    source: 'static-catalog',
  });

  return out;
}

function fromNetwork(component: ComponentRecord): TestEdgeCase[] {
  const out: TestEdgeCase[] = [];
  const id = component.id;
  const seenStatuses = new Set<number>();

  for (const action of component.actions) {
    const net = action.network;
    if (!net) continue;

    // Always cover a 500 for the observed call (real method + url).
    if (!seenStatuses.has(500)) {
      seenStatuses.add(500);
      out.push({
        type: 'network-error',
        component: id,
        action: action.type,
        expected: 'error message shown, UI recoverable, no crash',
        description: `${net.method} ${net.urlPattern} → 500`,
        source: 'network-observed',
      });
    }

    // For auth/mutating calls, also cover the real-world 401/422.
    if (/POST|PUT|PATCH|DELETE/i.test(net.method)) {
      for (const status of [401, 422]) {
        if (seenStatuses.has(status)) continue;
        seenStatuses.add(status);
        out.push({
          type: 'network-status',
          component: id,
          action: action.type,
          expected: `app handles ${status} gracefully`,
          description: `${net.method} ${net.urlPattern} → ${status}`,
          source: 'network-observed',
        });
      }
    }
  }

  return out;
}

function dedupe(cases: TestEdgeCase[]): TestEdgeCase[] {
  const seen = new Set<string>();
  const out: TestEdgeCase[] = [];
  for (const c of cases) {
    const key = `${c.type}|${c.component}|${c.input ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
