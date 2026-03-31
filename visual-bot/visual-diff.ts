import OpenAI from 'openai';

export interface VisualDiffResult {
  changed: boolean;
  summary: string;
}

export class VisualDiff {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

  async compare(oldImageBase64: string, newImageBase64: string): Promise<VisualDiffResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Compare two webpage screenshots. Return strict JSON only: {"changed":boolean,"summary":string}. Summary must be short.',
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

    const text = response.choices[0]?.message?.content?.trim() || '';
    const parsed = this.safeParse(text);
    if (parsed) return parsed;

    return {
      changed: true,
      summary: text || 'Model returned non-JSON response; treat as changed.',
    };
  }

  private safeParse(input: string): VisualDiffResult | null {
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
}
