import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import {
  createProvider,
  usesLocalRuntime,
  DEFAULT_OPENROUTER_MODEL,
  type LlmProvider,
  type ProviderKind,
  type Role,
} from './llm-provider.js';

const ENV_KEYS = [
  'LLM_PROVIDER',
  'MAIN_PROVIDER',
  'PLANNER_PROVIDER',
  'ANALYZER_PROVIDER',
  'CODING_PROVIDER',
  'MAIN_MODEL',
  'PLANNER_MODEL',
  'ANALYZER_MODEL',
  'CODING_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODEL',
  'OPENROUTER_HTTP_REFERER',
  'OPENROUTER_APP_TITLE',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'OLLAMA_MODEL',
  'OLLAMA_MAIN_MODEL',
  'OLLAMA_PLANNER_MODEL',
  'OLLAMA_VALIDATOR_MODEL',
  'OLLAMA_CODING_MODEL',
] as const;

const ROLES: readonly Role[] = ['main', 'planner', 'analyzer', 'coding'];

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  // Every role defaults to OpenRouter, so a key is needed for the client to build.
  process.env.OPENROUTER_API_KEY = 'test-key';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** `baseURL` and `apiKey` are the only public client fields worth asserting on. */
function clientOf(provider: LlmProvider): { baseURL: string; apiKey: string } {
  const { client } = provider;
  return { baseURL: client.baseURL, apiKey: client.apiKey };
}

function stub(kind: ProviderKind): LlmProvider {
  return { kind, model: 'm', client: {} as unknown as OpenAI };
}

describe('DEFAULT_OPENROUTER_MODEL', () => {
  it('is the cheapest DeepSeek slug on OpenRouter', () => {
    expect(DEFAULT_OPENROUTER_MODEL).toBe('deepseek/deepseek-v4-flash');
  });
});

describe('createProvider — defaults', () => {
  it.each(ROLES)('routes role "%s" to OpenRouter with no env configured', (role) => {
    const provider = createProvider(role);

    expect(provider.kind).toBe('openrouter');
    expect(provider.model).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it('points the default client at the OpenRouter endpoint', () => {
    expect(clientOf(createProvider('main'))).toEqual({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
    });
  });

  it('honours a custom OpenRouter base URL', () => {
    process.env.OPENROUTER_BASE_URL = 'https://proxy.example/api/v1';
    expect(clientOf(createProvider('main')).baseURL).toBe('https://proxy.example/api/v1');
  });

  it('fails loudly when the OpenRouter key is missing, naming the role', () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => createProvider('planner')).toThrow(/OPENROUTER_API_KEY is required/);
    expect(() => createProvider('planner')).toThrow(/role="planner"/);
  });
});

describe('createProvider — provider routing', () => {
  it('sends every role to Ollama when LLM_PROVIDER says so', () => {
    process.env.LLM_PROVIDER = 'ollama';
    for (const role of ROLES) {
      expect(createProvider(role).kind).toBe('ollama');
    }
  });

  it('lets a per-role provider override the global one', () => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.CODING_PROVIDER = 'openrouter';

    expect(createProvider('main').kind).toBe('ollama');
    expect(createProvider('coding').kind).toBe('openrouter');
  });

  it('lets a per-role provider opt out of the OpenRouter default', () => {
    process.env.MAIN_PROVIDER = 'ollama';

    expect(createProvider('main').kind).toBe('ollama');
    expect(createProvider('analyzer').kind).toBe('openrouter');
  });

  it('ignores case and surrounding whitespace', () => {
    process.env.MAIN_PROVIDER = '  OLLAMA  ';
    expect(createProvider('main').kind).toBe('ollama');
  });

  it('falls back to the default for an unrecognised provider name', () => {
    process.env.MAIN_PROVIDER = 'lmstudio';
    expect(createProvider('main').kind).toBe('openrouter');
  });

  it('falls back to the default for an empty provider value', () => {
    process.env.LLM_PROVIDER = '';
    process.env.MAIN_PROVIDER = '';
    expect(createProvider('main').kind).toBe('openrouter');
  });
});

describe('createProvider — model selection', () => {
  it('uses OPENROUTER_MODEL as the global default', () => {
    process.env.OPENROUTER_MODEL = 'deepseek/deepseek-v3.2';
    expect(createProvider('analyzer').model).toBe('deepseek/deepseek-v3.2');
  });

  it('lets a per-role model win over OPENROUTER_MODEL', () => {
    process.env.OPENROUTER_MODEL = 'deepseek/deepseek-v3.2';
    process.env.MAIN_MODEL = 'vision/model';

    expect(createProvider('main').model).toBe('vision/model');
    expect(createProvider('planner').model).toBe('deepseek/deepseek-v3.2');
  });

  it('lets a per-role model win for an Ollama role too', () => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MAIN_MODEL = 'from-ollama-env';
    process.env.MAIN_MODEL = 'explicit';

    expect(createProvider('main').model).toBe('explicit');
  });

  it('reads the Ollama model for each role from its own variable', () => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MAIN_MODEL = 'main-m';
    process.env.OLLAMA_PLANNER_MODEL = 'planner-m';
    process.env.OLLAMA_VALIDATOR_MODEL = 'validator-m';
    process.env.OLLAMA_CODING_MODEL = 'coding-m';

    expect(createProvider('main').model).toBe('main-m');
    expect(createProvider('planner').model).toBe('planner-m');
    expect(createProvider('analyzer').model).toBe('validator-m');
    expect(createProvider('coding').model).toBe('coding-m');
  });

  it('falls back from OLLAMA_MAIN_MODEL to the legacy OLLAMA_MODEL', () => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MODEL = 'legacy';

    expect(createProvider('main').model).toBe('legacy');
    expect(createProvider('analyzer').model).toBe('legacy');
  });

  it('falls back from the validator model to the main one for the analyzer', () => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MAIN_MODEL = 'main-m';

    expect(createProvider('analyzer').model).toBe('main-m');
  });

  it('leaves an unpinned Ollama model empty so the caller can probe', () => {
    process.env.LLM_PROVIDER = 'ollama';
    for (const role of ROLES) {
      expect(createProvider(role).model).toBe('');
    }
  });
});

describe('createProvider — Ollama client', () => {
  it('defaults to the local Ollama endpoint', () => {
    process.env.LLM_PROVIDER = 'ollama';
    expect(clientOf(createProvider('main'))).toEqual({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
    });
  });

  it('honours OLLAMA_BASE_URL and OLLAMA_API_KEY', () => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL = 'http://gpu-box:11434/v1';
    process.env.OLLAMA_API_KEY = 'secret';

    expect(clientOf(createProvider('main'))).toEqual({
      baseURL: 'http://gpu-box:11434/v1',
      apiKey: 'secret',
    });
  });

  it('does not require an OpenRouter key', () => {
    process.env.LLM_PROVIDER = 'ollama';
    delete process.env.OPENROUTER_API_KEY;

    expect(() => createProvider('main')).not.toThrow();
  });
});

describe('usesLocalRuntime', () => {
  it('is true when any provider is local', () => {
    expect(usesLocalRuntime([stub('openrouter'), stub('ollama')])).toBe(true);
  });

  it('is false when every provider is remote', () => {
    expect(usesLocalRuntime([stub('openrouter'), stub('openrouter')])).toBe(false);
  });

  it('is false for no providers at all', () => {
    expect(usesLocalRuntime([])).toBe(false);
  });
});
