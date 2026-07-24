import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type OpenAI from 'openai';
import { IdentityResolutionAgent } from './identity-resolution-agent.js';
import type {
  AriaComponent,
  ComponentAction,
  ComponentRecord,
  DomComponent,
  PageRegistry,
  ValidationConstraints,
} from '../../pipeline/types.js';

/** ValidationConstraints has no optional fields, so tests need a full base. */
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

/** Shape of the private AnchorEntry, which the module does not export. */
interface Anchor {
  stepId: string;
  url: string;
  testid?: string | null;
  ariaRole?: string | null;
  ariaName?: string | null;
  tagName?: string | null;
  text?: string | null;
  ref?: string | null;
  actionType: string;
  value?: string;
  constraints?: ValidationConstraints | null;
}

type Confidence = 'high' | 'medium' | 'low';

interface Match {
  aria: AriaComponent | null;
  dom: DomComponent | null;
  network: null;
  confidence: Confidence;
}

/** Most helpers under test never touch the client; _llmResolve gets a stub. */
function makeAgent(create?: () => Promise<unknown>): IdentityResolutionAgent {
  const client = {
    chat: { completions: { create: create ?? ((): Promise<unknown> => Promise.reject(new Error('no llm'))) } },
  } as unknown as OpenAI;
  return new IdentityResolutionAgent(client, 'test-model');
}

function anchor(overrides: Partial<Anchor> = {}): Anchor {
  return { stepId: 'step-001', url: 'https://app.test/login', actionType: 'click', ...overrides };
}

function aria(overrides: Partial<AriaComponent> = {}): AriaComponent {
  return {
    ariaRole: 'button',
    ariaName: 'Submit',
    state: {},
    context: '',
    pageUrl: 'https://app.test/login',
    stepId: 'step-001',
    ...overrides,
  };
}

function dom(overrides: Partial<DomComponent> = {}): DomComponent {
  return {
    tagName: 'button',
    pageUrl: 'https://app.test/login',
    stepId: 'step-001',
    ...overrides,
  };
}

function match(overrides: Partial<Match> = {}): Match {
  return { aria: null, dom: null, network: null, confidence: 'high', ...overrides };
}

function componentRecord(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: 'login-submit-abc123',
    label: 'Submit',
    componentType: 'button',
    pages: ['/login'],
    lastSeen: '2026-01-01T00:00:00.000Z',
    selectors: { preferred: '#a', aria: '', testid: null, css: null, xpath: null },
    actions: [],
    states: {},
    assertions: { pre_interaction: [], post_interaction: [] },
    constraints: null,
    confidence: 'medium',
    seenCount: 1,
    manualOverride: false,
    notes: '',
    ...overrides,
  };
}

describe('IdentityResolutionAgent._matchAria', () => {
  const run = (a: Anchor, list: AriaComponent[]): { match: AriaComponent | null; confidence: Confidence } =>
    makeAgent()['_matchAria'](a, list);

  it('matches role+name with high confidence', () => {
    const target = aria();
    const result = run(anchor({ ariaRole: 'button', ariaName: 'Submit' }), [target]);
    expect(result).toEqual({ match: target, confidence: 'high' });
  });

  it('falls back to a name-only match with medium confidence', () => {
    const target = aria({ ariaRole: 'link' });
    const result = run(anchor({ ariaRole: 'button', ariaName: 'Submit' }), [target]);
    expect(result).toEqual({ match: target, confidence: 'medium' });
  });

  it('matches on name alone when the anchor has no role', () => {
    const target = aria();
    expect(run(anchor({ ariaName: 'Submit' }), [target]).confidence).toBe('medium');
  });

  it('returns low confidence and no match when nothing matches', () => {
    expect(run(anchor({ ariaName: 'Missing' }), [aria()])).toEqual({
      match: null,
      confidence: 'low',
    });
  });

  it('returns low confidence when the anchor has no aria name at all', () => {
    expect(run(anchor(), [aria()])).toEqual({ match: null, confidence: 'low' });
  });

  it('returns low confidence for an empty candidate list', () => {
    expect(run(anchor({ ariaRole: 'button', ariaName: 'Submit' }), [])).toEqual({
      match: null,
      confidence: 'low',
    });
  });

  it('prefers the strong role+name match over an earlier name-only candidate', () => {
    const weak = aria({ ariaRole: 'link' });
    const strong = aria({ ariaRole: 'button' });
    const result = run(anchor({ ariaRole: 'button', ariaName: 'Submit' }), [weak, strong]);
    expect(result).toEqual({ match: strong, confidence: 'high' });
  });
});

describe('IdentityResolutionAgent._matchDom', () => {
  const run = (a: Anchor, list: DomComponent[]): { match: DomComponent | null; confidence: Confidence } =>
    makeAgent()['_matchDom'](a, list);

  it('matches on testid with high confidence', () => {
    const target = dom({ testid: 'submit-btn' });
    expect(run(anchor({ testid: 'submit-btn' }), [target])).toEqual({
      match: target,
      confidence: 'high',
    });
  });

  it('matches on tagName+text with medium confidence', () => {
    const target = dom({ tagName: 'button', text: 'Go' });
    expect(run(anchor({ tagName: 'button', text: 'Go' }), [target])).toEqual({
      match: target,
      confidence: 'medium',
    });
  });

  it('requires both tagName and text for the tag/text branch', () => {
    const target = dom({ tagName: 'button', text: 'Go' });
    expect(run(anchor({ tagName: 'button' }), [target]).match).toBeNull();
  });

  it('matches on ariaLabel with medium confidence', () => {
    const target = dom({ ariaLabel: 'Submit' });
    expect(run(anchor({ ariaName: 'Submit' }), [target])).toEqual({
      match: target,
      confidence: 'medium',
    });
  });

  it('prefers a testid match over a tag/text match', () => {
    const byText = dom({ tagName: 'button', text: 'Go' });
    const byTestid = dom({ testid: 'submit-btn' });
    const result = run(anchor({ testid: 'submit-btn', tagName: 'button', text: 'Go' }), [
      byText,
      byTestid,
    ]);
    expect(result.match).toBe(byTestid);
    expect(result.confidence).toBe('high');
  });

  it('prefers tag/text over ariaLabel', () => {
    const byAria = dom({ ariaLabel: 'Submit' });
    const byText = dom({ tagName: 'button', text: 'Go' });
    const result = run(anchor({ tagName: 'button', text: 'Go', ariaName: 'Submit' }), [
      byAria,
      byText,
    ]);
    expect(result.match).toBe(byText);
  });

  it('returns low confidence when nothing matches', () => {
    expect(run(anchor({ testid: 'nope' }), [dom()])).toEqual({ match: null, confidence: 'low' });
  });

  it('returns low confidence for an empty candidate list', () => {
    expect(run(anchor({ testid: 'x' }), [])).toEqual({ match: null, confidence: 'low' });
  });
});

describe('IdentityResolutionAgent._resolvePreferredSelector', () => {
  interface Parts {
    testidSel: string | null;
    domCss: string | null;
    domKind: string | null;
    aria: string;
    ref: string | null | undefined;
  }

  const resolve = (parts: Parts): string => makeAgent()['_resolvePreferredSelector'](parts);

  const base: Parts = { testidSel: null, domCss: null, domKind: null, aria: '', ref: null };

  it('prefers the testid selector above all', () => {
    expect(
      resolve({ ...base, testidSel: '[data-testid="a"]', domCss: '#b', domKind: 'id', aria: 'button[name="c"]' }),
    ).toBe('[data-testid="a"]');
  });

  // RELIABLE_CSS_KINDS = testid, id, aria, css
  for (const kind of ['testid', 'id', 'aria', 'css']) {
    it(`uses css from the reliable kind "${kind}" over an aria locator`, () => {
      expect(resolve({ ...base, domCss: '#stable', domKind: kind, aria: 'button[name="x"]' })).toBe(
        '#stable',
      );
    });
  }

  it('does not treat the "text" selector kind as reliable', () => {
    expect(resolve({ ...base, domCss: '.by-text', domKind: 'text', aria: 'button[name="x"]' })).toBe(
      'button[name="x"]',
    );
  });

  it('does not treat the "none" selector kind as reliable', () => {
    expect(resolve({ ...base, domCss: '.x', domKind: 'none', aria: 'button[name="x"]' })).toBe(
      'button[name="x"]',
    );
  });

  it('requires a domKind for css to be considered reliable', () => {
    expect(resolve({ ...base, domCss: '#stable', domKind: null, aria: 'button[name="x"]' })).toBe(
      'button[name="x"]',
    );
  });

  it('falls back to any css when there is no aria locator', () => {
    expect(resolve({ ...base, domCss: '.unreliable', domKind: 'text' })).toBe('.unreliable');
  });

  it('falls back to a ref-based selector as a last resort', () => {
    expect(resolve({ ...base, ref: 'e42' })).toBe('[data-ref="e42"]');
  });

  it('emits an empty ref selector when the ref is missing', () => {
    expect(resolve({ ...base, ref: null })).toBe('[data-ref=""]');
    expect(resolve({ ...base, ref: undefined })).toBe('[data-ref=""]');
  });
});

describe('IdentityResolutionAgent._parseLlmResolveResponse', () => {
  const parse = (text: string): { ariaIndex: number | null; domIndex: number | null } =>
    makeAgent()['_parseLlmResolveResponse'](text);

  it('reads both indices out of a clean object', () => {
    expect(
      parse('{"ariaMatch":{"index":1,"confidence":"high"},"domMatch":{"index":2,"confidence":"high"}}'),
    ).toEqual({ ariaIndex: 1, domIndex: 2 });
  });

  it('extracts the object from surrounding prose', () => {
    expect(parse('Result:\n{"ariaMatch":{"index":0,"confidence":"x"}}\ndone')).toEqual({
      ariaIndex: 0,
      domIndex: null,
    });
  });

  it('returns nulls when no object is present', () => {
    expect(parse('nothing here')).toEqual({ ariaIndex: null, domIndex: null });
  });

  it('returns nulls for empty input', () => {
    expect(parse('')).toEqual({ ariaIndex: null, domIndex: null });
  });

  it('nulls a missing domMatch', () => {
    expect(parse('{"ariaMatch":{"index":3,"confidence":"h"}}')).toEqual({
      ariaIndex: 3,
      domIndex: null,
    });
  });

  it('nulls a missing ariaMatch', () => {
    expect(parse('{"domMatch":{"index":4,"confidence":"h"}}')).toEqual({
      ariaIndex: null,
      domIndex: 4,
    });
  });

  it('preserves index 0 rather than coercing it to null', () => {
    expect(parse('{"ariaMatch":{"index":0,"confidence":"h"},"domMatch":{"index":0,"confidence":"h"}}')).toEqual(
      { ariaIndex: 0, domIndex: 0 },
    );
  });

  it('throws on a malformed object body', () => {
    expect(() => parse('{ariaMatch: oops}')).toThrow();
  });
});

describe('IdentityResolutionAgent._llmResolve', () => {
  const call = (
    agent: IdentityResolutionAgent,
    ariaList: AriaComponent[],
    domList: DomComponent[],
  ): Promise<{ ariaIndex: number | null; domIndex: number | null }> =>
    agent['_llmResolve'](anchor(), ariaList, domList);

  it('short-circuits without calling the LLM when both lists are empty', async () => {
    const create = vi.fn(() => Promise.resolve({ choices: [] }));
    const result = await call(makeAgent(create), [], []);

    expect(result).toEqual({ ariaIndex: null, domIndex: null });
    expect(create).not.toHaveBeenCalled();
  });

  it('parses indices out of the LLM response', async () => {
    const create = vi.fn(() =>
      Promise.resolve({
        choices: [{ message: { content: '{"ariaMatch":{"index":1,"confidence":"high"}}' } }],
      }),
    );
    await expect(call(makeAgent(create), [aria(), aria()], [])).resolves.toEqual({
      ariaIndex: 1,
      domIndex: null,
    });
  });

  it('returns nulls when the LLM call rejects', async () => {
    const create = vi.fn(() => Promise.reject(new Error('llm down')));
    await expect(call(makeAgent(create), [aria()], [])).resolves.toEqual({
      ariaIndex: null,
      domIndex: null,
    });
  });

  it('returns nulls when the response has no content', async () => {
    const create = vi.fn(() => Promise.resolve({ choices: [{ message: { content: null } }] }));
    await expect(call(makeAgent(create), [aria()], [])).resolves.toEqual({
      ariaIndex: null,
      domIndex: null,
    });
  });

  it('still calls the LLM when only the dom list has candidates', async () => {
    const create = vi.fn(() =>
      Promise.resolve({ choices: [{ message: { content: '{"domMatch":{"index":0,"confidence":"h"}}' } }] }),
    );
    await expect(call(makeAgent(create), [], [dom()])).resolves.toEqual({
      ariaIndex: null,
      domIndex: 0,
    });
  });
});

describe('IdentityResolutionAgent._resolveViaLlmIfAmbiguous', () => {
  const run = (
    agent: IdentityResolutionAgent,
    candidates: { stepAria: AriaComponent[]; stepDom: DomComponent[] },
    deterministic: { aria: AriaComponent | null; dom: DomComponent | null; confidence: Confidence },
  ): Promise<{ aria: AriaComponent | null; dom: DomComponent | null }> =>
    agent['_resolveViaLlmIfAmbiguous'](anchor(), candidates, deterministic);

  it('keeps a high-confidence deterministic result without asking the LLM', async () => {
    const create = vi.fn(() => Promise.resolve({ choices: [] }));
    const detAria = aria();

    const result = await run(
      makeAgent(create),
      { stepAria: [aria()], stepDom: [dom()] },
      { aria: detAria, dom: null, confidence: 'high' },
    );

    expect(result).toEqual({ aria: detAria, dom: null });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps a medium-confidence result without asking the LLM', async () => {
    const create = vi.fn(() => Promise.resolve({ choices: [] }));
    await run(
      makeAgent(create),
      { stepAria: [aria()], stepDom: [] },
      { aria: aria(), dom: null, confidence: 'medium' },
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('does not ask the LLM when confidence is low but there are no candidates', async () => {
    const create = vi.fn(() => Promise.resolve({ choices: [] }));
    const result = await run(
      makeAgent(create),
      { stepAria: [], stepDom: [] },
      { aria: null, dom: null, confidence: 'low' },
    );

    expect(result).toEqual({ aria: null, dom: null });
    expect(create).not.toHaveBeenCalled();
  });

  it('adopts the LLM pick when deterministic matching was low confidence', async () => {
    const chosen = aria({ ariaName: 'Chosen' });
    const create = vi.fn(() =>
      Promise.resolve({
        choices: [{ message: { content: '{"ariaMatch":{"index":1,"confidence":"high"}}' } }],
      }),
    );

    const result = await run(
      makeAgent(create),
      { stepAria: [aria(), chosen], stepDom: [] },
      { aria: null, dom: null, confidence: 'low' },
    );

    expect(result.aria).toBe(chosen);
    expect(create).toHaveBeenCalledOnce();
  });

  it('falls back to the deterministic value when the LLM index is out of range', async () => {
    const fallback = aria({ ariaName: 'Fallback' });
    const create = vi.fn(() =>
      Promise.resolve({
        choices: [{ message: { content: '{"ariaMatch":{"index":99,"confidence":"high"}}' } }],
      }),
    );

    const result = await run(
      makeAgent(create),
      { stepAria: [aria()], stepDom: [] },
      { aria: fallback, dom: null, confidence: 'low' },
    );

    expect(result.aria).toBe(fallback);
  });

  it('falls back to the deterministic value when the LLM declines to pick', async () => {
    const fallbackDom = dom({ testid: 'kept' });
    const create = vi.fn(() => Promise.resolve({ choices: [{ message: { content: '{}' } }] }));

    const result = await run(
      makeAgent(create),
      { stepAria: [], stepDom: [dom()] },
      { aria: null, dom: fallbackDom, confidence: 'low' },
    );

    expect(result.dom).toBe(fallbackDom);
  });
});

describe('IdentityResolutionAgent._buildRecord', () => {
  const build = (a: Anchor, m: Match): ComponentRecord =>
    makeAgent()['_buildRecord'](a, m);

  it('labels the record from the aria name first', () => {
    const record = build(anchor({ ariaName: 'Sign in', text: 'txt', testid: 'tid' }), match());
    expect(record.label).toBe('Sign in');
  });

  it('falls back to the text, then the testid, for the label', () => {
    expect(build(anchor({ text: 'txt', testid: 'tid' }), match()).label).toBe('txt');
    expect(build(anchor({ testid: 'tid' }), match()).label).toBe('tid');
  });

  it('falls back to the generated id when nothing nameable exists', () => {
    const record = build(anchor(), match());
    expect(record.label).toBe(record.id);
  });

  it('derives componentType from the aria role, then the tag name', () => {
    expect(build(anchor({ ariaRole: 'button', tagName: 'div' }), match()).componentType).toBe('button');
    expect(build(anchor({ tagName: 'div' }), match()).componentType).toBe('div');
  });

  it('marks componentType unknown when neither role nor tag is known', () => {
    expect(build(anchor(), match()).componentType).toBe('unknown');
  });

  it('resolves the page path from the anchor url', () => {
    expect(build(anchor({ url: 'https://app.test/login' }), match()).pages).toEqual(['/login']);
  });

  it('carries the match confidence onto the record', () => {
    expect(build(anchor(), match({ confidence: 'medium' })).confidence).toBe('medium');
  });

  it('seeds the standard pre-interaction assertions', () => {
    const record = build(anchor(), match());
    expect(record.assertions.pre_interaction).toEqual(['be.visible', 'be.enabled']);
    expect(record.assertions.post_interaction).toEqual([]);
  });

  it('starts a fresh record at seenCount 1 with no manual override', () => {
    const record = build(anchor(), match());
    expect(record.seenCount).toBe(1);
    expect(record.manualOverride).toBe(false);
  });

  it('prefers anchor constraints over the matched dom constraints', () => {
    const fromAnchor = constraints({ required: true });
    const record = build(
      { ...anchor(), constraints: fromAnchor },
      match({ dom: dom({ constraints: constraints({ maxLength: 5 }) }) }),
    );
    expect(record.constraints).toEqual(fromAnchor);
  });

  it('falls back to the dom constraints when the anchor has none', () => {
    const fromDom = constraints({ maxLength: 5 });
    const record = build(anchor(), match({ dom: dom({ constraints: fromDom }) }));
    expect(record.constraints).toEqual(fromDom);
  });

  it('leaves constraints null when neither side has any', () => {
    expect(build(anchor(), match()).constraints).toBeNull();
  });

  it('builds a testid-preferred selector when a testid exists', () => {
    const record = build(anchor({ testid: 'submit-btn' }), match());
    expect(record.selectors.testid).toBe('[data-testid="submit-btn"]');
    expect(record.selectors.preferred).toBe('[data-testid="submit-btn"]');
  });

  it('builds an aria locator when role and name are both known', () => {
    const record = build(anchor({ ariaRole: 'button', ariaName: 'Submit' }), match());
    expect(record.selectors.aria).toBe('button[name="Submit"]');
  });

  it('leaves the aria locator empty when the name is missing', () => {
    expect(build(anchor({ ariaRole: 'button' }), match()).selectors.aria).toBe('');
  });

  it('records the anchor action type', () => {
    expect(build(anchor({ actionType: 'fill' }), match()).actions[0]?.type).toBe('fill');
  });

  it('attaches the action value when present', () => {
    expect(build(anchor({ actionType: 'fill', value: 'hi' }), match()).actions[0]?.value).toBe('hi');
  });

  it('omits the value key entirely when there is no value', () => {
    expect(build(anchor(), match()).actions[0]).not.toHaveProperty('value');
  });
});

describe('IdentityResolutionAgent._mergeRecord', () => {
  const merge = (existing: ComponentRecord, incoming: ComponentRecord): ComponentRecord =>
    makeAgent()['_mergeRecord'](existing, incoming);

  it('returns the existing record untouched when manualOverride is set', () => {
    const existing = componentRecord({ manualOverride: true, seenCount: 3 });
    const result = merge(existing, componentRecord({ pages: ['/other'] }));

    expect(result).toBe(existing);
    expect(result.seenCount).toBe(3);
  });

  it('increments seenCount', () => {
    expect(merge(componentRecord({ seenCount: 4 }), componentRecord()).seenCount).toBe(5);
  });

  it('unions the page lists without duplicates', () => {
    const result = merge(
      componentRecord({ pages: ['/login'] }),
      componentRecord({ pages: ['/login', '/home'] }),
    );
    expect(result.pages).toEqual(['/login', '/home']);
  });

  it('keeps the existing preferred selector', () => {
    const result = merge(
      componentRecord({ selectors: { preferred: '#old', aria: '', testid: null, css: null, xpath: null } }),
      componentRecord({ selectors: { preferred: '#new', aria: '', testid: null, css: null, xpath: null } }),
    );
    expect(result.selectors.preferred).toBe('#old');
  });

  it('takes the incoming aria selector when it is non-empty', () => {
    const result = merge(
      componentRecord({ selectors: { preferred: '#a', aria: '', testid: null, css: null, xpath: null } }),
      componentRecord({ selectors: { preferred: '#b', aria: 'button[name="X"]', testid: null, css: null, xpath: null } }),
    );
    expect(result.selectors.aria).toBe('button[name="X"]');
  });

  it('keeps the existing aria selector when the incoming one is empty', () => {
    const result = merge(
      componentRecord({ selectors: { preferred: '#a', aria: 'kept', testid: null, css: null, xpath: null } }),
      componentRecord({ selectors: { preferred: '#b', aria: '', testid: null, css: null, xpath: null } }),
    );
    expect(result.selectors.aria).toBe('kept');
  });

  it('fills a missing testid and css from the incoming record', () => {
    const result = merge(
      componentRecord(),
      componentRecord({ selectors: { preferred: '#b', aria: '', testid: '[data-testid="t"]', css: '.c', xpath: null } }),
    );
    expect(result.selectors.testid).toBe('[data-testid="t"]');
    expect(result.selectors.css).toBe('.c');
  });

  it('does not overwrite an existing testid', () => {
    const result = merge(
      componentRecord({ selectors: { preferred: '#a', aria: '', testid: 'keep', css: null, xpath: null } }),
      componentRecord({ selectors: { preferred: '#b', aria: '', testid: 'new', css: null, xpath: null } }),
    );
    expect(result.selectors.testid).toBe('keep');
  });

  it('upgrades confidence to the stronger of the two', () => {
    expect(merge(componentRecord({ confidence: 'low' }), componentRecord({ confidence: 'high' })).confidence).toBe('high');
    expect(merge(componentRecord({ confidence: 'high' }), componentRecord({ confidence: 'low' })).confidence).toBe('high');
    expect(merge(componentRecord({ confidence: 'low' }), componentRecord({ confidence: 'medium' })).confidence).toBe('medium');
    expect(merge(componentRecord({ confidence: 'low' }), componentRecord({ confidence: 'low' })).confidence).toBe('low');
  });

  it('merges states, letting the incoming record win on conflict', () => {
    const result = merge(
      componentRecord({ states: { disabled_when: 'old', hidden_when: 'kept' } }),
      componentRecord({ states: { disabled_when: 'new' } }),
    );
    expect(result.states).toEqual({ disabled_when: 'new', hidden_when: 'kept' });
  });

  it('prefers the incoming constraints, then the existing ones', () => {
    const existing = constraints({ maxLength: 1 });
    const incoming = constraints({ maxLength: 2 });

    expect(
      merge(componentRecord({ constraints: existing }), componentRecord({ constraints: incoming }))
        .constraints,
    ).toEqual(incoming);

    expect(
      merge(componentRecord({ constraints: existing }), componentRecord()).constraints,
    ).toEqual(existing);
  });

  it('unions assertions without duplicates', () => {
    const result = merge(
      componentRecord({ assertions: { pre_interaction: ['be.visible'], post_interaction: ['a'] } }),
      componentRecord({ assertions: { pre_interaction: ['be.visible', 'be.enabled'], post_interaction: ['b'] } }),
    );
    expect(result.assertions.pre_interaction).toEqual(['be.visible', 'be.enabled']);
    expect(result.assertions.post_interaction).toEqual(['a', 'b']);
  });

  it('appends a genuinely new action', () => {
    const existing: ComponentAction = { type: 'click' };
    const incoming: ComponentAction = { type: 'fill' };
    const result = merge(
      componentRecord({ actions: [existing] }),
      componentRecord({ actions: [incoming] }),
    );
    expect(result.actions).toEqual([existing, incoming]);
  });

  it('does not duplicate an action with the same type and url pattern', () => {
    const action: ComponentAction = { type: 'click' };
    const result = merge(
      componentRecord({ actions: [action] }),
      componentRecord({ actions: [{ type: 'click' }] }),
    );
    expect(result.actions).toHaveLength(1);
  });

  it('keeps two same-type actions that hit different endpoints', () => {
    const a: ComponentAction = {
      type: 'click',
      network: { method: 'POST', urlPattern: '/a', expectedStatus: 200 },
    };
    const b: ComponentAction = {
      type: 'click',
      network: { method: 'POST', urlPattern: '/b', expectedStatus: 200 },
    };
    const result = merge(componentRecord({ actions: [a] }), componentRecord({ actions: [b] }));
    expect(result.actions).toHaveLength(2);
  });

  it('refreshes lastSeen', () => {
    const result = merge(
      componentRecord({ lastSeen: '2020-01-01T00:00:00.000Z' }),
      componentRecord(),
    );
    expect(result.lastSeen).not.toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('IdentityResolutionAgent._buildObservedRecords', () => {
  const build = (components: AriaComponent[], anchors: Anchor[]): ComponentRecord[] =>
    makeAgent()['_buildObservedRecords'](components, anchors);

  it('builds a record for an observed, non-interacted component', () => {
    const result = build([aria({ ariaName: 'Header' })], []);
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe('Header');
  });

  it('skips a component the user already interacted with', () => {
    const comp = aria();
    const interacting = anchor({ ariaRole: comp.ariaRole, ariaName: comp.ariaName, url: comp.pageUrl });
    expect(build([comp], [interacting])).toEqual([]);
  });

  it('treats the same role+name on a different page as not interacted', () => {
    const comp = aria({ pageUrl: 'https://app.test/other' });
    const interacting = anchor({
      ariaRole: comp.ariaRole,
      ariaName: comp.ariaName,
      url: 'https://app.test/login',
    });
    expect(build([comp], [interacting])).toHaveLength(1);
  });

  it('deduplicates repeated components', () => {
    expect(build([aria(), aria(), aria()], [])).toHaveLength(1);
  });

  it('keeps components that differ by role', () => {
    expect(build([aria({ ariaRole: 'button' }), aria({ ariaRole: 'link' })], [])).toHaveLength(2);
  });

  it('skips components with no role or no name', () => {
    expect(build([aria({ ariaRole: '' }), aria({ ariaName: '' })], [])).toEqual([]);
  });

  it('ignores anchors that lack a role or a name when building the interacted set', () => {
    const comp = aria();
    // Anchor has no ariaRole, so it cannot suppress the component.
    expect(build([comp], [anchor({ ariaName: comp.ariaName, url: comp.pageUrl })])).toHaveLength(1);
  });

  it('returns an empty array for no components', () => {
    expect(build([], [anchor()])).toEqual([]);
  });
});

describe('IdentityResolutionAgent._updatePages', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function registryDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'idres-pages-'));
    tempDirs.push(dir);
    return dir;
  }

  const update = (dir: string, records: ComponentRecord[]): Promise<void> =>
    makeAgent()['_updatePages'](dir, [], records);

  async function readPages(dir: string): Promise<PageRegistry> {
    return JSON.parse(await readFile(join(dir, 'pages.json'), 'utf-8')) as PageRegistry;
  }

  it('creates pages.json with an entry per page', async () => {
    const dir = await registryDir();
    await update(dir, [componentRecord({ id: 'c1', pages: ['/login'] })]);

    const pages = await readPages(dir);
    expect(Object.keys(pages)).toEqual(['/login']);
    expect(pages['/login']?.components).toEqual(['c1']);
    expect(pages['/login']?.title).toBe('/login');
  });

  it('registers one component under each of its pages', async () => {
    const dir = await registryDir();
    await update(dir, [componentRecord({ id: 'c1', pages: ['/a', '/b'] })]);

    const pages = await readPages(dir);
    expect(Object.keys(pages).sort()).toEqual(['/a', '/b']);
    expect(pages['/a']?.components).toEqual(['c1']);
    expect(pages['/b']?.components).toEqual(['c1']);
  });

  it('accumulates several components on the same page', async () => {
    const dir = await registryDir();
    await update(dir, [
      componentRecord({ id: 'c1', pages: ['/login'] }),
      componentRecord({ id: 'c2', pages: ['/login'] }),
    ]);

    expect((await readPages(dir))['/login']?.components).toEqual(['c1', 'c2']);
  });

  it('does not duplicate a component id already listed', async () => {
    const dir = await registryDir();
    await update(dir, [
      componentRecord({ id: 'c1', pages: ['/login'] }),
      componentRecord({ id: 'c1', pages: ['/login'] }),
    ]);

    expect((await readPages(dir))['/login']?.components).toEqual(['c1']);
  });

  it('merges into an existing pages.json rather than replacing it', async () => {
    const dir = await registryDir();
    await writeFile(
      join(dir, 'pages.json'),
      JSON.stringify({
        '/existing': { title: 'Existing', components: ['old'], lastSeen: '2020-01-01T00:00:00.000Z' },
      }),
      'utf-8',
    );

    await update(dir, [componentRecord({ id: 'new', pages: ['/login'] })]);

    const pages = await readPages(dir);
    expect(Object.keys(pages).sort()).toEqual(['/existing', '/login']);
    expect(pages['/existing']?.components).toEqual(['old']);
    expect(pages['/existing']?.title).toBe('Existing');
  });

  it('appends to an existing page entry and refreshes its lastSeen', async () => {
    const dir = await registryDir();
    await writeFile(
      join(dir, 'pages.json'),
      JSON.stringify({
        '/login': { title: 'Login', components: ['old'], lastSeen: '2020-01-01T00:00:00.000Z' },
      }),
      'utf-8',
    );

    await update(dir, [componentRecord({ id: 'new', pages: ['/login'] })]);

    const pages = await readPages(dir);
    expect(pages['/login']?.components).toEqual(['old', 'new']);
    expect(pages['/login']?.title).toBe('Login');
    expect(pages['/login']?.lastSeen).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('starts fresh when the existing pages.json is malformed', async () => {
    const dir = await registryDir();
    await writeFile(join(dir, 'pages.json'), '{not json', 'utf-8');

    await update(dir, [componentRecord({ id: 'c1', pages: ['/login'] })]);

    expect(Object.keys(await readPages(dir))).toEqual(['/login']);
  });

  it('writes an empty registry when there are no records', async () => {
    const dir = await registryDir();
    await update(dir, []);

    expect(await readPages(dir)).toEqual({});
  });
});
