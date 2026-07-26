import { describe, it, expect } from 'vitest';
import { TestGenerator } from './test-generator.js';
import type { ComponentRecord, StepRecord } from '../pipeline/types.js';

function step(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    stepId: 'step-001',
    stepIndex: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    url: 'https://app.test/login',
    action: { type: 'click', description: 'click Submit' },
    before: null,
    after: null,
    status: 'complete',
    ...overrides,
  };
}

function record(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: 'cmp-1',
    label: 'Submit Button',
    componentType: 'button',
    pages: ['/login'],
    lastSeen: '2026-01-01T00:00:00.000Z',
    selectors: { preferred: '#s', aria: '', testid: '[data-testid="submit"]', css: null, xpath: null },
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

const buildLine = (s: StepRecord, i: number, components: ComponentRecord[]): string =>
  new TestGenerator()['_buildFallbackStepLine'](s, i, components);

describe('TestGenerator._buildFallbackStepLine', () => {
  it('emits a click line with a resolved SELECTORS reference', () => {
    const s = step({ action: { type: 'click', description: 'click Submit', element: { testid: 'submit' } } });
    const line = buildLine(s, 0, [record()]);

    expect(line).toContain('// STEP 1: click Submit');
    expect(line).toContain('SELECTORS.LOGIN.SUBMIT_BUTTON');
    expect(line).toContain(".should('be.visible').click()");
  });

  it('emits a fill line that clears then types the recorded value', () => {
    const s = step({
      action: { type: 'fill', description: 'type email', value: 'a@b.co', element: { testid: 'submit' } },
    });
    const line = buildLine(s, 1, [record()]);

    expect(line).toContain('// STEP 2: type email');
    expect(line).toContain('.clear().type("a@b.co")');
  });

  it('JSON-encodes the typed value so quotes are escaped', () => {
    const s = step({
      action: { type: 'fill', description: 'd', value: 'say "hi"', element: { testid: 'submit' } },
    });
    expect(buildLine(s, 0, [record()])).toContain('.type("say \\"hi\\"")');
  });

  it('types an empty string when a fill step has no value', () => {
    const s = step({ action: { type: 'fill', description: 'd', element: { testid: 'submit' } } });
    expect(buildLine(s, 0, [record()])).toContain('.type("")');
  });

  it('emits a comment-only line for any other action type', () => {
    const s = step({ action: { type: 'hover', description: 'hover the menu' } });
    expect(buildLine(s, 2, [])).toBe('    // STEP 3: hover the menu');
  });

  it('falls back to a TODO placeholder when no component matches', () => {
    const s = step({ action: { type: 'click', description: 'd', element: { testid: 'unknown' } } });
    expect(buildLine(s, 0, [record()])).toContain('/* TODO: selector for step 1 */');
  });

  it('falls back to a TODO when the step element has no testid', () => {
    const s = step({ action: { type: 'click', description: 'd' } });
    expect(buildLine(s, 4, [record()])).toContain('/* TODO: selector for step 5 */');
  });

  it('falls back to a TODO when the component has no testid selector', () => {
    const noTestid = record({
      selectors: { preferred: '#s', aria: '', testid: null, css: '.btn', xpath: null },
    });
    const s = step({ action: { type: 'click', description: 'd', element: { testid: 'submit' } } });

    expect(buildLine(s, 0, [noTestid])).toContain('/* TODO');
  });

  it('matches a component whose testid selector contains the step testid', () => {
    const s = step({ action: { type: 'click', description: 'd', element: { testid: 'submit' } } });
    expect(buildLine(s, 0, [record()])).toContain('SELECTORS.LOGIN.SUBMIT_BUTTON');
  });

  it('uses the HOME namespace for a root-page component', () => {
    const rootComp = record({ pages: ['/'] });
    const s = step({ action: { type: 'click', description: 'd', element: { testid: 'submit' } } });

    expect(buildLine(s, 0, [rootComp])).toContain('SELECTORS.HOME.');
  });

  it('uses the HOME namespace when the component lists no pages', () => {
    const noPages = record({ pages: [] });
    const s = step({ action: { type: 'click', description: 'd', element: { testid: 'submit' } } });

    expect(buildLine(s, 0, [noPages])).toContain('SELECTORS.HOME.');
  });

  it('numbers steps from 1 even though the index is 0-based', () => {
    const s = step({ action: { type: 'hover', description: 'd' } });
    expect(buildLine(s, 0, [])).toContain('STEP 1');
    expect(buildLine(s, 9, [])).toContain('STEP 10');
  });
});
