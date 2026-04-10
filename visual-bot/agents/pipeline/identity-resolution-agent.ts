import OpenAI from 'openai';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type {
  StepRecord,
  AriaComponent,
  DomComponent,
  NetworkStepMap,
  ComponentRecord,
  ComponentRegistry,
  ComponentSelectors,
  ComponentAction,
} from '../../pipeline/types.js';

interface AnchorEntry {
  stepId: string;
  url: string;
  testid?: string | null;
  ariaRole?: string | null;
  ariaName?: string | null;
  tagName?: string | null;
  text?: string | null;
  ref?: string | null;
  actionType: string;
  value?: string;
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

  async run(sessionDir: string, dataDir: string): Promise<void> {
    // 1. Load all step records
    const steps = await this._loadSteps(sessionDir);
    if (steps.length === 0) {
      console.log('[IdentityResolution] No steps found, skipping');
      return;
    }

    // 2. Load analyzed sources
    const ariaComponents = await this._loadJson<AriaComponent[]>(
      join(sessionDir, 'analyzed', 'aria-components.json'), [],
    );
    const domComponents = await this._loadJson<DomComponent[]>(
      join(sessionDir, 'analyzed', 'dom-components.json'), [],
    );
    const networkMap = await this._loadJson<NetworkStepMap[]>(
      join(sessionDir, 'analyzed', 'network-map.json'), [],
    );

    // 3. Build anchor index from steps (only interaction steps)
    const anchors = this._buildAnchorIndex(steps);
    console.log(`[IdentityResolution] ${anchors.length} anchors from ${steps.length} steps`);

    // 4. Match each anchor to sources
    const newRecords: ComponentRecord[] = [];
    for (const anchor of anchors) {
      const match = await this._matchAnchor(anchor, ariaComponents, domComponents, networkMap);
      const record = this._buildRecord(anchor, match);
      newRecords.push(record);
    }

    // 4b. Register observed (non-interacted) ARIA components
    const observedRecords = this._buildObservedRecords(ariaComponents, anchors);
    console.log(`[IdentityResolution] ${observedRecords.length} observed (non-interacted) components`);

    // 5. Merge into registry
    const registryDir = join(dataDir, 'registry');
    await mkdir(registryDir, { recursive: true });

    const registry = await this._loadRegistry(registryDir);
    let added = 0;
    let updated = 0;

    for (const record of [...newRecords, ...observedRecords]) {
      if (registry.components[record.id]) {
        registry.components[record.id] = this._mergeRecord(registry.components[record.id], record);
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

    // 6. Update pages.json
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

  private _buildAnchorIndex(steps: StepRecord[]): AnchorEntry[] {
    const interactionTypes = new Set(['click', 'fill', 'select', 'hover']);
    return steps
      .filter((s) => interactionTypes.has(s.action.type))
      .map((s) => ({
        stepId: s.stepId,
        url: s.url,
        testid: s.action.element?.testid,
        ariaRole: s.action.element?.ariaRole,
        ariaName: s.action.element?.ariaName,
        tagName: s.action.element?.tagName,
        text: s.action.element?.text,
        ref: s.action.element?.ref,
        actionType: s.action.type,
        value: s.action.value,
      }));
  }

  // ─── Observed components ─────────────────────────────────────────────────────

  /**
   * Creates ComponentRecords for ARIA components that were visible in snapshots
   * but never interacted with (e.g. navbar links not clicked).
   */
  private _buildObservedRecords(
    ariaComponents: AriaComponent[],
    anchors: AnchorEntry[],
  ): ComponentRecord[] {
    // Build a set of (pageUrl, ariaRole, ariaName) for interacted anchors
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

      let pagePath: string;
      try {
        pagePath = new URL(comp.pageUrl.startsWith('http') ? comp.pageUrl : `http://x${comp.pageUrl}`).pathname;
      } catch {
        pagePath = comp.pageUrl;
      }

      const idBase = this._toKebab(pagePath.replace(/^\//, '') || 'home');
      const compSlug = this._toKebab(comp.ariaName);
      const id = `${idBase}__${compSlug}`.slice(0, 80);

      records.push({
        id,
        label: comp.ariaName,
        componentType: comp.ariaRole,
        pages: [pagePath],
        lastSeen: new Date().toISOString(),
        selectors: {
          preferred: `${comp.ariaRole}[name="${comp.ariaName}"]`,
          aria: `${comp.ariaRole}[name="${comp.ariaName}"]`,
          testid: null,
          css: null,
          xpath: null,
        },
        actions: [],
        states: {},
        assertions: { pre_interaction: ['be.visible'], post_interaction: [] },
        confidence: 'low',
        seenCount: 1,
        manualOverride: false,
        notes: 'observed only — not interacted',
      });
    }

    return records;
  }

  // ─── Matching ─────────────────────────────────────────────────────────────────

  private async _matchAnchor(
    anchor: AnchorEntry,
    ariaComponents: AriaComponent[],
    domComponents: DomComponent[],
    networkMap: NetworkStepMap[],
  ): Promise<MatchResult> {
    // Filter to same step
    const stepAria = ariaComponents.filter((c) => c.stepId === anchor.stepId);
    const stepDom = domComponents.filter((c) => c.stepId === anchor.stepId);
    const stepNetwork = networkMap.find((n) => n.stepId === anchor.stepId) ?? null;

    // Deterministic ARIA match
    let ariaMatch: AriaComponent | null = null;
    let ariaConfidence: 'high' | 'medium' | 'low' = 'low';

    if (anchor.ariaRole && anchor.ariaName) {
      const strongAria = stepAria.find(
        (c) => c.ariaRole === anchor.ariaRole && c.ariaName === anchor.ariaName,
      );
      if (strongAria) {
        ariaMatch = strongAria;
        ariaConfidence = 'high';
      }
    }
    if (!ariaMatch && anchor.ariaName) {
      const weakAria = stepAria.find((c) => c.ariaName === anchor.ariaName);
      if (weakAria) {
        ariaMatch = weakAria;
        ariaConfidence = 'medium';
      }
    }

    // Deterministic DOM match
    let domMatch: DomComponent | null = null;
    let domConfidence: 'high' | 'medium' | 'low' = 'low';

    if (anchor.testid) {
      const strongDom = stepDom.find((c) => c.testid === anchor.testid);
      if (strongDom) {
        domMatch = strongDom;
        domConfidence = 'high';
      }
    }
    if (!domMatch && anchor.tagName && anchor.text) {
      const medDom = stepDom.find(
        (c) => c.tagName === anchor.tagName && c.text === anchor.text,
      );
      if (medDom) {
        domMatch = medDom;
        domConfidence = 'medium';
      }
    }
    if (!domMatch && anchor.ariaName) {
      const medDom2 = stepDom.find((c) => c.ariaLabel === anchor.ariaName);
      if (medDom2) {
        domMatch = medDom2;
        domConfidence = 'medium';
      }
    }

    // If ambiguous, try LLM
    const overallConfidence = this._resolveConfidence(ariaConfidence, domConfidence);
    if (overallConfidence === 'low' && (stepAria.length > 0 || stepDom.length > 0)) {
      const llmResult = await this._llmResolve(anchor, stepAria, stepDom);
      if (llmResult.ariaIndex !== null && stepAria[llmResult.ariaIndex]) {
        ariaMatch = stepAria[llmResult.ariaIndex];
      }
      if (llmResult.domIndex !== null && stepDom[llmResult.domIndex]) {
        domMatch = stepDom[llmResult.domIndex];
      }
    }

    return {
      aria: ariaMatch,
      dom: domMatch,
      network: stepNetwork,
      confidence: overallConfidence,
    };
  }

  private _resolveConfidence(
    a: 'high' | 'medium' | 'low',
    b: 'high' | 'medium' | 'low',
  ): 'high' | 'medium' | 'low' {
    const rank = { high: 2, medium: 1, low: 0 };
    const max = Math.max(rank[a], rank[b]);
    return max === 2 ? 'high' : max === 1 ? 'medium' : 'low';
  }

  private async _llmResolve(
    anchor: AnchorEntry,
    ariaList: AriaComponent[],
    domList: DomComponent[],
  ): Promise<{ ariaIndex: number | null; domIndex: number | null }> {
    if (ariaList.length === 0 && domList.length === 0) {
      return { ariaIndex: null, domIndex: null };
    }

    const prompt = `You are a UI component matching agent.

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

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });

      const text = response.choices[0]?.message?.content ?? '';
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
    } catch {
      return { ariaIndex: null, domIndex: null };
    }
  }

  // ─── Record building ──────────────────────────────────────────────────────────

  private _buildRecord(anchor: AnchorEntry, match: MatchResult): ComponentRecord {
    const id = this._generateId(anchor);
    const label = anchor.ariaName || anchor.text || anchor.testid || id;
    const componentType = anchor.ariaRole || anchor.tagName || 'unknown';
    const pageUrl = new URL(anchor.url.startsWith('http') ? anchor.url : `http://x${anchor.url}`);
    const pagePath = pageUrl.pathname;

    const selectors = this._buildSelectors(anchor, match);
    const actions = this._buildActions(anchor, match);

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
      confidence: match.confidence,
      seenCount: 1,
      manualOverride: false,
      notes: '',
    };
  }

  private _buildSelectors(anchor: AnchorEntry, match: MatchResult): ComponentSelectors {
    const testid = anchor.testid ?? match.dom?.testid ?? null;
    const ariaRole = anchor.ariaRole ?? match.aria?.ariaRole ?? null;
    const ariaName = anchor.ariaName ?? match.aria?.ariaName ?? null;
    const css = match.dom?.cssSelector ?? null;

    const aria = ariaRole && ariaName ? `${ariaRole}[name="${ariaName}"]` : '';
    const testidSel = testid ? `[data-testid="${testid}"]` : null;

    let preferred: string;
    if (testidSel) {
      preferred = testidSel;
    } else if (aria) {
      preferred = aria;
    } else if (css) {
      preferred = css;
    } else {
      preferred = `[data-ref="${anchor.ref ?? ''}"]`;
    }

    return { preferred, aria, testid: testidSel, css, xpath: null };
  }

  private _buildActions(anchor: AnchorEntry, match: MatchResult): ComponentAction[] {
    const action: ComponentAction = {
      type: anchor.actionType as ComponentAction['type'],
    };

    if (anchor.value) action.value = anchor.value;

    if (match.network && match.network.triggers.length > 0) {
      const trigger = match.network.triggers[0];
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

  private _generateId(anchor: AnchorEntry): string {
    let pageSlug: string;
    try {
      const url = new URL(anchor.url.startsWith('http') ? anchor.url : `http://x${anchor.url}`);
      pageSlug = this._toKebab(url.pathname.replace(/^\//, '') || 'home');
    } catch {
      pageSlug = 'page';
    }

    let componentSlug: string;
    if (anchor.testid) {
      componentSlug = this._toKebab(anchor.testid);
    } else if (anchor.ariaName) {
      componentSlug = this._toKebab(anchor.ariaName);
    } else if (anchor.text) {
      componentSlug = this._toKebab(anchor.text);
    } else {
      componentSlug = `${anchor.tagName ?? 'el'}-${this._shortHash(anchor.ref ?? anchor.stepId)}`;
    }

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
