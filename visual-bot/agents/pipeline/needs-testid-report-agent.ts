import OpenAI from 'openai';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type {
  ComponentRegistry,
  ComponentRecord,
  ClassifiedComponent,
} from '../../pipeline/types.js';

/** Outcome of grading a component's selectors for test-generation readiness. */
interface SelectorDecision {
  quality: ClassifiedComponent['selectorQuality'];
  classification: ClassifiedComponent['classification'];
  blocking: boolean;
  currentBestSelector: string;
}

/**
 * Reads the freshly merged registry and classifies every component the user
 * interacted with into:
 *   - "ready"           — has a stable selector (data-testid, id, unique aria)
 *   - "needs-attention" — interacted but no stable hook → blocks test gen
 *                         LLM suggests a data-testid name
 *   - "low-priority"    — not interacted, no stable hook (decorative/nav)
 *
 * Outputs:
 *   - data/reports/needs-testid.md       — human-readable for frontend devs
 *   - data/reports/classification.json   — machine-readable for generators
 */
export class NeedsTestIdReportAgent {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async run(dataDir: string): Promise<void> {
    const registryPath = join(dataDir, 'registry', 'components.json');
    if (!existsSync(registryPath)) {
      console.log('[NeedsTestId] No registry — skipping classification');
      return;
    }
    const registry = JSON.parse(await readFile(registryPath, 'utf-8')) as ComponentRegistry;
    const components = Object.values(registry.components);
    if (components.length === 0) {
      console.log('[NeedsTestId] Empty registry');
      return;
    }

    // Step 1 — deterministic classification.
    const classified: ClassifiedComponent[] = components.map((c) => this._classify(c));

    // Step 2 — for "needs-attention" interacted ones, ask LLM to suggest a testid.
    const blockers = classified.filter((c) => c.classification === 'needs-attention' && c.interactedByUser);
    if (blockers.length > 0) {
      console.log(`[NeedsTestId] Asking LLM to name ${blockers.length} missing test ids…`);
      await this._suggestTestIds(blockers);
    }

    // Step 3 — write outputs.
    const reportsDir = join(dataDir, 'reports');
    await mkdir(reportsDir, { recursive: true });

    const jsonPath = join(reportsDir, 'classification.json');
    await writeFile(jsonPath, JSON.stringify(classified, null, 2), 'utf-8');

    const md = this._renderMarkdown(classified);
    const mdPath = join(reportsDir, 'needs-testid.md');
    await writeFile(mdPath, md, 'utf-8');

    const ready = classified.filter((c) => c.classification === 'ready').length;
    const blocking = classified.filter((c) => c.blocking).length;
    const low = classified.filter((c) => c.classification === 'low-priority').length;
    console.log(`[NeedsTestId] ready=${ready}  needs-attention=${blocking}  low-priority=${low}`);
    console.log(`[NeedsTestId] Report → ${mdPath}`);
  }

  // ─── Deterministic classification ────────────────────────────────────────────

  private _classify(c: ComponentRecord): ClassifiedComponent {
    const interacted = c.actions.length > 0;
    const userAction = c.actions[0]?.type ?? null;
    const selectorInfo = this._determineSelector(c.selectors, interacted);

    return {
      componentId: c.id,
      page: c.pages[0] ?? '/',
      ariaRole: c.componentType || null,
      ariaName: c.label || null,
      label: c.label,
      interactedByUser: interacted,
      userAction,
      currentBestSelector: selectorInfo.currentBestSelector,
      selectorQuality: selectorInfo.quality,
      classification: selectorInfo.classification,
      blocking: selectorInfo.blocking,
      suggestion: null,
    };
  }

  // Signature kept on one line: crap4ts matches coverage to a function by span
  // overlap (>=0.8), so a signature long relative to the body sinks the ratio
  // and the function silently reports 0% coverage however well it is tested.
  private _determineSelector(sel: ComponentRecord['selectors'], interacted: boolean): SelectorDecision {
    const testid = sel.testid;
    const css = sel.css;
    const preferred = sel.preferred || '';

    const stableSelector = this._findStableSelector(testid, css, preferred);
    if (stableSelector) {
      return { quality: 'stable', classification: 'ready', blocking: false, currentBestSelector: stableSelector };
    }

    // ARIA-style locator (e.g. `link[name="..."]`) — text-based, fragile in Cypress
    const fallbackSelector = css || preferred;
    return {
      quality: fallbackSelector ? 'text-based' : 'none',
      classification: interacted ? 'needs-attention' : 'low-priority',
      blocking: interacted,
      currentBestSelector: fallbackSelector || '(none)',
    };
  }

  // Signature on one line for the same span-overlap reason as _determineSelector.
  private _findStableSelector(testid: string | null, css: string | null, preferred: string): string | null {
    if (testid && testid !== 'null') return testid;
    if (css) {
      if (/^\[data-(testid|cy|qa|test)=/.test(css)) return css;
      if (/^#[a-z][\w-]*$/i.test(css)) return css;
      // css present but not a stable pattern — falls through to text-based handling
      return null;
    }
    if (preferred && /^\[data-(testid|cy|qa)=/.test(preferred)) return preferred;
    return null;
  }

  // ─── LLM: suggest test-id names ──────────────────────────────────────────────

  private async _suggestTestIds(items: ClassifiedComponent[]): Promise<void> {
    // Batch by page for nicer context.
    const byPage = this._groupByPage(items);
    for (const [page, list] of byPage) {
      await this._suggestForPage(page, list);
    }
  }

  private _groupByPage<T extends { page: string }>(items: T[]): Map<string, T[]> {
    const byPage = new Map<string, T[]>();
    for (const it of items) {
      const arr = byPage.get(it.page) ?? [];
      arr.push(it);
      byPage.set(it.page, arr);
    }
    return byPage;
  }

  private _buildSuggestTestIdPrompt(page: string, list: ClassifiedComponent[]): string {
    return `You are helping name data-testid attributes for a web app.
Page: ${page}

For each component below, propose a stable, lowercase, kebab-case data-testid
that a developer should add to the DOM. The id should describe purpose, not
appearance. Use the page slug as a prefix when ambiguity is likely
(e.g. "login-password-input" rather than "password-input").

Components:
${JSON.stringify(
  list.map((l) => ({
    id: l.componentId,
    role: l.ariaRole,
    name: l.ariaName,
    action: l.userAction,
    currentSelector: l.currentBestSelector,
  })),
  null,
  2,
)}

Return ONLY a JSON array, one entry per component, in the same order:
[
  { "id": "<componentId>", "suggestedTestId": "kebab-case-id", "reason": "<short why>" },
  ...
]`;
  }

  private async _suggestForPage(page: string, list: ClassifiedComponent[]): Promise<void> {
    const prompt = this._buildSuggestTestIdPrompt(page, list);
    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });
      const text = resp.choices[0]?.message?.content ?? '';
      this._applySuggestions(text, list);
    } catch (err) {
      console.warn(`[NeedsTestId] LLM call failed for ${page}: ${(err as Error).message}`);
    }
  }

  private _applySuggestions(text: string, list: ClassifiedComponent[]): void {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const parsed = JSON.parse(match[0]) as Array<{
      id: string;
      suggestedTestId: string;
      reason: string;
    }>;
    const byId = new Map(parsed.map((p) => [p.id, p]));
    for (const it of list) {
      const s = byId.get(it.componentId);
      if (s?.suggestedTestId) {
        it.suggestion = { suggestedTestId: s.suggestedTestId, reason: s.reason ?? '' };
      }
    }
  }

  // ─── Markdown ────────────────────────────────────────────────────────────────

  private _renderMarkdown(classified: ClassifiedComponent[]): string {
    const blockers = classified.filter((c) => c.blocking);
    const lowPriority = classified.filter(
      (c) => !c.blocking && c.classification !== 'ready',
    );

    const lines = this._renderMarkdownHeader();
    lines.push(...this._renderBlockersSection(blockers));
    lines.push(...this._renderLowPrioritySection(lowPriority));

    return lines.join('\n');
  }

  private _renderMarkdownHeader(): string[] {
    return [
      '# Components needing `data-testid`',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      'These components were interacted with during a recorded session but have no',
      'stable selector. The frontend team should add the suggested `data-testid`',
      'attributes; until then, generated tests that depend on them will be `it.skip`.',
      '',
    ];
  }

  private _renderBlockersSection(blockers: ClassifiedComponent[]): string[] {
    const byPage = this._groupByPage(blockers);
    if (byPage.size === 0) {
      return ['🎉 No blocking components — every interacted element has a stable selector.', ''];
    }

    const lines: string[] = [];
    for (const [page, list] of byPage) {
      lines.push(`## \`${page}\``, '');
      for (const c of list) {
        lines.push(...this._renderComponentLines(c));
      }
    }
    return lines;
  }

  private _renderComponentLines(c: ClassifiedComponent): string[] {
    const lines = [
      `### ${c.label} (${c.ariaRole ?? 'unknown'})`,
      `- User action: \`${c.userAction ?? '—'}\``,
      `- Current best selector: \`${c.currentBestSelector}\` (${c.selectorQuality})`,
    ];
    if (c.suggestion) {
      lines.push(`- **Suggested**: \`data-testid="${c.suggestion.suggestedTestId}"\``);
      if (c.suggestion.reason) lines.push(`- Reason: ${c.suggestion.reason}`);
    }
    lines.push(`- Component id: \`${c.componentId}\``, '');
    return lines;
  }

  private _renderLowPrioritySection(lowPriority: ClassifiedComponent[]): string[] {
    if (lowPriority.length === 0) return [];
    return [
      '---',
      '',
      `## Low priority (${lowPriority.length} non-interacted components)`,
      '',
      'Not blocking, but adding `data-testid` would still help future tests.',
      '',
    ];
  }
}
