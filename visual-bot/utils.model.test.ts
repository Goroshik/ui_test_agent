import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { resolveModel, resolveAuxModel } from './utils.js';

interface StubOptions {
  baseURL?: string;
  models?: string[];
  listRejects?: boolean;
}

/** resolveModel only reaches for `baseURL` and `models.list()`. */
function stubClient(options: StubOptions = {}): OpenAI {
  const { baseURL, models = [], listRejects = false } = options;
  return {
    baseURL,
    models: {
      list: (): Promise<{ data: Array<{ id: string }> }> =>
        listRejects
          ? Promise.reject(new Error('models.list unavailable'))
          : Promise.resolve({ data: models.map((id) => ({ id })) }),
    },
  } as unknown as OpenAI;
}

/** Builds a fetch stub that answers /api/ps with the given payload. */
function psFetch(payload: unknown, ok = true): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok,
      json: () => Promise.resolve(payload),
    } as Response),
  );
}

const MODEL_ENV = ['OLLAMA_MAIN_MODEL', 'OLLAMA_MODEL', 'OLLAMA_AUX_MODEL'] as const;

describe('resolveModel', () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of MODEL_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MODEL_ENV) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the explicit override before consulting anything else', async () => {
    process.env.OLLAMA_MAIN_MODEL = 'from-env';
    await expect(resolveModel(stubClient(), 'explicit-model')).resolves.toBe('explicit-model');
  });

  it('prefers OLLAMA_MAIN_MODEL over OLLAMA_MODEL', async () => {
    process.env.OLLAMA_MAIN_MODEL = 'main';
    process.env.OLLAMA_MODEL = 'legacy';
    await expect(resolveModel(stubClient())).resolves.toBe('main');
  });

  it('falls back to OLLAMA_MODEL when OLLAMA_MAIN_MODEL is unset', async () => {
    process.env.OLLAMA_MODEL = 'legacy';
    await expect(resolveModel(stubClient())).resolves.toBe('legacy');
  });

  it('uses the currently loaded Ollama model reported by /api/ps', async () => {
    const fetchStub = psFetch({ models: [{ name: 'loaded-model' }] });
    vi.stubGlobal('fetch', fetchStub);

    await expect(resolveModel(stubClient({ baseURL: 'http://localhost:11434/v1' }))).resolves.toBe(
      'loaded-model',
    );
    // The /v1 suffix must be stripped before hitting the native Ollama endpoint.
    expect(fetchStub).toHaveBeenCalledWith('http://localhost:11434/api/ps');
  });

  it('accepts the "model" field when /api/ps omits "name"', async () => {
    vi.stubGlobal('fetch', psFetch({ models: [{ model: 'by-model-field' }] }));
    await expect(
      resolveModel(stubClient({ baseURL: 'http://localhost:11434/v1' })),
    ).resolves.toBe('by-model-field');
  });

  it('strips a trailing slash after /v1 when building the ps URL', async () => {
    const fetchStub = psFetch({ models: [{ name: 'm' }] });
    vi.stubGlobal('fetch', fetchStub);

    await resolveModel(stubClient({ baseURL: 'http://localhost:11434/v1/' }));
    expect(fetchStub).toHaveBeenCalledWith('http://localhost:11434/api/ps');
  });

  it('falls through to the installed-model list when /api/ps returns not-ok', async () => {
    vi.stubGlobal('fetch', psFetch({}, false));
    await expect(
      resolveModel(stubClient({ baseURL: 'http://x/v1', models: ['installed-a'] })),
    ).resolves.toBe('installed-a');
  });

  it('falls through when /api/ps reports no loaded models', async () => {
    vi.stubGlobal('fetch', psFetch({ models: [] }));
    await expect(
      resolveModel(stubClient({ baseURL: 'http://x/v1', models: ['installed-a'] })),
    ).resolves.toBe('installed-a');
  });

  it('falls through when the ps payload has no models key at all', async () => {
    vi.stubGlobal('fetch', psFetch({}));
    await expect(
      resolveModel(stubClient({ baseURL: 'http://x/v1', models: ['installed-a'] })),
    ).resolves.toBe('installed-a');
  });

  it('swallows a network error from /api/ps and falls through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    await expect(
      resolveModel(stubClient({ baseURL: 'http://x/v1', models: ['installed-a'] })),
    ).resolves.toBe('installed-a');
  });

  it('skips the ps probe entirely when the client has no baseURL', async () => {
    const fetchStub = psFetch({ models: [{ name: 'should-not-be-used' }] });
    vi.stubGlobal('fetch', fetchStub);

    await expect(resolveModel(stubClient({ models: ['installed-a'] }))).resolves.toBe(
      'installed-a',
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('skips embedding models when picking from the installed list', async () => {
    vi.stubGlobal('fetch', psFetch({ models: [] }));
    await expect(
      resolveModel(
        stubClient({ baseURL: 'http://x/v1', models: ['nomic-embedding-text', 'qwen-chat'] }),
      ),
    ).resolves.toBe('qwen-chat');
  });

  it('throws a descriptive error when nothing is loaded and nothing is installed', async () => {
    vi.stubGlobal('fetch', psFetch({ models: [] }));
    await expect(
      resolveModel(stubClient({ baseURL: 'http://x/v1', models: [] })),
    ).rejects.toThrow(/No models available in Ollama/);
  });

  it('throws when the only installed models are embedding models', async () => {
    vi.stubGlobal('fetch', psFetch({ models: [] }));
    await expect(
      resolveModel(stubClient({ baseURL: 'http://x/v1', models: ['text-embedding-3'] })),
    ).rejects.toThrow(/No models available in Ollama/);
  });
});

describe('resolveAuxModel', () => {
  const saved = process.env.OLLAMA_AUX_MODEL;

  afterEach(() => {
    if (saved === undefined) delete process.env.OLLAMA_AUX_MODEL;
    else process.env.OLLAMA_AUX_MODEL = saved;
  });

  it('returns the configured aux model', () => {
    process.env.OLLAMA_AUX_MODEL = 'aux-model';
    expect(resolveAuxModel()).toBe('aux-model');
  });

  it('returns undefined when unset', () => {
    delete process.env.OLLAMA_AUX_MODEL;
    expect(resolveAuxModel()).toBeUndefined();
  });
});
