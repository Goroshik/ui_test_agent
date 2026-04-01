import OpenAI from 'openai';

export async function resolveModel(client: OpenAI): Promise<string> {
  if (process.env.LM_STUDIO_MODEL) {
    return process.env.LM_STUDIO_MODEL;
  }
  const list = await client.models.list();
  const chat = list.data.find((m) => !m.id.includes('embedding'));
  if (!chat) throw new Error('No loaded models found in LM Studio');
  return chat.id;
}

export interface DiffResult {
  changed: boolean;
  summary: string;
}

export function parseDiffJson(input: string): DiffResult | null {
  if (!input) return null;
  const firstBrace = input.indexOf('{');
  const lastBrace = input.lastIndexOf('}');
  const payload = firstBrace >= 0 && lastBrace > firstBrace ? input.slice(firstBrace, lastBrace + 1) : input;

  try {
    const raw = JSON.parse(payload) as { changed?: unknown; summary?: unknown };
    return {
      changed: Boolean(raw.changed),
      summary: typeof raw.summary === 'string' ? raw.summary : '',
    };
  } catch {
    return null;
  }
}
