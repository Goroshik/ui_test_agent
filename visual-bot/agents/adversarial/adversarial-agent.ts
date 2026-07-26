import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { MCPClient } from '../../mcp-client.js';
import { deriveEdgeCases } from '../../generators/edge-case-deriver.js';
import type {
  ComponentRegistry,
  ComponentRecord,
  SessionMeta,
} from '../../pipeline/types.js';
import type { TestEdgeCase } from '../../generators/test-planner.js';

export interface AdversarialObservation {
  componentId: string;
  page: string;
  edgeType: TestEdgeCase['type'];
  input: string;
  observed: {
    urlChanged: boolean;
    finalUrl: string;
    alertTexts: string[];
    invalidFieldCount: number;
    networkStatus: number | null;
  };
  /** Human-readable expectation derived from what actually happened. */
  expected: string;
}

/** Probe shape returned by the in-page evaluate. */
interface PageState {
  url: string;
  alertTexts: string[];
  invalidFieldCount: number;
}

/**
 * Adversarial pass: replays each grounded "fill" edge case in a REAL browser,
 * submits the form, and records what the app actually did. Those observations
 * become the ground-truth `expected` for negative tests — instead of guessing.
 *
 * Best-effort and read-mostly: every attempt re-navigates to reset state.
 */
export class AdversarialAgent {
  private mcp: MCPClient;

  constructor() {
    this.mcp = new MCPClient();
  }

  async run(sessionDir: string, dataDir: string): Promise<void> {
    const registryPath = join(dataDir, 'registry', 'components.json');
    if (!existsSync(registryPath)) {
      console.log('[Adversarial] No registry — skipping');
      return;
    }
    const registry = JSON.parse(await readFile(registryPath, 'utf-8')) as ComponentRegistry;
    const baseUrl = await this._loadBaseUrl(sessionDir);
    if (!baseUrl) {
      console.log('[Adversarial] No baseUrl in session-meta — skipping');
      return;
    }

    // Group constrained text inputs by page; find a submit per page.
    const byPage = this._inputsByPage(registry);
    if (byPage.size === 0) {
      console.log('[Adversarial] No constrained inputs found — nothing to probe');
      return;
    }

    await this.mcp.connect();
    let observations: AdversarialObservation[];
    try {
      observations = await this._probeAllPages(byPage, baseUrl);
    } finally {
      this.mcp.disconnect();
    }

    const outDir = join(sessionDir, 'analyzed');
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, 'adversarial-observations.json');
    await writeFile(outPath, JSON.stringify(observations, null, 2), 'utf-8');
    console.log(`[Adversarial] ${observations.length} observation(s) → ${outPath}`);
  }

  // ─── Probing ────────────────────────────────────────────────────────────────

  private async _probeAllPages(
    byPage: Map<string, { inputs: ComponentRecord[]; submit: ComponentRecord | null }>,
    baseUrl: string,
  ): Promise<AdversarialObservation[]> {
    const observations: AdversarialObservation[] = [];
    for (const [page, { inputs, submit }] of byPage) {
      const pageUrl = this._fullUrl(baseUrl, page);
      console.log(`[Adversarial] Probing ${page} (${inputs.length} input(s))`);
      const pageObservations = await this._probePageInputs({ pageUrl, page, inputs, submit });
      observations.push(...pageObservations);
    }
    return observations;
  }

  private async _probePageInputs(params: {
    pageUrl: string;
    page: string;
    inputs: ComponentRecord[];
    submit: ComponentRecord | null;
  }): Promise<AdversarialObservation[]> {
    const { pageUrl, page, inputs, submit } = params;
    const observations: AdversarialObservation[] = [];
    for (const input of inputs) {
      const inputObservations = await this._probeInputEdges({ pageUrl, page, input, submit });
      observations.push(...inputObservations);
    }
    return observations;
  }

  private async _probeInputEdges(params: {
    pageUrl: string;
    page: string;
    input: ComponentRecord;
    submit: ComponentRecord | null;
  }): Promise<AdversarialObservation[]> {
    const { pageUrl, page, input, submit } = params;
    const edges = deriveEdgeCases(input).filter(
      (e) => e.action === 'fill' && typeof e.input === 'string',
    );
    const observations: AdversarialObservation[] = [];
    for (const edge of edges) {
      const obs = await this._probe({ pageUrl, page, input, submit, edge });
      if (obs) observations.push(obs);
    }
    return observations;
  }

  private async _probe(params: {
    pageUrl: string;
    page: string;
    input: ComponentRecord;
    submit: ComponentRecord | null;
    edge: TestEdgeCase;
  }): Promise<AdversarialObservation | null> {
    const { pageUrl, page, input, submit, edge } = params;
    const selector = this._selectorOf(input);
    if (!selector) return null;

    // Reset page state.
    await this.mcp.callTool('browser_navigate', { url: pageUrl });
    const before = await this._readState();

    // Fill the bad value into the target field.
    const filled = await this._fillField(input, selector, edge.input ?? '');
    if (!filled) return null; // field not present / not typable

    // Submit: prefer the page's submit button, else press Enter in the field.
    await this._submitForm(submit);

    // Give the app a moment, then read post-submit state.
    await this._wait(600);
    const after = await this._readState();
    const networkStatus = await this._lastNetworkStatus();

    const urlChanged = before.url !== after.url;
    return {
      componentId: input.id,
      page,
      edgeType: edge.type,
      input: edge.input ?? '',
      observed: {
        urlChanged,
        finalUrl: after.url,
        alertTexts: after.alertTexts,
        invalidFieldCount: after.invalidFieldCount,
        networkStatus,
      },
      expected: this._describeExpectation(urlChanged, after, networkStatus),
    };
  }

  private async _fillField(input: ComponentRecord, selector: string, value: string): Promise<boolean> {
    try {
      await this.mcp.callTool('browser_type', {
        element: input.label,
        target: selector,
        text: value,
      });
      return true;
    } catch {
      return false; // field not present / not typable
    }
  }

  private async _submitForm(submit: ComponentRecord | null): Promise<void> {
    if (submit) {
      const submitSel = this._selectorOf(submit);
      if (submitSel) {
        try {
          await this.mcp.callTool('browser_click', { element: submit.label, target: submitSel });
        } catch { /* ignore */ }
      }
      return;
    }
    try {
      await this.mcp.callTool('browser_press_key', { key: 'Enter' });
    } catch { /* ignore */ }
  }

  private _describeExpectation(urlChanged: boolean, after: PageState, status: number | null): string {
    if (urlChanged) {
      return 'form was submitted (navigation occurred) — app accepted the input';
    }
    if (after.alertTexts.length > 0) {
      return `validation error shown: "${after.alertTexts[0]}"`;
    }
    if (after.invalidFieldCount > 0) {
      return 'field marked invalid (aria-invalid / :invalid), form not submitted';
    }
    if (status && status >= 400) {
      return `server rejected with ${status}`;
    }
    return 'form not submitted, no visible error (silent rejection)';
  }

  // ─── In-page state reading ────────────────────────────────────────────────────

  private async _readState(): Promise<PageState> {
    const state = await this.mcp.evaluate<PageState>(`() => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"], [aria-live], .error, .invalid-feedback, [class*="error" i]'))
        .map(e => (e.innerText || e.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 5);
      const invalid = document.querySelectorAll('[aria-invalid="true"], input:invalid, textarea:invalid, select:invalid').length;
      return { url: window.location.href, alertTexts: alerts, invalidFieldCount: invalid };
    }`);
    return state ?? { url: '', alertTexts: [], invalidFieldCount: 0 };
  }

  private async _lastNetworkStatus(): Promise<number | null> {
    try {
      const res = await this.mcp.callTool('browser_network_requests', {});
      const text = Array.isArray(res.content)
        ? res.content.map((c) => c.text ?? '').join('\n')
        : '';
      // Find the last "=> [NNN]" style status in the network log.
      const matches = [...text.matchAll(/=>\s*\[?(\d{3})\]?/g)];
      const last = matches[matches.length - 1];
      return last?.[1] ? parseInt(last[1], 10) : null;
    } catch {
      return null;
    }
  }

  private async _wait(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  // ─── Registry helpers ──────────────────────────────────────────────────────────

  private _inputsByPage(
    registry: ComponentRegistry,
  ): Map<string, { inputs: ComponentRecord[]; submit: ComponentRecord | null }> {
    const result = new Map<string, { inputs: ComponentRecord[]; submit: ComponentRecord | null }>();
    const comps = Object.values(registry.components);

    for (const comp of comps) {
      if (!this._isConstrainedInput(comp)) continue;
      const page = comp.pages[0] ?? '/';
      const entry = result.get(page) ?? { inputs: [], submit: null };
      entry.inputs.push(comp);
      result.set(page, entry);
    }

    // Attach a submit button per page (a button with a network action, or labelled like submit).
    for (const [page, entry] of result) {
      entry.submit = this._findSubmit(comps, page);
    }

    return result;
  }

  private _isConstrainedInput(comp: ComponentRecord): boolean {
    const c = comp.constraints;
    if (!c) return false;
    return comp.componentType === 'textbox' || ['input', 'textarea'].includes(c.inputType ?? '') || Boolean(c.inputType);
  }

  private _findSubmit(comps: ComponentRecord[], page: string): ComponentRecord | null {
    const submit = comps.find(
      (c) =>
        c.pages.includes(page) &&
        (c.componentType === 'button' || c.actions.some((a) => a.type === 'click')) &&
        (/sign in|log\s?in|submit|continue|next|save/i.test(c.label) || c.actions.some((a) => a.network)),
    );
    return submit ?? null;
  }

  private _selectorOf(comp: ComponentRecord): string | null {
    const s = comp.selectors;
    if (s.testid) return this._testidSelector(s.testid);
    if (s.css) return s.css;
    const preferred = s.preferred;
    if (preferred && this._looksLikeCssSelector(preferred)) return preferred;
    return null;
  }

  private _testidSelector(testid: string): string {
    return testid.startsWith('[data-') ? testid : `[data-testid="${testid}"]`;
  }

  private _looksLikeCssSelector(preferred: string): boolean {
    return preferred.startsWith('[data-') || preferred.startsWith('#') || preferred.startsWith('.');
  }

  private _fullUrl(baseUrl: string, page: string): string {
    const base = baseUrl.replace(/\/$/, '');
    const path = page.startsWith('/') ? page : `/${page}`;
    return `${base}${path}`;
  }

  private async _loadBaseUrl(sessionDir: string): Promise<string | null> {
    const metaPath = join(sessionDir, 'session-meta.json');
    if (!existsSync(metaPath)) return null;
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as SessionMeta;
      return meta.baseUrl || null;
    } catch {
      return null;
    }
  }
}
