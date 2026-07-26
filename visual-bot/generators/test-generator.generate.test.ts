import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TestGenerator } from './test-generator.js';
import type { ComponentRecord, StepRecord } from '../pipeline/types.js';
import type { TestPlan } from './test-planner.js';

const tempDirs: string[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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
    label: 'Submit',
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

interface PageCall {
  sessionId: string;
  pagePath: string;
  steps: StepRecord[];
  components: ComponentRecord[];
  cypressDir: string;
  blockers: ComponentRecord[];
  scenario?: { name: string; page: string } | undefined;
}

/** Replaces the per-page writer so the test observes only generate()'s wiring. */
function instrument(generator: TestGenerator): PageCall[] {
  const calls: PageCall[] = [];
  generator['_generatePageTest'] = (params): Promise<void> => {
    calls.push(params);
    return Promise.resolve();
  };
  return calls;
}

interface Fixture {
  sessionDir: string;
  dataDir: string;
  cypressDir: string;
}

/** Lays out a session dir with steps plus a data dir with a registry. */
async function fixture(options: {
  steps?: StepRecord[];
  components?: ComponentRecord[];
  sessionId?: string;
  withRegistry?: boolean;
  classification?: Array<{ componentId: string; blocking: boolean }>;
}): Promise<Fixture> {
  const { steps = [step()], components = [record()], sessionId, withRegistry = true, classification } = options;

  const root = await tempDir('tg-');
  const sessionDir = join(root, 'session-1');
  const dataDir = join(root, 'data');
  const cypressDir = join(root, 'cypress');

  await mkdir(join(sessionDir, 'steps'), { recursive: true });
  for (const s of steps) {
    await writeFile(join(sessionDir, 'steps', `${s.stepId}.json`), JSON.stringify(s), 'utf-8');
  }
  if (sessionId) {
    await writeFile(join(sessionDir, 'session-meta.json'), JSON.stringify({ sessionId }), 'utf-8');
  }

  if (withRegistry) {
    await mkdir(join(dataDir, 'registry'), { recursive: true });
    await writeFile(
      join(dataDir, 'registry', 'components.json'),
      JSON.stringify({
        version: '1.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        components: Object.fromEntries(components.map((c) => [c.id, c])),
      }),
      'utf-8',
    );
  }

  if (classification) {
    await mkdir(join(dataDir, 'reports'), { recursive: true });
    await writeFile(
      join(dataDir, 'reports', 'classification.json'),
      JSON.stringify(classification),
      'utf-8',
    );
  }

  return { sessionDir, dataDir, cypressDir };
}

describe('TestGenerator.generate', () => {
  it('does nothing when the session has no steps', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({ steps: [] });

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);
    expect(calls).toEqual([]);
  });

  it('bails out when the registry is missing', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({ withRegistry: false });

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);
    expect(calls).toEqual([]);
  });

  it('generates one page test per distinct page', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({
      steps: [
        step({ stepId: 'step-001', url: 'https://app.test/login' }),
        step({ stepId: 'step-002', url: 'https://app.test/home' }),
      ],
    });

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);

    expect(calls.map((c) => c.pagePath).sort()).toEqual(['/home', '/login']);
  });

  it('groups several steps on the same page into one call', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({
      steps: [
        step({ stepId: 'step-001', url: 'https://app.test/login' }),
        step({ stepId: 'step-002', url: 'https://app.test/login' }),
      ],
    });

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.steps).toHaveLength(2);
  });

  it('takes the session id from meta.json when present', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({ sessionId: 'recorded-session-42' });

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);
    expect(calls[0]?.sessionId).toBe('recorded-session-42');
  });

  it('falls back to the directory name when meta.json is absent', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({});

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);
    expect(calls[0]?.sessionId).toBe('session-1');
  });

  it('passes the components relevant to each page', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({
      components: [
        record({ id: 'on-login', pages: ['/login'] }),
        record({ id: 'elsewhere', pages: ['/other'] }),
      ],
    });

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);
    expect(calls[0]?.components.map((c) => c.id)).toEqual(['on-login']);
  });

  it('marks blocking components so their specs can be skipped', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({
      components: [record({ id: 'cmp-1', pages: ['/login'] })],
      classification: [{ componentId: 'cmp-1', blocking: true }],
    });

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);
    expect(calls[0]?.blockers.map((c) => c.id)).toEqual(['cmp-1']);
  });

  it('reports no blockers when the classification marks none', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({
      components: [record({ id: 'cmp-1', pages: ['/login'] })],
      classification: [{ componentId: 'cmp-1', blocking: false }],
    });

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);
    expect(calls[0]?.blockers).toEqual([]);
  });

  it('reports no blockers when there is no classification report', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({});

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);
    expect(calls[0]?.blockers).toEqual([]);
  });

  it('hands the matching plan scenario to the page it belongs to', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({ sessionId: 'sess-a' });

    const plan = {
      scenarios: [
        { sessionId: 'sess-a', page: '/login', name: 'Login flow' },
        { sessionId: 'sess-b', page: '/login', name: 'Other session' },
      ],
    } as unknown as TestPlan;

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir, plan);

    expect(calls[0]?.scenario).toMatchObject({ name: 'Login flow' });
  });

  it('leaves the scenario undefined when the plan covers another page', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({ sessionId: 'sess-a' });

    const plan = {
      scenarios: [{ sessionId: 'sess-a', page: '/somewhere-else', name: 'Nope' }],
    } as unknown as TestPlan;

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir, plan);
    expect(calls[0]?.scenario).toBeUndefined();
  });

  it('works with no plan at all', async () => {
    const generator = new TestGenerator();
    const calls = instrument(generator);
    const f = await fixture({});

    await generator.generate(f.sessionDir, f.dataDir, f.cypressDir);
    expect(calls[0]?.scenario).toBeUndefined();
  });
});
