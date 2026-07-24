import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TestPlanner } from './test-planner.js';
import type { ActionElement, StepRecord } from '../pipeline/types.js';

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
