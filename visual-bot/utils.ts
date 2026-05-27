import OpenAI from 'openai';
import sharp from 'sharp';

export async function resolveModel(client: OpenAI, override?: string): Promise<string> {
  if (override) return override;
  const model = process.env.OLLAMA_MAIN_MODEL || process.env.OLLAMA_MODEL;
  if (model) return model;

  // Try Ollama's /api/ps — return whatever's currently loaded (no pin).
  const loaded = await fetchOllamaLoadedModel(client);
  if (loaded) return loaded;

  // Fallback: any installed model (Ollama exposes them via OpenAI-compat /v1/models).
  const list = await client.models.list();
  const chat = list.data.find((m) => !m.id.includes('embedding'));
  if (!chat) throw new Error('No models available in Ollama (none loaded, none installed)');
  return chat.id;
}

async function fetchOllamaLoadedModel(client: OpenAI): Promise<string | null> {
  const baseUrl = String((client as unknown as { baseURL?: string }).baseURL ?? '');
  if (!baseUrl) return null;
  const root = baseUrl.replace(/\/v1\/?$/, '');
  try {
    const resp = await fetch(`${root}/api/ps`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { models?: Array<{ name?: string; model?: string }> };
    const first = data.models?.[0];
    return first?.name || first?.model || null;
  } catch {
    return null;
  }
}

export function resolveAuxModel(): string | undefined {
  return process.env.OLLAMA_AUX_MODEL;
}

const VISION_SIZE = parseInt(process.env.VISION_MAX_WIDTH || '512', 10);

/**
 * Resize image to fit within VISION_SIZE x VISION_SIZE (preserving aspect ratio).
 * Returns a PNG buffer.
 */
export async function resizeForVision(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .resize({ width: VISION_SIZE, height: VISION_SIZE, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
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
