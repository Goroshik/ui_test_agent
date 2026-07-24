import OpenAI from 'openai';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type {
  StepRecord,
  AriaComponent,
  DomComponent,
  NetworkStepMap,
  ComponentRecord,
  ComponentRegistry,
  ComponentSelectors,
  ComponentAction,
  ValidationConstraints,
  ActionElement,
  DomElementAttrs,
} from '../../pipeline/types.js';

interface AnchorEntry {
  stepId: string;
  url: string;
  testid?: string | null | undefined;
  ariaRole?: string | null | undefined;
  ariaName?: string | null | undefined;
  tagName?: string | null | undefined;
  text?: string | null | undefined;
  ref?: string | null | undefined;
  actionType: string;
  value?: string | undefined;
  constraints?: ValidationConstraints | null | undefined;
}

const RELIABLE_CSS_KINDS = new Set(['testid', 'id', 'aria', 'css']);

function pick<T>(a: T | null | undefined, b: T | null | undefined): T | null | undefined {
  return a ?? b;
}

function elField<K extends keyof ActionElement>(
  el: ActionElement | undefined, key: K,
): ActionElement[K] | undefined {
  return el?.[key];
}

function attrField<K extends keyof DomElementAttrs>(
  attrs: DomElementAttrs | null | undefined, key: K,
): DomElementAttrs[K] | undefined {
  return attrs?.[key];
}

interface MatchResult {
  aria: AriaComponent | null;
  dom: DomComponent | null;
  network: NetworkStepMap | null;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Identity Resolution Agent (Step 5).
 *
 * 1. Reads step-NNN.json files → builds anchor index
 * 2. Reads analyzed/aria-components.json, dom-components.json, network-map.json
 * 3. For each anchor: deterministic matching, then LLM for ambiguous cases
 * 4. Generates canonical component IDs
 * 5. Merges into registry/components.json and registry/pages.json
 */
export class IdentityResolutionAgent {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  private async _loadAnalyzedSources(sessionDir: string): Promise<{
    ariaComponents: AriaComponent[];
    domComponents: DomComponent[];
    networkMap: NetworkStepMap[];
  }> {
    const ariaComponents = await this._loadJson<AriaComponent[]>(
      join(sessionDir, 'analyzed', 'aria-components.json'), [],
    );
    const domComponents = await this._loadJson<DomComponent[]>(
      join(sessionDir, 'analyzed', 'dom-components.json'), [],
    );
    const networkMap = await this._loadJson<NetworkStepMap[]>(
      join(sessionDir, 'analyzed', 'network-map.json'), [],
    );
    return { ariaComponents, domComponents, networkMap };
  }

  private async _matchAnchors(
    anchors: AnchorEntry[],
    ariaComponents: AriaComponent[],
    domComponents: DomComponent[],
    networkMap: NetworkStepMap[],
  ): Promise<ComponentRecord[]> {
    const records: ComponentRecord[] = [];
    for (const anchor of anchors) {
      const match = await this._matchAnchor(anchor, ariaComponents, domComponents, networkMap);
      records.push(this._buildRecord(anchor, match));
    }
    return records;
  }

  private async _mergeIntoRegistry(
    registryDir: string,
    records: ComponentRecord[],
  ): Promise<{ added: number; updated: number }> {
    const registry = await this._loadRegistry(registryDir);
    let added = 0;
    let updated = 0;

    for (const record of records) {
      const existing = registry.components[record.id];
      if (existing) {
        registry.components[record.id] = this._mergeRecord(existing, record);
        updated++;
      } else {
        registry.components[record.id] = record;
        added++;
      }
    }
    registry.lastUpdated = new Date().toISOString();

    await writeFile(
      join(registryDir, 'components.json'),
      JSON.stringify(registry, null, 2),
      'utf-8',
    );
    return { added, updated };
  }

  async run(sessionDir: string, dataDir: string): Promise<void> {
    const steps = await this._loadSteps(sessionDir);
    if (steps.length === 0) {
      console.log('[IdentityResolution] No steps found, skipping');
      return;
    }

    const { ariaComponents, domComponents, networkMap } = await this._loadAnalyzedSources(sessionDir);

    const anchors = this._buildAnchorIndex(steps);
    console.log(`[IdentityResolution] ${anchors.length} anchors from ${steps.length} steps`);

    const newRecords = await this._matchAnchors(anchors, ariaComponents, domComponents, networkMap);

    const observedRecords = this._buildObservedRecords(ariaComponents, anchors);
    console.log(`[IdentityResolution] ${observedRecords.length} observed (non-interacted) components`);

    const registryDir = join(dataDir, 'registry');
    await mkdir(registryDir, { recursive: true });
    const { added, updated } = await this._mergeIntoRegistry(registryDir, [...newRecords, ...observedRecords]);

    await this._updatePages(registryDir, steps, newRecords);

    console.log(`[IdentityResolution] Done. Added: ${added}, updated: ${updated}`);
  }

  // ─── Step loading ─────────────────────────────────────────────────────────────

  private async _loadSteps(sessionDir: string): Promise<StepRecord[]> {
    const stepsDir = join(sessionDir, 'steps');
    if (!existsSync(stepsDir)) return [];
    const { readdir } = await import('fs/promises');
    const files = (await readdir(stepsDir)).filter((f) => f.endsWith('.json')).sort();
    const steps: StepRecord[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(stepsDir, file), 'utf-8');
        const step = JSON.parse(raw) as StepRecord;
        if (step.status === 'complete') steps.push(step);
      } catch {
        // skip corrupt files
      }
    }
    return steps;
  }

  // ─── Anchor index ─────────────────────────────────────────────────────────────

  private _buildAnchorElementFields(el: ActionElement | undefined): Pick<
    AnchorEntry, 'testid' | 'ariaRole' | 'ariaName' | 'tagName' | 'text' | 'ref' | 'constraints'
  > {
    const attrs = elField(el, 'attrs');
    return {
      testid: pick(elField(el, 'testid'), attrField(attrs, 'testid')),
      ariaRole: elField(el, 'ariaRole'),
      ariaName: elField(el, 'ariaName'),
      tagName: pick(elField(el, 'tagName'), attrField(attrs, 'tag')),
      text: pick(elField(el, 'text'), attrField(attrs, 'text')),
      ref: elField(el, 'ref'),
      constraints: attrField(attrs, 'constraints'),
    };
  }

  private _buildAnchorEntry(step: StepRecord): AnchorEntry {
    return {
      stepId: step.stepId,
      url: step.url,
      actionType: step.action.type,
      value: step.action.value,
      ...this._buildAnchorElementFields(step.action.element),
    };
  }

  private _buildAnchorIndex(steps: StepRecord[]): AnchorEntry[] {
    const interactionTypes = new Set(['click', 'fill', 'select', 'hover']);
    return steps
      .filter((s) => interactionTypes.has(s.action.type))
      .map((s) => this._buildAnchorEntry(s));
  }

  // ─── Observed components ─────────────────────────────────────────────────────

  /**
   * Creates ComponentRecords for ARIA components that were visible in snapshots
   * but never interacted with (e.g. navbar links not clicked).
   */
  private _resolvePagePath(url: string): string {
    try {
      return new URL(url.startsWith('http') ? url : `http://x${url}`).pathname;
    } catch {
      return url;
    }
  }

  private _buildObservedRecord(comp: AriaComponent): ComponentRecord {
    const pagePath = this._resolvePagePath(comp.pageUrl);
    const idBase = this._toKebab(pagePath.replace(/^\//, '') || 'home');
    const compSlug = this._toKebab(comp.ariaName);
    const id = `${idBase}__${compSlug}`.slice(0, 80);
    const selector = `${comp.ariaRole}[name="${comp.ariaName}"]`;

    return {
      id,
      label: comp.ariaName,
      componentType: comp.ariaRole,
      pages: [pagePath],
      lastSeen: new Date().toISOString(),
      selectors: { preferred: selector, aria: selector, testid: null, css: null, xpath: null },
      actions: [],
      states: {},
      assertions: { pre_interaction: ['be.visible'], post_interaction: [] },
      confidence: 'low',
      seenCount: 1,
      manualOverride: false,
      notes: 'observed only — not interacted',
    };
  }

  /**
   * Creates ComponentRecords for ARIA components that were visible in snapshots
   * but never interacted with (e.g. navbar links not clicked).
   */
  private _buildObservedRecords(
    ariaComponents: AriaComponent[],
    anchors: AnchorEntry[],
  ): ComponentRecord[] {
    const interacted = new Set(
      anchors
        .filter((a) => a.ariaRole && a.ariaName)
        .map((a) => `${a.url}|${a.ariaRole}|${a.ariaName}`),
    );

    const seen = new Set<string>();
    const records: ComponentRecord[] = [];

    for (const comp of ariaComponents) {
      if (!comp.ariaRole || !comp.ariaName) continue;
      const key = `${comp.pageUrl}|${comp.ariaRole}|${comp.ariaName}`;
      if (interacted.has(key) || seen.has(key)) continue;
      seen.add(key);
      records.push(this._buildObservedRecord(comp));
    }

    return records;
  }

  // ─── Matching ─────────────────────────────────────────────────────────────────

  private _matchAria(
    anchor: AnchorEntry,
    stepAria: AriaComponent[],
  ): { match: AriaComponent | null; confidence: 'high' | 'medium' | 'low' } {
    if (anchor.ariaRole && anchor.ariaName) {
      const strong = stepAria.find(
        (c) => c.ariaRole === anchor.ariaRole && c.ariaName === anchor.ariaName,
      );
      if (strong) return { match: strong, confidence: 'high' };
    }
    if (anchor.ariaName) {
      const weak = stepAria.find((c) => c.ariaName === anchor.ariaName);
      if (weak) return { match: weak, confidence: 'medium' };
    }
    return { match: null, confidence: 'low' };
  }

  private _matchDom(
    anchor: AnchorEntry,
    stepDom: DomComponent[],
  ): { match: DomComponent | null; confidence: 'high' | 'medium' | 'low' } {
    if (anchor.testid) {
      const strong = stepDom.find((c) => c.testid === anchor.testid);
      if (strong) return { match: strong, confidence: 'high' };
    }
    if (anchor.tagName && anchor.text) {
      const byTagText = stepDom.find((c) => c.tagName === anchor.tagName && c.text === anchor.text);
      if (byTagText) return { match: byTagText, confidence: 'medium' };
    }
    if (anchor.ariaName) {
      const byAriaLabel = stepDom.find((c) => c.ariaLabel === anchor.ariaName);
      if (byAriaLabel) return { match: byAriaLabel, confidence: 'medium' };
    }
    return { match: null, confidence: 'low' };
  }

  private async _resolveViaLlmIfAmbiguous(
    anchor: AnchorEntry,
    candidates: { stepAria: AriaComponent[]; stepDom: DomComponent[] },
    deterministic: { aria: AriaComponent | null; dom: DomComponent | null; confidence: 'high' | 'medium' | 'low' },
  ): Promise<{ aria: AriaComponent | null; dom: DomComponent | null }> {
    const { stepAria, stepDom } = candidates;
    if (deterministic.confidence !== 'low' || (stepAria.length === 0 && stepDom.length === 0)) {
      return { aria: deterministic.aria, dom: deterministic.dom };
    }
    const llmResult = await this._llmResolve(anchor, stepAria, stepDom);
    const llmAria = llmResult.ariaIndex !== null ? stepAria[llmResult.ariaIndex] : undefined;
    const llmDom = llmResult.domIndex !== null ? stepDom[llmResult.domIndex] : undefined;
    return { aria: llmAria ?? deterministic.aria, dom: llmDom ?? deterministic.dom };
  }

  private async _matchAnchor(
    anchor: AnchorEntry,
    ariaComponents: AriaComponent[],
    domComponents: DomComponent[],
    networkMap: NetworkStepMap[],
  ): Promise<MatchResult> {
    const stepAria = ariaComponents.filter((c) => c.stepId === anchor.stepId);
    const stepDom = domComponents.filter((c) => c.stepId === anchor.stepId);
    const stepNetwork = networkMap.find((n) => n.stepId === anchor.stepId) ?? null;

    const ariaResult = this._matchAria(anchor, stepAria);
    const domResult = this._matchDom(anchor, stepDom);
    const confidence = this._resolveConfidence(ariaResult.confidence, domResult.confidence);

    const resolved = await this._resolveViaLlmIfAmbiguous(
      anchor,
      { stepAria, stepDom },
      { aria: ariaResult.match, dom: domResult.match, confidence },
    );

    return { aria: resolved.aria, dom: resolved.dom, network: stepNetwork, confidence };
  }

  private _resolveConfidence(
    a: 'high' | 'medium' | 'low',
    b: 'high' | 'medium' | 'low',
  ): 'high' | 'medium' | 'low' {
    const rank = { high: 2, medium: 1, low: 0 };
    const max = Math.max(rank[a], rank[b]);
    return max === 2 ? 'high' : max === 1 ? 'medium' : 'low';
  }

  private _buildLlmResolvePrompt(
    anchor: AnchorEntry,
    ariaList: AriaComponent[],
    domList: DomComponent[],
  ): string {
    return `You are a UI component matching agent.

Anchor element (the element that was interacted with in step ${anchor.stepId}):
${JSON.stringify(anchor, null, 2)}

ARIA snapshot candidates for this step:
${JSON.stringify(ariaList, null, 2)}

DOM snapshot candidates for this step:
${JSON.stringify(domList, null, 2)}

Find which ARIA candidate and which DOM candidate describe the same element as the anchor.
Rules:
- If not sure, set confidence to "low"
- If no match found, use null for that index
- Do not guess — null is better than wrong

Return JSON (only, no explanation):
{
  "ariaMatch": { "index": 0, "confidence": "high|medium|low" },
  "domMatch": { "index": 2, "confidence": "high|medium|low" },
  "reasoning": "brief reason"
}`;
  }

  private _parseLlmResolveResponse(text: string): { ariaIndex: number | null; domIndex: number | null } {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ariaIndex: null, domIndex: null };

    const parsed = JSON.parse(match[0]) as {
      ariaMatch?: { index: number; confidence: string };
      domMatch?: { index: number; confidence: string };
    };

    return {
      ariaIndex: parsed.ariaMatch?.index ?? null,
      domIndex: parsed.domMatch?.index ?? null,
    };
  }

  private async _llmResolve(
    anchor: AnchorEntry,
    ariaList: AriaComponent[],
    domList: DomComponent[],
  ): Promise<{ ariaIndex: number | null; domIndex: number | null }> {
    if (ariaList.length === 0 && domList.length === 0) {
      return { ariaIndex: null, domIndex: null };
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: this._buildLlmResolvePrompt(anchor, ariaList, domList) }],
        temperature: 0,
      });
      const text = response.choices[0]?.message?.content ?? '';
      return this._parseLlmResolveResponse(text);
    } catch {
      return { ariaIndex: null, domIndex: null };
    }
  }

  // ─── Record building ──────────────────────────────────────────────────────────

  private _firstTruthy(values: Array<string | null | undefined>): string | null {
    for (const value of values) {
      if (value) return value;
    }
    return null;
  }

  private _buildRecord(anchor: AnchorEntry, match: MatchResult): ComponentRecord {
    const id = this._generateId(anchor);
    const label = this._firstTruthy([anchor.ariaName, anchor.text, anchor.testid]) ?? id;
    const componentType = this._firstTruthy([anchor.ariaRole, anchor.tagName]) ?? 'unknown';
    const pagePath = this._resolvePagePath(anchor.url);

    const selectors = this._buildSelectors(anchor, match);
    const actions = this._buildActions(anchor, match);
    const constraints = anchor.constraints ?? match.dom?.constraints ?? null;

    return {
      id,
      label,
      componentType,
      pages: [pagePath],
      lastSeen: new Date().toISOString(),
      selectors,
      actions,
      states: {},
      assertions: {
        pre_interaction: ['be.visible', 'be.enabled'],
        post_interaction: [],
      },
      constraints,
      confidence: match.confidence,
      seenCount: 1,
      manualOverride: false,
      notes: '',
    };
  }

  private _resolveTestidSelector(anchor: AnchorEntry, match: MatchResult): string | null {
    const testid = anchor.testid ?? match.dom?.testid ?? null;
    return testid ? `[data-testid="${testid}"]` : null;
  }

  private _resolveAriaSelector(anchor: AnchorEntry, match: MatchResult): string {
    const ariaRole = pick(anchor.ariaRole, match.aria?.ariaRole);
    const ariaName = pick(anchor.ariaName, match.aria?.ariaName);
    if (!ariaRole || !ariaName) return '';
    return `${ariaRole}[name="${ariaName}"]`;
  }

  private _reliableDomCss(domCss: string | null, domKind: string | null): string | null {
    if (!domCss || !domKind) return null;
    return RELIABLE_CSS_KINDS.has(domKind) ? domCss : null;
  }

  // Priority: testid > stable CSS from live evaluate > aria-style locator > any CSS > fallback
  private _resolvePreferredSelector(parts: {
    testidSel: string | null;
    domCss: string | null;
    domKind: string | null;
    aria: string;
    ref: string | null | undefined;
  }): string {
    if (parts.testidSel) return parts.testidSel;
    const reliableCss = this._reliableDomCss(parts.domCss, parts.domKind);
    if (reliableCss) return reliableCss;
    if (parts.aria) return parts.aria;
    if (parts.domCss) return parts.domCss;
    return `[data-ref="${parts.ref ?? ''}"]`;
  }

  private _buildSelectors(anchor: AnchorEntry, match: MatchResult): ComponentSelectors {
    const testidSel = this._resolveTestidSelector(anchor, match);
    const aria = this._resolveAriaSelector(anchor, match);
    const domCss = match.dom?.cssSelector ?? null;
    const domKind = match.dom?.selectorKind ?? null;
    const preferred = this._resolvePreferredSelector({ testidSel, domCss, domKind, aria, ref: anchor.ref });

    return { preferred, aria, testid: testidSel, css: domCss, xpath: null };
  }

  private _buildActions(anchor: AnchorEntry, match: MatchResult): ComponentAction[] {
    const action: ComponentAction = {
      type: anchor.actionType as ComponentAction['type'],
    };

    if (anchor.value) action.value = anchor.value;

    const trigger = match.network?.triggers[0];
    if (trigger) {
      action.network = {
        method: trigger.method,
        urlPattern: trigger.urlPattern,
        expectedStatus: trigger.expectedStatus ?? 200,
        requestShape: trigger.requestPayloadShape as Record<string, unknown>,
        responseShape: trigger.responseShape as Record<string, unknown>,
      };
    }

    return [action];
  }

  // ─── Canonical ID ──────────────────────────────────────────────────────────────

  private _resolveComponentSlug(anchor: AnchorEntry): string {
    const primary = this._firstTruthy([anchor.testid, anchor.ariaName, anchor.text]);
    if (primary) return this._toKebab(primary);
    return `${anchor.tagName ?? 'el'}-${this._shortHash(anchor.ref ?? anchor.stepId)}`;
  }

  private _generateId(anchor: AnchorEntry): string {
    let pageSlug: string;
    try {
      const url = new URL(anchor.url.startsWith('http') ? anchor.url : `http://x${anchor.url}`);
      pageSlug = this._toKebab(url.pathname.replace(/^\//, '') || 'home');
    } catch {
      pageSlug = 'page';
    }

    const componentSlug = this._resolveComponentSlug(anchor);
    return `${pageSlug}__${componentSlug}`.slice(0, 80);
  }

  private _toKebab(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  private _shortHash(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16).slice(0, 4);
  }

  // ─── Registry merge ───────────────────────────────────────────────────────────

  private _mergeRecord(existing: ComponentRecord, newRec: ComponentRecord): ComponentRecord {
    if (existing.manualOverride) return existing;

    return {
      ...existing,
      pages: [...new Set([...existing.pages, ...newRec.pages])],
      selectors: {
        preferred: existing.selectors.preferred,
        aria: newRec.selectors.aria || existing.selectors.aria,
        testid: existing.selectors.testid ?? newRec.selectors.testid,
        css: existing.selectors.css ?? newRec.selectors.css,
        xpath: existing.selectors.xpath ?? newRec.selectors.xpath,
      },
      actions: this._mergeActions(existing.actions, newRec.actions),
      states: { ...existing.states, ...newRec.states },
      constraints: newRec.constraints ?? existing.constraints ?? null,
      assertions: {
        pre_interaction: [
          ...new Set([...existing.assertions.pre_interaction, ...newRec.assertions.pre_interaction]),
        ],
        post_interaction: [
          ...new Set([...existing.assertions.post_interaction, ...newRec.assertions.post_interaction]),
        ],
      },
      confidence: this._upgradeConfidence(existing.confidence, newRec.confidence),
      seenCount: existing.seenCount + 1,
      lastSeen: new Date().toISOString(),
    };
  }

  private _mergeActions(existing: ComponentAction[], incoming: ComponentAction[]): ComponentAction[] {
    const result = [...existing];
    for (const action of incoming) {
      const dupe = result.find(
        (a) => a.type === action.type && a.network?.urlPattern === action.network?.urlPattern,
      );
      if (!dupe) result.push(action);
    }
    return result;
  }

  private _upgradeConfidence(
    a: 'high' | 'medium' | 'low',
    b: 'high' | 'medium' | 'low',
  ): 'high' | 'medium' | 'low' {
    const rank = { high: 2, medium: 1, low: 0 };
    const max = Math.max(rank[a], rank[b]);
    return max === 2 ? 'high' : max === 1 ? 'medium' : 'low';
  }

  // ─── Registry I/O ─────────────────────────────────────────────────────────────

  private async _loadRegistry(registryDir: string): Promise<ComponentRegistry> {
    const path = join(registryDir, 'components.json');
    if (!existsSync(path)) {
      return { version: '1.0', lastUpdated: new Date().toISOString(), components: {} };
    }
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as ComponentRegistry;
    } catch {
      return { version: '1.0', lastUpdated: new Date().toISOString(), components: {} };
    }
  }

  private async _updatePages(
    registryDir: string,
    steps: StepRecord[],
    records: ComponentRecord[],
  ): Promise<void> {
    const path = join(registryDir, 'pages.json');
    let pages: PageRegistry = {};
    if (existsSync(path)) {
      try {
        pages = JSON.parse(await readFile(path, 'utf-8')) as PageRegistry;
      } catch {
        // start fresh
      }
    }

    for (const record of records) {
      for (const pagePath of record.pages) {
        if (!pages[pagePath]) {
          pages[pagePath] = { title: pagePath, components: [], lastSeen: new Date().toISOString() };
        }
        if (!pages[pagePath].components.includes(record.id)) {
          pages[pagePath].components.push(record.id);
        }
        pages[pagePath].lastSeen = new Date().toISOString();
      }
    }

    await writeFile(path, JSON.stringify(pages, null, 2), 'utf-8');
  }

  private async _loadJson<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as T;
    } catch {
      return fallback;
    }
  }
}

interface PageRegistry {
  [urlPath: string]: {
    title: string;
    components: string[];
    lastSeen: string;
  };
}
