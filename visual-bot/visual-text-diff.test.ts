import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';

/**
 * compareBatched persists baseline summaries through content-summary-store; that
 * store is mocked so the tests drive the cached-baseline branch directly.
 */
const store = new Map<string, string>();
const upserts: Array<{ key: string; summary: string }> = [];

vi.mock('./pipeline/content-summary-store.js', () => ({
  getContentSummary: (key: string): Promise<string | null> =>
    Promise.resolve(store.get(key) ?? null),
  upsertContentSummary: (key: string, _kind: string, summary: string): Promise<void> => {
    upserts.push({ key, summary });
    store.set(key, summary);
    return Promise.resolve();
  },
}));

/** `memory` is readonly on the class, so the dependency is mocked instead. */
const remembered: Array<{
  key: string;
  summary: string;
  oldSample: string | undefined;
  newSample: string | undefined;
}> = [];

vi.mock('./attention-memory.js', () => ({
  AttentionMemory: class {
    getGuidance(): Promise<string> {
      return Promise.resolve('');
    }
    rememberChange(key: string, summary: string, oldSample?: string, newSample?: string): Promise<void> {
      remembered.push({ key, summary, oldSample, newSample });
      return Promise.resolve();
    }
  },
}));

const { VisualTextDiff } = await import('./visual-text-diff.js');
type Diff = InstanceType<typeof VisualTextDiff>;

/** Builds a diff whose summarize and compare steps are stubbed. */
function makeDiff(options: {
  summaries?: string[];
  compareResult?: { changed: boolean; summary: string };
} = {}): { diff: Diff; summarized: string[] } {
  const { summaries = ['summary'], compareResult = { changed: false, summary: '' } } = options;
  const summarized: string[] = [];
  let index = 0;

  const diff = new VisualTextDiff({} as unknown as OpenAI, 'test-model');
  diff['summarizeSnapshot'] = (snapshot: string): Promise<string> => {
    summarized.push(snapshot);
    const value = summaries[index] ?? summaries[summaries.length - 1] ?? 'summary';
    index++;
    return Promise.resolve(value);
  };
  diff['compareSummaries'] = (): Promise<{ changed: boolean; summary: string }> =>
    Promise.resolve({ ...compareResult });

  return { diff, summarized };
}

const compareBatched = (
  diff: Diff,
  oldSnapshot: string,
  newSnapshot: string,
  deterministicChanged: boolean,
): Promise<{ changed: boolean; summary: string }> =>
  diff['compareBatched'](oldSnapshot, newSnapshot, 'nav-home', deterministicChanged);

beforeEach(() => {
  store.clear();
  upserts.length = 0;
  remembered.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VisualTextDiff.compareBatched', () => {
  it('summarizes both snapshots when there is no cached baseline', async () => {
    const { diff, summarized } = makeDiff({ summaries: ['old-sum', 'new-sum'] });
    await compareBatched(diff, 'OLD', 'NEW', false);

    expect(summarized).toEqual(['OLD', 'NEW']);
  });

  it('caches the freshly built baseline summary', async () => {
    const { diff } = makeDiff({ summaries: ['old-sum', 'new-sum'] });
    await compareBatched(diff, 'OLD', 'NEW', false);

    expect(upserts[0]).toEqual({ key: 'nav-home', summary: 'old-sum' });
  });

  it('reuses a cached baseline instead of re-summarizing the old snapshot', async () => {
    store.set('nav-home', 'cached-old');
    const { diff, summarized } = makeDiff({ summaries: ['new-sum'] });
    await compareBatched(diff, 'OLD', 'NEW', false);

    expect(summarized).toEqual(['NEW']);
  });

  it('returns the comparison verdict unchanged when nothing differs', async () => {
    store.set('nav-home', 'cached');
    const { diff } = makeDiff({ compareResult: { changed: false, summary: '' } });

    await expect(compareBatched(diff, 'OLD', 'NEW', false)).resolves.toEqual({
      changed: false,
      summary: '',
    });
  });

  it('passes a change verdict through', async () => {
    store.set('nav-home', 'cached');
    const { diff } = makeDiff({ compareResult: { changed: true, summary: 'header moved' } });

    await expect(compareBatched(diff, 'OLD', 'NEW', false)).resolves.toEqual({
      changed: true,
      summary: 'header moved',
    });
  });

  it('promotes a deterministic diff the model missed', async () => {
    store.set('nav-home', 'cached');
    const { diff } = makeDiff({ compareResult: { changed: false, summary: '' } });

    const result = await compareBatched(diff, 'OLD', 'NEW', true);

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('Deterministic snapshot diff');
  });

  it('keeps the model summary when promoting a deterministic diff', async () => {
    store.set('nav-home', 'cached');
    const { diff } = makeDiff({ compareResult: { changed: false, summary: 'subtle text change' } });

    const result = await compareBatched(diff, 'OLD', 'NEW', true);

    expect(result.changed).toBe(true);
    expect(result.summary).toBe('subtle text change');
  });

  it('does not touch a verdict that already reports a change', async () => {
    store.set('nav-home', 'cached');
    const { diff } = makeDiff({ compareResult: { changed: true, summary: 'already changed' } });

    const result = await compareBatched(diff, 'OLD', 'NEW', true);
    expect(result.summary).toBe('already changed');
  });

  it('stores the new summary as the baseline once a change is confirmed', async () => {
    store.set('nav-home', 'cached');
    const { diff } = makeDiff({
      summaries: ['new-sum'],
      compareResult: { changed: true, summary: 'moved' },
    });

    await compareBatched(diff, 'OLD', 'NEW', false);

    expect(upserts.at(-1)).toEqual({ key: 'nav-home', summary: 'new-sum' });
  });

  it('leaves the baseline alone when nothing changed', async () => {
    store.set('nav-home', 'cached');
    const { diff } = makeDiff({ compareResult: { changed: false, summary: '' } });

    await compareBatched(diff, 'OLD', 'NEW', false);
    expect(upserts).toEqual([]);
  });

  it('records the change in attention memory with both snapshots', async () => {
    store.set('nav-home', 'cached');
    const { diff } = makeDiff({ compareResult: { changed: true, summary: 'moved' } });

    await compareBatched(diff, 'OLD', 'NEW', false);

    expect(remembered).toEqual([
      { key: 'nav-home', summary: 'moved', oldSample: 'OLD', newSample: 'NEW' },
    ]);
  });

  it('does not record anything in memory when nothing changed', async () => {
    store.set('nav-home', 'cached');
    const { diff } = makeDiff({ compareResult: { changed: false, summary: '' } });

    await compareBatched(diff, 'OLD', 'NEW', false);
    expect(remembered).toEqual([]);
  });

  it('reaches compareBatched through the public compare()', async () => {
    store.set('nav-home', 'cached');
    const { diff, summarized } = makeDiff({ compareResult: { changed: false, summary: '' } });

    await diff.compare('OLD', 'NEW', 'nav-home');
    expect(summarized).toEqual(['NEW']);
  });
});
