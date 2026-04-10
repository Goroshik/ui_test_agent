import OpenAI from 'openai';
import { parseDiffJson, resizeForVision, type DiffResult } from './utils.js';
import { AttentionMemory } from './attention-memory.js';
import { getContentSummary, upsertContentSummary } from './pipeline/content-summary-store.js';

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
    private readonly model: string,
  ) {
    this.memory = new AttentionMemory(client, model, 'screenshot');
  }

  /**
   * Batched approach: describe each image individually → compare text descriptions.
   * Baseline description is cached in data/content-summaries.json to avoid
   * re-sending the baseline image on every comparison run.
   */
  async compare(oldImageBase64: string, newImageBase64: string, key: string): Promise<DiffResult> {
    const guidance = await this.memory.getGuidance();

    const newResized = await resizeForVision(Buffer.from(newImageBase64, 'base64'))
      .then((b) => b.toString('base64'));

    // Step 1: get or create baseline description
    let oldDescription = await getContentSummary(key, 'screenshot');
    if (!oldDescription) {
      const oldResized = await resizeForVision(Buffer.from(oldImageBase64, 'base64'))
        .then((b) => b.toString('base64'));
      oldDescription = await this._describe(oldResized, key);
      await upsertContentSummary(key, 'screenshot', oldDescription);
    }

    // Step 2: describe incoming screenshot
    const newDescription = await this._describe(newResized, key);

    // Step 3: compare descriptions (text only, small context)
    const result = await this._compareDescriptions(oldDescription, newDescription, key, guidance);

    if (result.changed) {
      await upsertContentSummary(key, 'screenshot', newDescription);
      await this.memory.rememberChange(key, result.summary);
    }

    return result;
  }

  private async _describe(resizedBase64: string, key: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Describe this webpage screenshot in under 200 words. Cover: main visible sections, navigation, headings, form fields, buttons, key text content, and UI state (modals, alerts, loading). Be specific about visible labels and values.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Key: ${key}` },
              { type: 'image_url', image_url: { url: toDataUrl(resizedBase64) } },
            ],
          },
        ],
      });
      return response.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      console.warn(`  VisualDiff: describe error: ${(err as Error).message}`);
      return '';
    }
  }

  private async _compareDescriptions(
    oldDescription: string,
    newDescription: string,
    key: string,
    guidance: string,
  ): Promise<DiffResult> {
    if (!oldDescription || !newDescription) {
      return { changed: true, summary: 'Could not describe one or both screenshots; treated as changed.' };
    }
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Compare two webpage state descriptions. Return strict JSON only: {"changed":boolean,"summary":string}. Summary must be short.' +
              (guidance ? `\n\nPast attention rules:\n${guidance}` : ''),
          },
          {
            role: 'user',
            content: `Key: ${key}\n\nOld state:\n${oldDescription}\n\nNew state:\n${newDescription}`,
          },
        ],
      });
      const text = response.choices[0]?.message?.content?.trim() ?? '';
      return parseDiffJson(text) ?? { changed: true, summary: text || 'Non-JSON response; treated as changed.' };
    } catch (err) {
      console.warn(`  VisualDiff: compare error: ${(err as Error).message}`);
      return { changed: true, summary: `Compare unavailable: ${(err as Error).message}` };
    }
  }
}
