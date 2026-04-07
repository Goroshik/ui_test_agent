import OpenAI from 'openai';

const SYSTEM_PROMPT = `Describe this UI component from a Playwright accessibility tree for a QA automation agent.
Cover: purpose, key elements (headings, inputs, buttons, links), and structure.
Be concise — 3 to 5 sentences. Plain text only, no markdown.`;

/** Stage 2: produces a human-readable description of one UI block. */
export class ComponentAnalyzer {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async describe(blockName: string, content: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Component: ${blockName}\n\n${content}` },
        ],
      });
      return response.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      console.warn(`[ComponentAnalyzer] Failed (${blockName}): ${(err as Error).message}`);
      return '';
    }
  }
}
