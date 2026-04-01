import OpenAI from 'openai';
import { parseDiffJson, type DiffResult } from './utils.js';
import { AttentionMemory } from './attention-memory.js';

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
              { type: 'image_url', image_url: { url: `data:image/png;base64,${oldImageBase64}` } },
              { type: 'text', text: 'New screenshot:' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${newImageBase64}` } },
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
