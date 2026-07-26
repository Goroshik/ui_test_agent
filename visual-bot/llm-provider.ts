import OpenAI from 'openai';

export type ProviderKind = 'ollama' | 'openrouter';
export type Role = 'main' | 'planner' | 'analyzer' | 'coding';

export interface LlmProvider {
  kind: ProviderKind;
  client: OpenAI;
  model: string;
}

/**
 * Cheapest DeepSeek model on OpenRouter as of 2026-07-26: $0.09 / 1M input
 * tokens, $0.18 / 1M output tokens, 1M-token context. DeepSeek reprices often —
 * re-check https://openrouter.ai/deepseek before bumping this.
 *
 * Text-only, which is fine everywhere except one optional path: the browser
 * agent and the task verifier both work off ARIA snapshots, so the only caller
 * that needs vision is the screenshot diff (SCREENSHOT_ANALYSIS_ENABLED).
 */
export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash';

/** Cloud by default — running the bot must not require a local runtime. */
const DEFAULT_PROVIDER: ProviderKind = 'openrouter';

function parseProviderKind(raw: string | undefined): ProviderKind | null {
  const value = raw?.trim().toLowerCase();
  if (value === 'openrouter') return 'openrouter';
  if (value === 'ollama') return 'ollama';
  return null;
}

/** Per-role `<ROLE>_PROVIDER` wins over the global `LLM_PROVIDER`, which wins over the default. */
function readProviderKind(role: Role): ProviderKind {
  const roleKind = parseProviderKind(process.env[`${role.toUpperCase()}_PROVIDER`]);
  return roleKind ?? parseProviderKind(process.env.LLM_PROVIDER) ?? DEFAULT_PROVIDER;
}

/** True when any role still runs against a local Ollama (model load/unload only applies there). */
export function usesLocalRuntime(providers: readonly LlmProvider[]): boolean {
  return providers.some((provider) => provider.kind === 'ollama');
}

const OLLAMA_MODEL_READERS: Record<Role, () => string> = {
  main: () => process.env.OLLAMA_MAIN_MODEL || process.env.OLLAMA_MODEL || '',
  planner: () => process.env.OLLAMA_PLANNER_MODEL || '',
  analyzer: () =>
    process.env.OLLAMA_VALIDATOR_MODEL ||
    process.env.OLLAMA_MAIN_MODEL ||
    process.env.OLLAMA_MODEL ||
    '',
  coding: () => process.env.OLLAMA_CODING_MODEL || '',
};

function readOllamaModelForRole(role: Role): string {
  return OLLAMA_MODEL_READERS[role]();
}

function readModel(role: Role, kind: ProviderKind): string {
  const roleOverride = process.env[`${role.toUpperCase()}_MODEL`];
  if (roleOverride) return roleOverride;

  if (kind === 'openrouter') {
    return process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  }

  return readOllamaModelForRole(role);
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
