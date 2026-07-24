import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentRecord } from './pipeline/types.js';

/**
 * registry-context reads data/registry/{components,pages}.json relative to cwd
 * and memoizes both. The fs layer is mocked so the tests drive the registry
 * contents directly; invalidateRegistryCache() resets the memo between cases.
 */
const files = new Map<string, string>();

vi.mock('fs', () => ({
  existsSync: (p: string): boolean => files.has(key(p)),
}));

vi.mock('fs/promises', () => ({
  readFile: (p: string): Promise<string> => {
    const content = files.get(key(p));
    return content === undefined
      ? Promise.reject(new Error(`ENOENT: ${p}`))
      : Promise.resolve(content);
  },
}));

/** Reduces an absolute path to the registry file name we keyed it under. */
function key(p: string): string {
  const normalized = String(p).replace(/\\/g, '/');
  return normalized.endsWith('components.json')
    ? 'components.json'
    : normalized.endsWith('pages.json')
      ? 'pages.json'
      : normalized;
}

const { invalidateRegistryCache, toolGetPageComponents } = await import('./registry-context.js');

function record(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: 'cmp-1',
    label: 'Submit',
    componentType: 'button',
    pages: ['/login'],
    lastSeen: '2026-01-01T00:00:00.000Z',
    selectors: { preferred: '#submit', aria: '', testid: null, css: null, xpath: null },
    actions: [],
    states: {},
    assertions: { pre_interaction: [], post_interaction: [] },
    constraints: null,
    confidence: 'high',
    seenCount: 3,
    manualOverride: false,
    notes: '',
    ...overrides,
  };
}

/** Seeds the mocked registry files and clears the module-level cache. */
function seed(
  pages: Record<string, { title: string; components: string[]; lastSeen: string }>,
  components: ComponentRecord[],
): void {
  files.clear();
  files.set('pages.json', JSON.stringify(pages));
  files.set(
    'components.json',
    JSON.stringify({
      version: '1.0',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      components: Object.fromEntries(components.map((c) => [c.id, c])),
    }),
  );
  invalidateRegistryCache();
}

function page(components: string[]): { title: string; components: string[]; lastSeen: string } {
  return { title: 'Page', components, lastSeen: '2026-01-01T00:00:00.000Z' };
}

beforeEach(() => {
  files.clear();
  invalidateRegistryCache();
});

describe('toolGetPageComponents — path normalization', () => {
  it('finds a page by its plain path', async () => {
    seed({ '/login': page(['cmp-1']) }, [record()]);
    await expect(toolGetPageComponents('/login')).resolves.toContain('Components on /login');
  });

  it('adds a missing leading slash', async () => {
    seed({ '/login': page(['cmp-1']) }, [record()]);
    await expect(toolGetPageComponents('login')).resolves.toContain('Components on /login');
  });

  it('extracts the pathname from a full url', async () => {
    seed({ '/login': page(['cmp-1']) }, [record()]);
    await expect(toolGetPageComponents('https://app.test/login')).resolves.toContain(
      'Components on /login',
    );
  });

  it('drops a query string via the url parse', async () => {
    seed({ '/login': page(['cmp-1']) }, [record()]);
    await expect(toolGetPageComponents('https://app.test/login?next=/home')).resolves.toContain(
      'Components on /login',
    );
  });

  it('trims surrounding whitespace', async () => {
    seed({ '/login': page(['cmp-1']) }, [record()]);
    await expect(toolGetPageComponents('  /login  ')).resolves.toContain('Components on /login');
  });
});

describe('toolGetPageComponents — lookup failures', () => {
  it('lists the known pages when nothing matches', async () => {
    seed({ '/home': page(['cmp-1']), '/about': page([]) }, [record()]);
    const result = await toolGetPageComponents('/nope');

    expect(result).toContain('No page found for "/nope"');
    expect(result).toContain('/home');
    expect(result).toContain('/about');
  });

  it('suggests fuzzy matches when the exact path is absent', async () => {
    seed({ '/login/step-1': page(['cmp-1']), '/login/step-2': page([]) }, [record()]);
    const result = await toolGetPageComponents('/login');

    expect(result).toContain('Did you mean');
    expect(result).toContain('/login/step-1 (1 components)');
    expect(result).toContain('/login/step-2 (0 components)');
  });

  it('reports an empty page rather than rendering nothing', async () => {
    seed({ '/login': page([]) }, [record()]);
    await expect(toolGetPageComponents('/login')).resolves.toBe(
      'Page "/login" has no registered components.',
    );
  });

  it('flags a component id that the registry does not know', async () => {
    seed({ '/login': page(['ghost']) }, [record()]);
    await expect(toolGetPageComponents('/login')).resolves.toContain('[ghost] (not found in registry)');
  });

  it('reports no page found when the registry files are missing entirely', async () => {
    invalidateRegistryCache();
    await expect(toolGetPageComponents('/login')).resolves.toContain('No page found');
  });
});

describe('toolGetPageComponents — component formatting', () => {
  it('renders the core identity fields', async () => {
    seed({ '/login': page(['cmp-1']) }, [record()]);
    const result = await toolGetPageComponents('/login');

    expect(result).toContain('[cmp-1]');
    expect(result).toContain('label: Submit');
    expect(result).toContain('type: button');
    expect(result).toContain('selector: #submit');
    expect(result).toContain('confidence: high (seen 3x)');
  });

  it('omits the testid line when there is none', async () => {
    seed({ '/login': page(['cmp-1']) }, [record()]);
    await expect(toolGetPageComponents('/login')).resolves.not.toContain('testid:');
  });

  it('includes the testid line when present', async () => {
    seed({ '/login': page(['cmp-1']) }, [
      record({
        selectors: { preferred: '#s', aria: '', testid: '[data-testid="go"]', css: null, xpath: null },
      }),
    ]);
    await expect(toolGetPageComponents('/login')).resolves.toContain('testid: [data-testid="go"]');
  });

  it('omits the actions block when there are none', async () => {
    seed({ '/login': page(['cmp-1']) }, [record()]);
    await expect(toolGetPageComponents('/login')).resolves.not.toContain('actions:');
  });

  it('renders an action with its value', async () => {
    seed({ '/login': page(['cmp-1']) }, [
      record({ actions: [{ type: 'fill', value: 'a@b.co' }] }),
    ]);
    const result = await toolGetPageComponents('/login');

    expect(result).toContain('actions:');
    expect(result).toContain('- fill: "a@b.co"');
  });

  it('renders a navigation arrow for an action that navigates', async () => {
    seed({ '/login': page(['cmp-1']) }, [
      record({ actions: [{ type: 'click', navigation: { to: '/home' } }] }),
    ]);
    await expect(toolGetPageComponents('/login')).resolves.toContain('navigates to /home');
  });

  it('renders both assertion lists when populated', async () => {
    seed({ '/login': page(['cmp-1']) }, [
      record({
        assertions: { pre_interaction: ['be.visible', 'be.enabled'], post_interaction: ['not.exist'] },
      }),
    ]);
    const result = await toolGetPageComponents('/login');

    expect(result).toContain('assert before: be.visible, be.enabled');
    expect(result).toContain('assert after:  not.exist');
  });

  it('omits assertion lines when both lists are empty', async () => {
    seed({ '/login': page(['cmp-1']) }, [record()]);
    const result = await toolGetPageComponents('/login');

    expect(result).not.toContain('assert before');
    expect(result).not.toContain('assert after');
  });

  it('includes notes only when present', async () => {
    seed({ '/login': page(['cmp-1']) }, [record({ notes: 'flaky under load' })]);
    await expect(toolGetPageComponents('/login')).resolves.toContain('notes: flaky under load');
  });

  it('renders every component on the page with the total count', async () => {
    seed({ '/login': page(['a', 'b']) }, [
      record({ id: 'a', label: 'Email' }),
      record({ id: 'b', label: 'Password' }),
    ]);
    const result = await toolGetPageComponents('/login');

    expect(result).toContain('(2 total)');
    expect(result).toContain('label: Email');
    expect(result).toContain('label: Password');
  });
});
