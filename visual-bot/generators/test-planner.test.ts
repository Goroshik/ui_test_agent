import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TestPlanner } from './test-planner.js';
import type {
  ActionElement,
  ComponentRecord,
  ComponentRegistry,
  StepRecord,
} from '../pipeline/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

describe('TestPlanner._resolveInteractionSelector', () => {
  const resolve = (el: ActionElement | undefined): string =>
    new TestPlanner()['_resolveInteractionSelector'](el);

  it('returns a placeholder when there is no element', () => {
    expect(resolve(undefined)).toBe('?');
  });

  it('prefers a data-testid selector', () => {
    expect(resolve({ testid: 'submit-btn' })).toBe('[data-testid="submit-btn"]');
  });

  it('prefers the testid over aria and text', () => {
    expect(resolve({ testid: 't', ariaRole: 'button', ariaName: 'Go', text: 'Go' })).toBe(
      '[data-testid="t"]',
    );
  });

  it('builds an aria locator from role and name', () => {
    expect(resolve({ ariaRole: 'button', ariaName: 'Submit' })).toBe('button["Submit"]');
  });

  it('requires both role and name for the aria locator', () => {
    expect(resolve({ ariaRole: 'button', text: 'Go' })).toBe('Go');
    expect(resolve({ ariaName: 'Submit', text: 'Go' })).toBe('Go');
  });

  it('falls back to the element text', () => {
    expect(resolve({ text: 'Continue' })).toBe('Continue');
  });

  it('returns a placeholder for an element with nothing usable', () => {
    expect(resolve({})).toBe('?');
    expect(resolve({ tagName: 'div' })).toBe('?');
  });
});

describe('TestPlanner._summarizeInteraction', () => {
  const summarize = (s: StepRecord): ReturnType<TestPlanner['_summarizeInteraction']> =>
    new TestPlanner()['_summarizeInteraction'](s);

  it('carries the step id, type and resolved selector', () => {
    const result = summarize(
      step({ action: { type: 'click', description: 'd', element: { testid: 'go' } } }),
    );

    expect(result.step).toBe('step-001');
    expect(result.type).toBe('click');
    expect(result.selector).toBe('[data-testid="go"]');
  });

  it('carries the action value when present', () => {
    const result = summarize(
      step({ action: { type: 'fill', description: 'd', value: 'hello' } }),
    );
    expect(result.value).toBe('hello');
  });

  it('leaves the value undefined when absent', () => {
    expect(summarize(step()).value).toBeUndefined();
  });

  it('reports no network effect when there is no after block', () => {
    expect(summarize(step()).hasNetworkEffect).toBe(false);
  });

  it('reports a network effect when a network file was captured', () => {
    const result = summarize(
      step({ after: { ariaSnapshotFile: 'a.txt', networkFile: 'n.json' } }),
    );
    expect(result.hasNetworkEffect).toBe(true);
  });

  it('reports no storage change when the diff has no added keys', () => {
    const result = summarize(
      step({ after: { ariaSnapshotFile: 'a.txt', storageDiff: { added: {}, removed: {}, changed: {} } } }),
    );
    expect(result.hasStorageChange).toBe(false);
  });

  it('reports a storage change when the diff added a key', () => {
    const result = summarize(
      step({
        after: {
          ariaSnapshotFile: 'a.txt',
          storageDiff: { added: { token: 'abc' }, removed: {}, changed: {} },
        },
      }),
    );
    expect(result.hasStorageChange).toBe(true);
  });

  it('reports no storage change when there is no diff at all', () => {
    const result = summarize(step({ after: { ariaSnapshotFile: 'a.txt' } }));
    expect(result.hasStorageChange).toBe(false);
  });
});

describe('TestPlanner._loadObservations', () => {
  async function sessionsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tp-sessions-'));
    tempDirs.push(dir);
    return dir;
  }

  const load = (dir: string, sessionId: string): Promise<unknown> =>
    new TestPlanner()['_loadObservations'](dir, sessionId);

  it('returns an empty list when the file does not exist', async () => {
    await expect(load(await sessionsDir(), 'session-1')).resolves.toEqual([]);
  });

  it('reads observations written by the adversarial pass', async () => {
    const dir = await sessionsDir();
    const analyzed = join(dir, 'session-1', 'analyzed');
    await mkdir(analyzed, { recursive: true });
    await writeFile(
      join(analyzed, 'adversarial-observations.json'),
      JSON.stringify([{ page: '/login', field: 'email', expected: 'rejected' }]),
      'utf-8',
    );

    await expect(load(dir, 'session-1')).resolves.toEqual([
      { page: '/login', field: 'email', expected: 'rejected' },
    ]);
  });

  it('returns an empty list for malformed JSON', async () => {
    const dir = await sessionsDir();
    const analyzed = join(dir, 'session-1', 'analyzed');
    await mkdir(analyzed, { recursive: true });
    await writeFile(join(analyzed, 'adversarial-observations.json'), '{not json', 'utf-8');

    await expect(load(dir, 'session-1')).resolves.toEqual([]);
  });

  it('returns an empty list when the payload is not an array', async () => {
    const dir = await sessionsDir();
    const analyzed = join(dir, 'session-1', 'analyzed');
    await mkdir(analyzed, { recursive: true });
    await writeFile(join(analyzed, 'adversarial-observations.json'), '{"a":1}', 'utf-8');

    await expect(load(dir, 'session-1')).resolves.toEqual([]);
  });
});

describe('TestPlanner._buildDeterministicPlan', () => {
  function record(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
    return {
      id: 'cmp-1',
      label: 'Submit',
      componentType: 'button',
      pages: ['/login'],
      lastSeen: '2026-01-01T00:00:00.000Z',
      selectors: { preferred: '#s', aria: '', testid: null, css: null, xpath: null },
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

  interface Session {
    sessionId: string;
    task: string;
    steps: StepRecord[];
  }

  function session(steps: StepRecord[], sessionId = 'sess-1'): Session {
    return { sessionId, task: 'log in', steps };
  }

  const networkAction = {
    type: 'click' as const,
    network: { method: 'POST', urlPattern: '/api/login', expectedStatus: 200 },
  };

  function build(
    reg: ComponentRegistry,
    sessions: Session[],
    goal?: string,
    blocking: string[] = [],
  ): ReturnType<TestPlanner['_buildDeterministicPlan']> {
    const planner = new TestPlanner();
    planner['blockingIds'] = new Set(blocking);
    return planner['_buildDeterministicPlan'](reg, sessions, goal);
  }

  it('produces one scenario per page in the session', () => {
    const plan = build(registry(record()), [
      session([
        step({ stepId: 'step-001', url: 'https://app.test/login' }),
        step({ stepId: 'step-002', url: 'https://app.test/home' }),
      ]),
    ]);

    expect(plan.scenarios.map((s) => s.page).sort()).toEqual(['/home', '/login']);
  });

  it('lists the session ids it planned from', () => {
    const plan = build(registry(record()), [session([step()], 'sess-a')]);
    expect(plan.sessions).toEqual(['sess-a']);
  });

  it('includes the goal only when one is supplied', () => {
    expect(build(registry(record()), [session([step()])], 'log in successfully').goal).toBe(
      'log in successfully',
    );
    expect(build(registry(record()), [session([step()])])).not.toHaveProperty('goal');
  });

  it('derives the scenario id and spec path from the page and scenario name', () => {
    const plan = build(registry(record()), [
      session([step({ url: 'https://app.test/login', action: { type: 'click', description: 'Sign In' } })]),
    ]);
    const scenario = plan.scenarios[0];

    expect(scenario?.id).toBe('login-sign-in');
    expect(scenario?.file).toBe('cypress/e2e/login/sign-in.cy.js');
  });

  it('names the root page "home"', () => {
    const plan = build(registry(record({ pages: ['/'] })), [
      session([step({ url: 'https://app.test/' })]),
    ]);
    expect(plan.scenarios[0]?.file).toContain('cypress/e2e/home/');
  });

  it('collects the step ids belonging to the page', () => {
    const plan = build(registry(record()), [
      session([
        step({ stepId: 'step-001', url: 'https://app.test/login' }),
        step({ stepId: 'step-002', url: 'https://app.test/login' }),
      ]),
    ]);
    expect(plan.scenarios[0]?.stepIds).toEqual(['step-001', 'step-002']);
  });

  it('raises the priority to high when a component performs a network call', () => {
    const plan = build(registry(record({ actions: [networkAction] })), [session([step()])]);
    expect(plan.scenarios[0]?.priority).toBe('high');
  });

  it('keeps the priority medium without any network action', () => {
    const plan = build(registry(record()), [session([step()])]);
    expect(plan.scenarios[0]?.priority).toBe('medium');
  });

  it('names a success and an error fixture per network component', () => {
    const plan = build(registry(record({ id: 'login-btn', actions: [networkAction] })), [
      session([step()]),
    ]);
    expect(plan.scenarios[0]?.fixtureFiles).toEqual([
      'login-btn--success.json',
      'login-btn--error.json',
    ]);
  });

  it('lists no fixtures when nothing hits the network', () => {
    const plan = build(registry(record()), [session([step()])]);
    expect(plan.scenarios[0]?.fixtureFiles).toEqual([]);
  });

  it('includes a component that appears on more than two pages', () => {
    const global = record({ id: 'nav', pages: ['/a', '/b', '/c'] });
    const plan = build(registry(global), [session([step({ url: 'https://app.test/login' })])]);

    expect(plan.scenarios[0]?.componentIds).toContain('nav');
  });

  it('excludes a component belonging to another page only', () => {
    const other = record({ id: 'elsewhere', pages: ['/other'] });
    const plan = build(registry(other), [session([step({ url: 'https://app.test/login' })])]);

    expect(plan.scenarios[0]?.componentIds).toEqual([]);
  });

  it('excludes blocking components from the scenario', () => {
    const plan = build(
      registry(record({ id: 'blocked' }), record({ id: 'ok' })),
      [session([step()])],
      undefined,
      ['blocked'],
    );

    expect(plan.scenarios[0]?.componentIds).toEqual(['ok']);
  });

  it('plans across several sessions', () => {
    const plan = build(registry(record()), [
      session([step({ url: 'https://app.test/login' })], 'sess-a'),
      session([step({ url: 'https://app.test/home' })], 'sess-b'),
    ]);

    expect(plan.scenarios).toHaveLength(2);
    expect(plan.sessions).toEqual(['sess-a', 'sess-b']);
  });

  it('produces an empty scenario list for a session with no steps', () => {
    const plan = build(registry(record()), [session([])]);
    expect(plan.scenarios).toEqual([]);
  });

  it('attaches a description naming the page', () => {
    const plan = build(registry(record()), [session([step({ url: 'https://app.test/login' })])]);
    expect(plan.scenarios[0]?.description).toBe('Recorded flow on /login');
  });
});
