import OpenAI from 'openai';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { AriaComponent } from '../../pipeline/types.js';

/**
 * Reads all step ARIA snapshots for a session and extracts
 * interactive components via LLM. Output: analyzed/aria-components.json.
 */
export class AriaAnalyzerAgent {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async analyze(sessionDir: string, stepMeta: Array<{ stepId: string; url: string }>): Promise<void> {
    const ariaDir = join(sessionDir, 'raw', 'aria');
    let files: string[];
    try {
      files = (await readdir(ariaDir)).filter((f) => f.endsWith('-aria.yaml'));
    } catch {
      console.log('[AriaAnalyzer] No aria directory, skipping');
      return;
    }

    if (files.length === 0) {
      console.log('[AriaAnalyzer] No ARIA files found');
      return;
    }

    const urlByStepId = Object.fromEntries(stepMeta.map((s) => [s.stepId, s.url]));
    const allComponents: AriaComponent[] = [];

    for (const file of files) {
      const stepId = file.replace('-aria.yaml', '');
      const pageUrl = urlByStepId[stepId] ?? '';
      const content = await readFile(join(ariaDir, file), 'utf-8');

      console.log(`[AriaAnalyzer] Analyzing ${file}…`);
      const components = await this._extract(content, pageUrl, stepId);
      allComponents.push(...components);
    }

    const outPath = join(sessionDir, 'analyzed', 'aria-components.json');
    await writeFile(outPath, JSON.stringify(allComponents, null, 2), 'utf-8');
    console.log(`[AriaAnalyzer] Saved ${allComponents.length} components → ${outPath}`);
  }

  private async _extract(ariaContent: string, pageUrl: string, stepId: string): Promise<AriaComponent[]> {
    const prompt = `You are analyzing an ARIA snapshot of a web page.
Extract ALL interactive elements (buttons, links, inputs, selects, checkboxes, tabs, menu items, etc.).

For each element return a JSON object:
{
  "ariaRole": "button",
  "ariaName": "Checkout",
  "state": { "disabled": false, "checked": null, "expanded": null },
  "context": "inside form[name=cart]",
  "pageUrl": "${pageUrl}",
  "stepId": "${stepId}"
}

ARIA snapshot:
\`\`\`
${ariaContent.slice(0, 8000)}
\`\`\`

Return ONLY a valid JSON array. No explanation.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });

      const text = response.choices[0]?.message?.content ?? '';
      return this._parseJsonArray<AriaComponent>(text);
    } catch (err) {
      console.warn(`[AriaAnalyzer] LLM call failed for ${stepId}:`, (err as Error).message);
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
