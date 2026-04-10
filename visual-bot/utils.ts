import OpenAI from 'openai';
import sharp from 'sharp';

export async function resolveModel(client: OpenAI, override?: string): Promise<string> {
  if (override) return override;
  const model = process.env.LM_STUDIO_MAIN_MODEL || process.env.LM_STUDIO_MODEL;
  if (model) return model;
  const list = await client.models.list();
  const chat = list.data.find((m) => !m.id.includes('embedding'));
  if (!chat) throw new Error('No loaded models found in LM Studio');
  return chat.id;
}

export function resolveAuxModel(): string | undefined {
  return process.env.LM_STUDIO_AUX_MODEL;
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
