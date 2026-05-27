import OpenAI from 'openai';

export type ProviderKind = 'ollama' | 'openrouter';
export type Role = 'main' | 'planner' | 'analyzer' | 'coding';

export interface LlmProvider {
  kind: ProviderKind;
  client: OpenAI;
  model: string;
}

const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-haiku-4.5';

function readProviderKind(role: Role): ProviderKind {
  const raw = process.env[`${role.toUpperCase()}_PROVIDER`]?.toLowerCase();
  if (raw === 'openrouter') return 'openrouter';
  if (raw === 'ollama') return 'ollama';
  return role === 'coding' ? 'openrouter' : 'ollama';
}

function readModel(role: Role, kind: ProviderKind): string {
  const roleOverride = process.env[`${role.toUpperCase()}_MODEL`];
  if (roleOverride) return roleOverride;

  if (kind === 'openrouter') {
    return process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  }

  switch (role) {
    case 'main':
      return process.env.OLLAMA_MAIN_MODEL || process.env.OLLAMA_MODEL || '';
    case 'planner':
      return process.env.OLLAMA_PLANNER_MODEL || '';
    case 'analyzer':
      return (
        process.env.OLLAMA_VALIDATOR_MODEL ||
        process.env.OLLAMA_MAIN_MODEL ||
        process.env.OLLAMA_MODEL ||
        ''
      );
    case 'coding':
      return process.env.OLLAMA_CODING_MODEL || '';
  }
}

function buildOpenRouterClient(role: Role): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(`OPENROUTER_API_KEY is required (role="${role}" uses openrouter)`);
  }
  return new OpenAI({
    baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey,
    defaultHeaders: {
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://github.com/visual-bot',
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'visual-bot',
    },
  });
}

function buildOllamaClient(): OpenAI {
  return new OpenAI({
    baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    apiKey: process.env.OLLAMA_API_KEY || 'ollama',
  });
}

export function createProvider(role: Role): LlmProvider {
  const kind = readProviderKind(role);
  const client = kind === 'openrouter' ? buildOpenRouterClient(role) : buildOllamaClient();
  return { kind, client, model: readModel(role, kind) };
}
