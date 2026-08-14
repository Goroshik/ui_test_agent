import { describe, it, expect, vi, beforeEach } from 'vitest';

const existsSync = vi.fn<(path: string) => boolean>();
const readFile = vi.fn<(path: string, encoding: string) => Promise<string>>();
const writeFile = vi.fn<(path: string, data: string, encoding: string) => Promise<void>>();
const mkdir = vi.fn<(path: string, opts: unknown) => Promise<void>>();

vi.mock('fs', () => ({ existsSync: (path: string): boolean => existsSync(path) }));
vi.mock('fs/promises', () => ({
  readFile: (path: string, encoding: string): Promise<string> => readFile(path, encoding),
  writeFile: (path: string, data: string, encoding: string): Promise<void> =>
    writeFile(path, data, encoding),
  mkdir: (path: string, opts: unknown): Promise<void> => mkdir(path, opts),
}));

const { recordVisit, hasVisited, getVisitSummary } = await import('./memory.js');

interface VisitRecord {
  lastVisited: string;
  visitCount: number;
  examples?: string[];
}

/** Seeds the on-disk memory file. */
function seed(visits: Record<string, VisitRecord>): void {
  existsSync.mockReturnValue(true);
  readFile.mockResolvedValue(JSON.stringify({ visits }));
}

function seedEmpty(): void {
  existsSync.mockReturnValue(false);
}

/** The visits map as it was last written back to disk. */
function written(): Record<string, VisitRecord> {
  const call = writeFile.mock.calls.at(-1);
  if (!call) throw new Error('memory was never written');
  return (JSON.parse(call[1]) as { visits: Record<string, VisitRecord> }).visits;
}

function visit(overrides: Partial<VisitRecord> = {}): VisitRecord {
  return { lastVisited: '2026-01-01T00:00:00.000Z', visitCount: 1, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mkdir.mockResolvedValue(undefined);
  writeFile.mockResolvedValue(undefined);
  seedEmpty();
});

describe('recordVisit', () => {
  it('keys a visit by the normalised page path', async () => {
    await recordVisit('http://localhost:3000/member-hr/home');
    expect(Object.keys(written())).toEqual(['/member-hr/home']);
  });

  it('folds a query string into the same page', async () => {
    seed({ '/member-hr/home': visit({ visitCount: 2 }) });

    await recordVisit('http://localhost:3000/member-hr/home?project=58');

    expect(Object.keys(written())).toEqual(['/member-hr/home']);
    expect(written()['/member-hr/home']?.visitCount).toBe(3);
  });

  it('folds two records of a dynamic route into one page', async () => {
    seed({ '/users/:id': visit() });

    await recordVisit('http://localhost:3000/users/456');

    expect(Object.keys(written())).toEqual(['/users/:id']);
    expect(written()['/users/:id']?.visitCount).toBe(2);
  });

  it('starts a new page at one visit', async () => {
    await recordVisit('/member-hr/team');
    expect(written()['/member-hr/team']?.visitCount).toBe(1);
  });

  it('keeps the concrete url as an example so the page stays navigable', async () => {
    await recordVisit('http://localhost:3000/users/123');
    expect(written()['/users/:id']?.examples).toEqual(['http://localhost:3000/users/123']);
  });

  it('keeps the newest example first', async () => {
    seed({ '/users/:id': visit({ examples: ['http://x/users/1'] }) });

    await recordVisit('http://x/users/2');

    expect(written()['/users/:id']?.examples).toEqual(['http://x/users/2', 'http://x/users/1']);
  });

  it('does not repeat an example it already has', async () => {
    seed({ '/users/:id': visit({ examples: ['http://x/users/1'] }) });

    await recordVisit('http://x/users/1');

    expect(written()['/users/:id']?.examples).toEqual(['http://x/users/1']);
  });

  it('caps the examples it keeps', async () => {
    seed({
      '/users/:id': visit({ examples: ['http://x/users/3', 'http://x/users/2', 'http://x/users/1'] }),
    });

    await recordVisit('http://x/users/4');

    expect(written()['/users/:id']?.examples).toHaveLength(3);
    expect(written()['/users/:id']?.examples?.[0]).toBe('http://x/users/4');
  });

  it('leaves other pages untouched', async () => {
    seed({ '/a': visit(), '/b': visit() });

    await recordVisit('/c');

    expect(Object.keys(written()).sort()).toEqual(['/a', '/b', '/c']);
  });

  it('starts fresh when the memory file is unreadable', async () => {
    existsSync.mockReturnValue(true);
    readFile.mockRejectedValue(new Error('EACCES'));

    await recordVisit('/a');

    expect(Object.keys(written())).toEqual(['/a']);
  });

  it('starts fresh when the memory file holds invalid json', async () => {
    existsSync.mockReturnValue(true);
    readFile.mockResolvedValue('not json');

    await recordVisit('/a');

    expect(Object.keys(written())).toEqual(['/a']);
  });

  it('creates the data directory when it is missing', async () => {
    existsSync.mockReturnValue(false);
    await recordVisit('/a');
    expect(mkdir).toHaveBeenCalled();
  });
});

describe('hasVisited', () => {
  it('matches a raw url against the normalised key', async () => {
    seed({ '/member-hr/home': visit() });
    await expect(hasVisited('http://localhost:3000/member-hr/home?project=1')).resolves.toBe(true);
  });

  it('matches a different record of a known dynamic route', async () => {
    seed({ '/users/:id': visit() });
    await expect(hasVisited('http://x/users/999')).resolves.toBe(true);
  });

  it('is false for an unknown page', async () => {
    seed({ '/a': visit() });
    await expect(hasVisited('/b')).resolves.toBe(false);
  });
});

describe('getVisitSummary', () => {
  it('is empty when nothing was visited', async () => {
    await expect(getVisitSummary()).resolves.toBe('');
  });

  it('lists pages newest first with their visit count', async () => {
    seed({
      '/old': visit({ lastVisited: '2026-01-01T00:00:00.000Z', visitCount: 1 }),
      '/new': visit({ lastVisited: '2026-06-01T00:00:00.000Z', visitCount: 4 }),
    });

    const summary = await getVisitSummary();

    expect(summary.indexOf('/new')).toBeLessThan(summary.indexOf('/old'));
    expect(summary).toContain('- /new — visited 4x');
  });

  it('shows a concrete example for a dynamic page', async () => {
    seed({ '/users/:id': visit({ examples: ['http://x/users/7'] }) });
    await expect(getVisitSummary()).resolves.toContain('/users/:id — visited 1x (e.g. http://x/users/7)');
  });

  it('omits the example when it adds nothing over the path', async () => {
    seed({ '/a': visit({ examples: ['/a'] }) });
    await expect(getVisitSummary()).resolves.toBe('Previously visited pages:\n- /a — visited 1x');
  });

  it('omits the example when none was recorded', async () => {
    seed({ '/a': visit() });
    await expect(getVisitSummary()).resolves.toBe('Previously visited pages:\n- /a — visited 1x');
  });

  it('honours the limit', async () => {
    seed({
      '/a': visit({ lastVisited: '2026-01-03T00:00:00.000Z' }),
      '/b': visit({ lastVisited: '2026-01-02T00:00:00.000Z' }),
      '/c': visit({ lastVisited: '2026-01-01T00:00:00.000Z' }),
    });

    const summary = await getVisitSummary(2);

    expect(summary).toContain('/a');
    expect(summary).toContain('/b');
    expect(summary).not.toContain('/c');
  });
});
