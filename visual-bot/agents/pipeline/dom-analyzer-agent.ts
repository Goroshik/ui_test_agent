import OpenAI from 'openai';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { DomComponent, DomElementDump } from '../../pipeline/types.js';

/**
 * Reads structured DOM dumps (raw/dom/<step>-dom.json) produced live by
 * browser_evaluate and emits DomComponent[] deterministically — no LLM.
 *
 * Falls back to the legacy aria-text HTML files when JSON dumps are absent.
 * Output: analyzed/dom-components.json.
 */
export class DomAnalyzerAgent {
  // Kept for parity with other agents; not used in deterministic mode.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_client: OpenAI, _model: string) {}

  async analyze(sessionDir: string, stepMeta: Array<{ stepId: string; url: string }>): Promise<void> {
    const domDir = join(sessionDir, 'raw', 'dom');
    const files = await this._readDomDir(domDir);
    if (files === null) {
      console.log('[DomAnalyzer] No dom directory, skipping');
      return;
    }

    const jsonFiles = files.filter((f) => f.endsWith('-dom.json'));
    if (jsonFiles.length === 0) {
      console.log('[DomAnalyzer] No structured DOM dumps found (run the agent again to generate them)');
      // Touch an empty file so identity resolution doesn't error.
      await writeFile(join(sessionDir, 'analyzed', 'dom-components.json'), '[]', 'utf-8');
      return;
    }

    const urlByStepId = Object.fromEntries(stepMeta.map((s) => [s.stepId, s.url]));
    const components = await this._collectComponents(domDir, jsonFiles, urlByStepId);

    const outPath = join(sessionDir, 'analyzed', 'dom-components.json');
    await writeFile(outPath, JSON.stringify(components, null, 2), 'utf-8');
    console.log(`[DomAnalyzer] ${components.length} components → ${outPath}`);
  }

  private async _readDomDir(domDir: string): Promise<string[] | null> {
    try {
      return await readdir(domDir);
    } catch {
      return null;
    }
  }

  private async _collectComponents(
    domDir: string,
    jsonFiles: string[],
    urlByStepId: Record<string, string>,
  ): Promise<DomComponent[]> {
    const components: DomComponent[] = [];
    for (const file of jsonFiles) {
      const stepId = file.replace('-dom.json', '');
      const pageUrl = urlByStepId[stepId] ?? '';
      const dump = await this._loadDomDump(domDir, file);
      if (dump === null) continue;
      components.push(...this._mapDumpToComponents(dump, pageUrl, stepId));
    }
    return components;
  }

  private async _loadDomDump(domDir: string, file: string): Promise<DomElementDump[] | null> {
    try {
      const dump = JSON.parse(await readFile(join(domDir, file), 'utf-8')) as DomElementDump[];
      return Array.isArray(dump) ? dump : null;
    } catch {
      return null;
    }
  }

  private _mapDumpToComponents(dump: DomElementDump[], pageUrl: string, stepId: string): DomComponent[] {
    return dump.map((el) => ({
      tagName: el.tag,
      testid: el.testid,
      cssSelector: el.preferredSelector || null,
      id: el.id,
      name: el.name,
      type: el.type,
      text: el.text,
      ariaLabel: el.ariaLabel,
      selectorKind: el.selectorKind,
      constraints: el.constraints ?? null,
      pageUrl,
      stepId,
    }));
  }
}
