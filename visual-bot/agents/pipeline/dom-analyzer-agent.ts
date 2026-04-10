import OpenAI from 'openai';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { DomComponent } from '../../pipeline/types.js';

/**
 * Reads DOM snapshot files (stored as accessibility tree content since
 * direct DOM access is not available via MCP) and extracts element attributes
 * useful for selector generation.
 * Output: analyzed/dom-components.json.
 */
export class DomAnalyzerAgent {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async analyze(sessionDir: string, stepMeta: Array<{ stepId: string; url: string }>): Promise<void> {
    const domDir = join(sessionDir, 'raw', 'dom');
    let files: string[];
    try {
      files = (await readdir(domDir)).filter((f) => f.endsWith('-dom.html'));
    } catch {
      console.log('[DomAnalyzer] No dom directory, skipping');
      return;
    }

    if (files.length === 0) {
      console.log('[DomAnalyzer] No DOM files found');
      return;
    }

    const urlByStepId = Object.fromEntries(stepMeta.map((s) => [s.stepId, s.url]));
    const allComponents: DomComponent[] = [];

    for (const file of files) {
      const stepId = file.replace('-dom.html', '');
      const pageUrl = urlByStepId[stepId] ?? '';
      const content = await readFile(join(domDir, file), 'utf-8');

      console.log(`[DomAnalyzer] Analyzing ${file}…`);
      const components = await this._extract(content, pageUrl, stepId);
      allComponents.push(...components);
    }

    const outPath = join(sessionDir, 'analyzed', 'dom-components.json');
    await writeFile(outPath, JSON.stringify(allComponents, null, 2), 'utf-8');
    console.log(`[DomAnalyzer] Saved ${allComponents.length} components → ${outPath}`);
  }

  private async _extract(content: string, pageUrl: string, stepId: string): Promise<DomComponent[]> {
    const prompt = `You are analyzing a snapshot of interactive web page elements.
For each interactive element extract its attributes.

For each element return a JSON object:
{
  "tagName": "button",
  "testid": "checkout-btn",
  "cssSelector": "[data-testid='checkout-btn']",
  "id": null,
  "name": null,
  "type": "submit",
  "text": "Checkout",
  "ariaLabel": "Proceed to checkout",
  "pageUrl": "${pageUrl}",
  "stepId": "${stepId}"
}

Page snapshot:
\`\`\`
${content.slice(0, 8000)}
\`\`\`

Return ONLY a valid JSON array. No explanation.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });

      const text = response.choices[0]?.message?.content ?? '';
      return this._parseJsonArray<DomComponent>(text);
    } catch (err) {
      console.warn(`[DomAnalyzer] LLM call failed for ${stepId}:`, (err as Error).message);
      return [];
    }
  }

  private _parseJsonArray<T>(text: string): T[] {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      return JSON.parse(match[0]) as T[];
    } catch {
      return [];
    }
  }
}
