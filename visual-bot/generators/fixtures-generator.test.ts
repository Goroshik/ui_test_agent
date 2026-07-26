import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FixturesGenerator } from './fixtures-generator.js';
import type { ComponentRecord } from '../pipeline/types.js';

const valueForType = (key: string, type: unknown): unknown =>
  new FixturesGenerator()['_valueForType'](key, type);

describe('FixturesGenerator._valueForType', () => {
  it('builds an id-shaped example for an id type', () => {
    expect(valueForType('user', 'id')).toBe('user-123');
  });

  it('matches "id" case-insensitively and as a substring', () => {
    expect(valueForType('order', 'UUID')).toBe('order-123');
    expect(valueForType('order', 'identifier')).toBe('order-123');
  });

  it('builds a path for a url type', () => {
    expect(valueForType('avatar', 'url')).toBe('/example/avatar');
  });

  for (const numeric of ['number', 'int', 'integer', 'float']) {
    it(`returns 0 for the "${numeric}" type`, () => {
      expect(valueForType('count', numeric)).toBe(0);
    });
  }

  it('returns true for a boolean type', () => {
    expect(valueForType('active', 'bool')).toBe(true);
    expect(valueForType('active', 'boolean')).toBe(true);
  });

  it('returns an empty array for an array type', () => {
    expect(valueForType('items', 'array')).toEqual([]);
  });

  it('falls back to a labelled example string for an unknown type', () => {
    expect(valueForType('title', 'string')).toBe('example-title');
    expect(valueForType('title', 'mystery')).toBe('example-title');
  });

  it('stringifies a non-string type before matching', () => {
    expect(valueForType('count', 42)).toBe('example-count');
    expect(valueForType('flag', null)).toBe('example-flag');
    expect(valueForType('flag', undefined)).toBe('example-flag');
  });

  // Precedence is decided by check order, not by specificity.
  it('prefers the id branch over url when both substrings appear', () => {
    expect(valueForType('x', 'id-url')).toBe('x-123');
  });

  it('prefers the url branch over number when both appear', () => {
    expect(valueForType('x', 'url-number')).toBe('/example/x');
  });

  it('prefers the number branch over bool when both appear', () => {
    expect(valueForType('x', 'int-bool')).toBe(0);
  });

  it('prefers the bool branch over array when both appear', () => {
    expect(valueForType('x', 'bool-array')).toBe(true);
  });
});

describe('FixturesGenerator.generate', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function workDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fg-'));
    tempDirs.push(dir);
    return dir;
  }

  function record(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
    return {
      id: 'login-submit',
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

  /** A generator whose LLM step is stubbed out, so the deterministic
   *  _shapeToExample fallback is what gets written. */
  function offlineGenerator(): FixturesGenerator {
    const generator = new FixturesGenerator();
    generator['_generateFixtureData'] = (): Promise<{ successData?: unknown; errorData?: unknown }> =>
      Promise.resolve({});
    return generator;
  }

  async function writeRegistry(dir: string, components: ComponentRecord[]): Promise<string> {
    const path = join(dir, 'components.json');
    await writeFile(
      path,
      JSON.stringify({
        version: '1.0',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        components: Object.fromEntries(components.map((c) => [c.id, c])),
      }),
      'utf-8',
    );
    return path;
  }

  const networkAction = {
    type: 'click' as const,
    network: {
      method: 'POST',
      urlPattern: '/api/login',
      expectedStatus: 200,
      responseShape: { userId: 'id', name: 'string', active: 'bool' },
    },
  };

  it('does nothing when the registry file is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = await workDir();

    await offlineGenerator().generate(join(dir, 'nope.json'), join(dir, 'fixtures'));

    expect(existsSync(join(dir, 'fixtures'))).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toContain('Registry not found');
  });

  it('does nothing when no component declares a responseShape', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = await workDir();
    const registryPath = await writeRegistry(dir, [record({ actions: [{ type: 'click' }] })]);

    await offlineGenerator().generate(registryPath, join(dir, 'fixtures'));

    expect(existsSync(join(dir, 'fixtures'))).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toContain('No components with network responseShape');
  });

  it('writes a success and an error fixture per network action', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = await workDir();
    const fixturesDir = join(dir, 'fixtures');
    const registryPath = await writeRegistry(dir, [record({ actions: [networkAction] })]);

    await offlineGenerator().generate(registryPath, fixturesDir);

    const written = await readdir(fixturesDir);
    expect(written).toHaveLength(2);
    expect(written.every((f) => f.endsWith('.json'))).toBe(true);
  });

  it('derives the success fixture from the declared response shape', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = await workDir();
    const fixturesDir = join(dir, 'fixtures');
    const registryPath = await writeRegistry(dir, [record({ actions: [networkAction] })]);

    await offlineGenerator().generate(registryPath, fixturesDir);

    const files = await readdir(fixturesDir);
    const successFile = files.find((f) => !f.includes('error'));
    const body = JSON.parse(await readFile(join(fixturesDir, successFile ?? ''), 'utf-8')) as Record<string, unknown>;

    expect(body).toEqual({ userId: 'userId-123', name: 'example-name', active: true });
  });

  it('writes a generic error fixture when the LLM supplies none', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = await workDir();
    const fixturesDir = join(dir, 'fixtures');
    const registryPath = await writeRegistry(dir, [record({ actions: [networkAction] })]);

    await offlineGenerator().generate(registryPath, fixturesDir);

    const files = await readdir(fixturesDir);
    const errorFile = files.find((f) => f.includes('error'));
    const body = JSON.parse(await readFile(join(fixturesDir, errorFile ?? ''), 'utf-8')) as Record<string, unknown>;

    expect(body).toMatchObject({ error: 'REQUEST_FAILED', code: 500 });
  });

  it('skips actions on the component that carry no network shape', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = await workDir();
    const fixturesDir = join(dir, 'fixtures');
    const registryPath = await writeRegistry(dir, [
      record({ actions: [{ type: 'hover' }, networkAction] }),
    ]);

    await offlineGenerator().generate(registryPath, fixturesDir);

    // Only the one network action produces files (2), not the hover.
    expect(await readdir(fixturesDir)).toHaveLength(2);
  });

  it('generates fixtures for several components', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = await workDir();
    const fixturesDir = join(dir, 'fixtures');
    const registryPath = await writeRegistry(dir, [
      record({ id: 'a', actions: [networkAction] }),
      record({ id: 'b', actions: [networkAction] }),
    ]);

    await offlineGenerator().generate(registryPath, fixturesDir);

    expect(await readdir(fixturesDir)).toHaveLength(4);
  });
});
