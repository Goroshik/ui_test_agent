import OpenAI from 'openai';
import { parseDiffJson, resizeForVision, type DiffResult } from './utils.js';
import { AttentionMemory } from './attention-memory.js';

function detectMime(base64: string): string {
  const head = Buffer.from(base64.slice(0, 16), 'base64');
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/png';
}

function toDataUrl(base64: string): string {
  return `data:${detectMime(base64)};base64,${base64}`;
}

export type { DiffResult as VisualDiffResult };

export class VisualDiff {
  private readonly memory: AttentionMemory;

  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {
    this.memory = new AttentionMemory(client, model, 'screenshot');
  }

  async compare(oldImageBase64: string, newImageBase64: string, key: string): Promise<DiffResult> {
    const guidance = await this.memory.getGuidance();

    const [oldResized, newResized] = await Promise.all([
      resizeForVision(Buffer.from(oldImageBase64, 'base64')).then((b) => b.toString('base64')),
      resizeForVision(Buffer.from(newImageBase64, 'base64')).then((b) => b.toString('base64')),
    ]);

    let text: string;
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Compare two webpage screenshots. Return strict JSON only: {"changed":boolean,"summary":string}. Summary must be short.' +
              (guidance ? `\n\nPast attention rules:\n${guidance}` : ''),
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Old screenshot:' },
              { type: 'image_url', image_url: { url: toDataUrl(oldResized) } },
              { type: 'text', text: 'New screenshot:' },
              { type: 'image_url', image_url: { url: toDataUrl(newResized) } },
            ],
          },
        ],
      });
      text = response.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = (err as Error).message ?? String(err);
      console.warn(`  VisualDiff: API error (${status ?? 'unknown'}): ${message}`);
      // Model may not support vision — treat as changed so no screenshots are silently lost
      return {
        changed: true,
        summary: `Vision comparison unavailable (${status ?? 'error'}): ${message}`,
      };
    }

    const result = parseDiffJson(text) ?? {
      changed: true,
      summary: text || 'Model returned non-JSON response; treated as changed.',
    };

    if (result.changed) {
      await this.memory.rememberChange(key, result.summary);
    }

    return result;
  }
}
