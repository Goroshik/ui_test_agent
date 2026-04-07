import OpenAI from 'openai';
import type { ComponentBlock } from './types.js';

const SYSTEM_PROMPT = `You are analyzing a Playwright accessibility tree snapshot.

Identify distinct UI blocks and split the snapshot lines by block.

Return ONLY valid JSON array (no markdown, no extra text):
[
  {"blockName": "top-navbar", "content": "...snapshot lines for this block..."},
  {"blockName": "main-content", "content": "..."},
  ...
]

Rules:
- blockName: lowercase hyphenated, descriptive (e.g. "top-navbar", "sidebar-edit", "policy-list", "footer")
- content: copy only the accessibility tree lines that belong to this block
- Each line goes into exactly one block — no duplicates
- Skip blocks with no meaningful content`;

/** Stage 1: splits a snapshot into named UI blocks. */
export class ComponentSplitter {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async split(snapshotText: string): Promise<ComponentBlock[]> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: snapshotText },
        ],
      });
      const raw = response.choices[0]?.message?.content?.trim() ?? '';
      return this.parse(raw);
    } catch (err) {
      console.warn(`[ComponentSplitter] API error: ${(err as Error).message}`);
      return [];
    }
  }

  private parse(raw: string): ComponentBlock[] {
    try {
      const start = raw.indexOf('[');
      const end = raw.lastIndexOf(']');
      if (start < 0 || end < 0) return [];
      const arr = JSON.parse(raw.slice(start, end + 1)) as unknown[];
      return arr.filter(isBlock);
    } catch {
      console.warn('[ComponentSplitter] Failed to parse JSON response');
      return [];
    }
  }
}

function isBlock(v: unknown): v is ComponentBlock {
  const b = v as Partial<ComponentBlock>;
  return typeof b?.blockName === 'string' && typeof b?.content === 'string' && b.content.trim().length > 0;
}
