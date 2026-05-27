import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import type {
  StepRecord,
  ComponentRecord,
  ComponentRegistry,
  SessionMeta,
} from '../pipeline/types.js';
import { runLlm } from '../agents/test-gen/llm-runner.js';
import { deriveEdgeCases } from './edge-case-deriver.js';
import type { ClassifiedComponent } from '../pipeline/types.js';
import type { AdversarialObservation } from '../agents/adversarial/adversarial-agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Test Plan types ──────────────────────────────────────────────────────────

export type EdgeCaseType =
  | 'empty-state'
  | 'disabled'
  | 'network-error'
  | 'network-timeout'
  | 'loading-state'
  | 'hidden'
  // Input-validation derived (grounded in DOM constraints / real network)
  | 'required-empty'
  | 'maxlength-exceeded'
  | 'minlength-short'
  | 'pattern-mismatch'
  | 'invalid-email'
  | 'invalid-url'
  | 'out-of-range'
  | 'wrong-type'
  | 'whitespace-only'
  | 'xss-injection'
  | 'sql-injection'
  | 'network-status'; // real non-2xx status the API was seen to return

export interface TestEdgeCase {
  type: EdgeCaseType;
  component: string;
  action?: string;
  description: string;
  /** Concrete input value to feed (when applicable). */
  input?: string;
  /** Expected outcome to assert (when known). */
  expected?: string;
  /** Where this case came from — for trust/debugging. */
  source?: 'dom-constraint' | 'network-observed' | 'static-catalog' | 'llm';
}

export interface TestScenario {
  id: string;
  page: string;
  name: string;
  file: string;
  priority: 'high' | 'medium' | 'low';
  sessionId: string;
  stepIds: string[];
  componentIds: string[];
  edgeCases: TestEdgeCase[];
  fixtureFiles: string[];
  description: string;
  notes: string;
}

export interface TestPlan {
  version: '1.0';
  generatedAt: string;
  goal?: string;
  sessions: string[];
  scenarios: TestScenario[];
  summary: {
    total: number;
    byPriority: { high: number; medium: number; low: number };
    byPage: Record<string, number>;
  };
}

// ─── Planner ──────────────────────────────────────────────────────────────────

export class TestPlanner {
  /** componentId → grounded edge cases (DOM constraints + network). */
  private derivedEdges = new Map<string, TestEdgeCase[]>();
  /** componentIds with no stable selector — excluded from scenarios. */
  private blockingIds = new Set<string>();

  async plan(
    sessionsDir: string,
    registryPath: string,
    outputPath: string,
    sessionId?: string,
    limit = 10,
    goal?: string,
  ): Promise<TestPlan> {
    if (!existsSync(registryPath)) {
      throw new Error(`Registry not found: ${registryPath}`);
    }
    const registry: ComponentRegistry = JSON.parse(await readFile(registryPath, 'utf-8'));

    // Load adversarial observations (if a probe run produced them) → real `expected`.
    const observations = await this._loadObservations(sessionsDir, sessionId);

    // Precompute grounded edge cases for every component (deterministic).
    this.derivedEdges.clear();
    for (const comp of Object.values(registry.components)) {
      const edges = deriveEdgeCases(comp);
      // Override `expected` with observed reality where we probed it.
      for (const e of edges) {
        const obs = observations.find(
          (o) => o.componentId === e.component && o.input === (e.input ?? '') && o.edgeType === e.type,
        );
        if (obs) {
          e.expected = obs.expected;
          e.source = 'network-observed';
        }
      }
      if (edges.length > 0) this.derivedEdges.set(comp.id, edges);
    }

    // Load classification report (if present) → know which components are blocking.
    this.blockingIds = await this._loadBlockingIds(registryPath);
    if (this.blockingIds.size > 0) {
      console.log(`[TestPlanner] ${this.blockingIds.size} blocking component(s) excluded (see needs-testid.md)`);
    }
    const grounded = [...this.derivedEdges.values()].reduce((n, e) => n + e.length, 0);
    console.log(`[TestPlanner] ${grounded} grounded edge case(s) derived from DOM/network`);

    const sessionDirs = sessionId
      ? [join(sessionsDir, sessionId)]
      : await this._listSessions(sessionsDir);

    if (sessionDirs.length === 0) {
      throw new Error('No sessions found in ' + sessionsDir);
    }

    const recentDirs = sessionDirs.slice(-limit);
    if (sessionDirs.length > limit) {
      console.log(`[TestPlanner] ${sessionDirs.length} sessions total — using ${limit} most recent`);
    }

    const allSessionData: SessionData[] = [];
    for (const dir of recentDirs) {
      const data = await this._loadSession(dir);
      if (data) allSessionData.push(data);
    }

    if (allSessionData.length === 0) {
      throw new Error('No valid sessions with steps found');
    }

    let filtered = allSessionData;
    let filteredRegistry = registry;
    if (goal) {
      const { sessions: goalSessions, registry: goalRegistry } = this._filterByGoal(allSessionData, registry, goal);
      filtered = goalSessions;
      filteredRegistry = goalRegistry;
      if (filtered.length === 0) {
        console.warn(`[TestPlanner] Goal filter matched nothing — falling back to all sessions`);
        filtered = allSessionData;
        filteredRegistry = registry;
      } else {
        console.log(`[TestPlanner] Goal filter: ${allSessionData.length} → ${filtered.length} sessions`);
      }
    }

    const deduped = this._deduplicateSessions(filtered);
    if (deduped.length < filtered.length) {
      console.log(`[TestPlanner] Deduplicated: ${filtered.length} → ${deduped.length} sessions`);
    }

    console.log(`[TestPlanner] ${deduped.length} session(s), ${Object.keys(filteredRegistry.components).length} components`);

    const plan = await this._buildPlanBatched(filteredRegistry, deduped, goal);

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(plan, null, 2), 'utf-8');
    console.log(`[TestPlanner] Plan written: ${outputPath}`);
    console.log(`[TestPlanner] ${plan.scenarios.length} scenario(s) planned`);

    return plan;
  }

  private _filterByGoal(
    sessions: SessionData[],
    registry: ComponentRegistry,
    goal: string,
  ): { sessions: SessionData[]; registry: ComponentRegistry } {
    const keywords = this._extractKeywords(goal);

    const relevantSessions = sessions
      .map((s) => ({ session: s, score: this._scoreSession(s, keywords) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.session);

    const relevantComponents: ComponentRegistry['components'] = {};
    for (const [id, comp] of Object.entries(registry.components)) {
      if (this._scoreComponent(comp, keywords) > 0) {
        relevantComponents[id] = comp;
      }
    }

    return {
      sessions: relevantSessions,
      registry: {
        ...registry,
        components: Object.keys(relevantComponents).length > 0 ? relevantComponents : registry.components,
      },
    };
  }

  private _extractKeywords(goal: string): string[] {
    const stopwords = new Set([
      'the', 'a', 'an', 'and', 'or', 'with', 'for', 'to', 'of', 'in', 'on',
      'at', 'by', 'is', 'are', 'was', 'be', 'it', 'that', 'this', 'i', 'we',
      'need', 'want', 'should', 'must', 'all', 'any', 'when', 'if',
    ]);
    return [...new Set(
      goal.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stopwords.has(w)),
    )];
  }

  private _scoreSession(session: SessionData, keywords: string[]): number {
    const text = [
      session.task,
      ...session.steps.map((s) => s.action.description),
      ...session.steps.map((s) => {
        try { return new URL(s.url.startsWith('http') ? s.url : `http://x${s.url}`).pathname; }
        catch { return s.url; }
      }),
      ...session.steps.map((s) => s.action.element?.ariaName ?? ''),
      ...session.steps.map((s) => s.action.element?.testid ?? ''),
    ].join(' ').toLowerCase();
    return keywords.filter((kw) => text.includes(kw)).length;
  }

  private _scoreComponent(comp: ComponentRecord, keywords: string[]): number {
    const text = [
      comp.label, comp.id, comp.componentType, comp.notes,
      ...comp.pages,
      ...comp.actions.map((a) => a.network?.urlPattern ?? ''),
      comp.states.disabled_when ?? '',
      comp.states.hidden_when ?? '',
    ].join(' ').toLowerCase();
    return keywords.filter((kw) => text.includes(kw)).length;
  }

  private _deduplicateSessions(sessions: SessionData[]): SessionData[] {
    const seen = new Map<string, SessionData>();
    for (const session of [...sessions].reverse()) {
      const fp = this._sessionFingerprint(session);
      if (!seen.has(fp)) seen.set(fp, session);
    }
    const keptIds = new Set(Array.from(seen.values()).map((s) => s.sessionId));
    return sessions.filter((s) => keptIds.has(s.sessionId));
  }

  private _sessionFingerprint(session: SessionData): string {
    const pages = [...new Set(session.steps.map((s) => {
      try { return new URL(s.url.startsWith('http') ? s.url : `http://x${s.url}`).pathname; }
      catch { return s.url; }
    }))].sort();

    const actionTypes = [...new Set(
      session.steps
        .filter((s) => ['click', 'fill', 'select'].includes(s.action.type))
        .map((s) => `${s.action.type}:${s.action.element?.testid ?? s.action.element?.ariaName ?? ''}`),
    )].sort();

    return `${pages.join('|')}::${actionTypes.join('|')}`;
  }

  private async _buildPlanBatched(registry: ComponentRegistry, sessions: SessionData[], goal?: string): Promise<TestPlan> {
    const BATCH_SIZE = 5;
    if (sessions.length <= BATCH_SIZE) return this._buildPlan(registry, sessions, goal);

    console.log(`[TestPlanner] ${sessions.length} sessions → batching in groups of ${BATCH_SIZE}`);
    const batches: SessionData[][] = [];
    for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
      batches.push(sessions.slice(i, i + BATCH_SIZE));
    }

    const batchPlans: TestPlan[] = [];
    for (let i = 0; i < batches.length; i++) {
      console.log(`[TestPlanner] Batch ${i + 1}/${batches.length}…`);
      batchPlans.push(await this._buildPlan(registry, batches[i], goal));
    }

    return this._mergePlans(batchPlans);
  }

  private _mergePlans(plans: TestPlan[]): TestPlan {
    const allScenarios: TestScenario[] = [];
    const seen = new Set<string>();
    for (const plan of plans) {
      for (const scenario of plan.scenarios) {
        const key = `${scenario.page}::${scenario.name.toLowerCase()}`;
        if (!seen.has(key)) { seen.add(key); allScenarios.push(scenario); }
      }
    }
    return {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      sessions: [...new Set(plans.flatMap((p) => p.sessions))],
      scenarios: allScenarios,
      summary: this._computeSummary(allScenarios),
    };
  }

  private async _buildPlan(registry: ComponentRegistry, sessions: SessionData[], goal?: string): Promise<TestPlan> {
    const registrySummary = this._summarizeRegistry(registry);
    const sessionsSummary = sessions.map(this._summarizeSession.bind(this));

    const goalSection = goal
      ? `\nCOVERAGE GOAL (focus only on this):\n"${goal}"\n\nOnly generate scenarios directly relevant to this goal.\n`
      : '';

    // Grounded edge cases for components used in these sessions.
    const usedComponentIds = new Set(
      sessions.flatMap((s) => s.steps).map((st) => st.action.element?.testid).filter(Boolean) as string[],
    );
    const groundedEdges = [...this.derivedEdges.entries()]
      .filter(([id]) => !this.blockingIds.has(id))
      .flatMap(([, edges]) => edges);
    const groundedSection = groundedEdges.length > 0
      ? `\nGROUNDED EDGE CASES (derived from real DOM constraints + observed network — USE THESE, do NOT invent your own; copy them verbatim into the relevant scenario's edgeCases):\n${JSON.stringify(groundedEdges, null, 2)}\n`
      : '';
    void usedComponentIds;

    const prompt = `You are a QA architect planning Cypress e2e tests based on recorded browser sessions and a component registry.
${goalSection}
COMPONENT REGISTRY SUMMARY:
${JSON.stringify(registrySummary, null, 2)}

RECORDED SESSIONS:
${JSON.stringify(sessionsSummary, null, 2)}
${groundedSection}

Your task: produce a${goal ? ' focused' : ' comprehensive'} test plan.

For each distinct user flow (page + scenario), create a TestScenario entry:
1. Group steps from the same page into one scenario
2. If a page has multiple distinct flows, create separate scenarios
3. Determine priority:
   - high: flows with network effects (POST/PUT/DELETE), auth, form submission
   - medium: navigation, search, filtering
   - low: read-only flows, static pages
4. For each scenario, populate edgeCases:
   - PREFER the GROUNDED EDGE CASES block above — copy the entries that belong to
     this scenario's components verbatim (keep their type/input/expected/source).
   - Do NOT invent edge cases that contradict the component's real constraints.
   - Only add your own if a clearly-relevant case is missing from the grounded list.
5. List required fixture files: <component-id>--success.json and --error.json
6. File path: cypress/e2e/<page-slug>/<scenario-slug>.cy.js

Return ONLY a valid JSON object matching this structure:
{
  "version": "1.0",
  "generatedAt": "${new Date().toISOString()}",
  "sessions": ["session-id-1"],
  "scenarios": [
    {
      "id": "cart-checkout-flow",
      "page": "/cart",
      "name": "Checkout Flow",
      "file": "cypress/e2e/cart/checkout-flow.cy.js",
      "priority": "high",
      "sessionId": "session-id-1",
      "stepIds": ["step-001"],
      "componentIds": ["cart__checkout-btn"],
      "edgeCases": [{ "type": "network-error", "component": "cart__checkout-btn", "action": "click", "description": "API returns 500" }],
      "fixtureFiles": ["cart__checkout-btn--success.json"],
      "description": "User proceeds to checkout",
      "notes": ""
    }
  ],
  "summary": { "total": 1, "byPriority": { "high": 1, "medium": 0, "low": 0 }, "byPage": { "/cart": 1 } }
}

No explanation, no markdown fences. Return only the JSON.`;

    try {
      const text = await runLlm(prompt);
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON found in response');

      const plan = JSON.parse(match[0]) as TestPlan;
      plan.generatedAt = new Date().toISOString();
      if (goal) plan.goal = goal;
      plan.summary = this._computeSummary(plan.scenarios);
      return plan;
    } catch (err) {
      console.warn('[TestPlanner] Claude failed, using deterministic fallback:', (err as Error).message);
      return this._buildDeterministicPlan(registry, sessions, goal);
    }
  }

  private _buildDeterministicPlan(registry: ComponentRegistry, sessions: SessionData[], goal?: string): TestPlan {
    const scenarios: TestScenario[] = [];

    for (const session of sessions) {
      const byPage = this._groupStepsByPage(session.steps);
      for (const [pagePath, steps] of Object.entries(byPage)) {
        const pageSlug = this._toKebab(pagePath.replace(/^\//, '') || 'home');
        const relevantComponents = Object.values(registry.components).filter(
          (c) => (c.pages.includes(pagePath) || c.pages.length > 2) && !this.blockingIds.has(c.id),
        );
        const networkComponents = relevantComponents.filter((c) => c.actions.some((a) => a.network));
        const fixtureFiles: string[] = [];

        // Grounded edge cases (DOM constraints + real network) for this page's components.
        const edgeCases: TestEdgeCase[] = this._groundedEdgesFor(relevantComponents.map((c) => c.id));

        for (const comp of networkComponents) {
          fixtureFiles.push(`${comp.id}--success.json`, `${comp.id}--error.json`);
        }

        const scenarioName = this._inferScenarioName(steps);
        const scenarioSlug = this._toKebab(scenarioName);

        scenarios.push({
          id: `${pageSlug}-${scenarioSlug}`,
          page: pagePath,
          name: scenarioName,
          file: `cypress/e2e/${pageSlug}/${scenarioSlug}.cy.js`,
          priority: networkComponents.length > 0 ? 'high' : 'medium',
          sessionId: session.sessionId,
          stepIds: steps.map((s) => s.stepId),
          componentIds: relevantComponents.map((c) => c.id),
          edgeCases,
          fixtureFiles: [...new Set(fixtureFiles)],
          description: `Recorded flow on ${pagePath}`,
          notes: '',
        });
      }
    }

    return {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      ...(goal ? { goal } : {}),
      sessions: sessions.map((s) => s.sessionId),
      scenarios,
      summary: this._computeSummary(scenarios),
    };
  }

  private _summarizeRegistry(registry: ComponentRegistry) {
    return {
      totalComponents: Object.keys(registry.components).length,
      pages: [...new Set(Object.values(registry.components).flatMap((c) => c.pages))],
      components: Object.values(registry.components).map((c) => ({
        id: c.id,
        label: c.label,
        pages: c.pages,
        confidence: c.confidence,
        hasNetwork: c.actions.some((a) => !!a.network),
        networkActions: c.actions.filter((a) => a.network).map((a) => ({ method: a.network!.method, url: a.network!.urlPattern })),
        states: Object.keys(c.states).filter((k) => c.states[k as keyof typeof c.states]),
      })),
    };
  }

  private _summarizeSession(session: SessionData) {
    const pages = [...new Set(session.steps.map((s) => {
      try { return new URL(s.url.startsWith('http') ? s.url : `http://x${s.url}`).pathname; }
      catch { return s.url; }
    }))];

    const interactions = session.steps
      .filter((s) => ['click', 'fill', 'select', 'hover'].includes(s.action.type))
      .map((s) => {
        const el = s.action.element;
        const selector = el?.testid
          ? `[data-testid="${el.testid}"]`
          : el?.ariaRole && el?.ariaName ? `${el.ariaRole}["${el.ariaName}"]` : el?.text ?? '?';
        return {
          step: s.stepId,
          type: s.action.type,
          selector,
          value: s.action.value ?? undefined,
          hasNetworkEffect: !!(s.after?.networkFile),
          hasStorageChange: !!(s.after?.storageDiff && Object.keys(s.after.storageDiff.added ?? {}).length > 0),
        };
      });

    return { sessionId: session.sessionId, task: session.task, pages, interactions };
  }

  private _groupStepsByPage(steps: StepRecord[]): Record<string, StepRecord[]> {
    const result: Record<string, StepRecord[]> = {};
    for (const step of steps) {
      let pagePath: string;
      try { pagePath = new URL(step.url.startsWith('http') ? step.url : `http://x${step.url}`).pathname; }
      catch { pagePath = step.url; }
      (result[pagePath] ??= []).push(step);
    }
    return result;
  }

  private _computeSummary(scenarios: TestScenario[]): TestPlan['summary'] {
    const byPage: Record<string, number> = {};
    let high = 0, medium = 0, low = 0;
    for (const s of scenarios) {
      byPage[s.page] = (byPage[s.page] ?? 0) + 1;
      if (s.priority === 'high') high++;
      else if (s.priority === 'medium') medium++;
      else low++;
    }
    return { total: scenarios.length, byPriority: { high, medium, low }, byPage };
  }

  private _inferScenarioName(steps: StepRecord[]): string {
    const actionSteps = steps.filter((s) => s.action.type !== 'navigate');
    if (actionSteps.length === 0) return 'Main Flow';
    const first = actionSteps[0].action.description ?? 'Main Flow';
    return first.length > 40 ? first.slice(0, 40) : first;
  }

  private _toKebab(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'flow';
  }

  private async _loadObservations(
    sessionsDir: string,
    sessionId?: string,
  ): Promise<AdversarialObservation[]> {
    const dirs = sessionId
      ? [join(sessionsDir, sessionId)]
      : await this._listSessions(sessionsDir);
    const all: AdversarialObservation[] = [];
    for (const dir of dirs) {
      const p = join(dir, 'analyzed', 'adversarial-observations.json');
      if (!existsSync(p)) continue;
      try {
        const obs = JSON.parse(await readFile(p, 'utf-8')) as AdversarialObservation[];
        all.push(...obs);
      } catch { /* skip */ }
    }
    if (all.length > 0) console.log(`[TestPlanner] ${all.length} adversarial observation(s) loaded`);
    return all;
  }

  private async _loadBlockingIds(registryPath: string): Promise<Set<string>> {
    // registryPath = <dataDir>/registry/components.json → reports = <dataDir>/reports
    const dataDir = dirname(dirname(registryPath));
    const classPath = join(dataDir, 'reports', 'classification.json');
    if (!existsSync(classPath)) return new Set();
    try {
      const list = JSON.parse(await readFile(classPath, 'utf-8')) as ClassifiedComponent[];
      return new Set(list.filter((c) => c.blocking).map((c) => c.componentId));
    } catch {
      return new Set();
    }
  }

  /** Grounded edge cases for the given components, excluding blocking ones. */
  private _groundedEdgesFor(componentIds: string[]): TestEdgeCase[] {
    const out: TestEdgeCase[] = [];
    for (const id of componentIds) {
      if (this.blockingIds.has(id)) continue;
      const edges = this.derivedEdges.get(id);
      if (edges) out.push(...edges);
    }
    return out;
  }

  private async _listSessions(sessionsDir: string): Promise<string[]> {
    if (!existsSync(sessionsDir)) return [];
    try {
      const entries = await readdir(sessionsDir);
      return entries.sort().map((e) => join(sessionsDir, e));
    } catch { return []; }
  }

  private async _loadSession(sessionDir: string): Promise<SessionData | null> {
    const stepsDir = join(sessionDir, 'steps');
    if (!existsSync(stepsDir)) return null;

    const metaPath = join(sessionDir, 'session-meta.json');
    let sessionId = sessionDir.split(/[\\/]/).pop() ?? 'unknown';
    let task = '';

    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as SessionMeta;
        sessionId = meta.sessionId;
        task = meta.task;
      } catch { /* keep defaults */ }
    }

    const files = (await readdir(stepsDir)).filter((f) => f.endsWith('.json')).sort();
    const steps: StepRecord[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(stepsDir, file), 'utf-8');
        const step = JSON.parse(raw) as StepRecord;
        if (step.status === 'complete') steps.push(step);
      } catch { /* skip corrupt */ }
    }

    if (steps.length === 0) return null;
    return { sessionId, task, steps };
  }
}

interface SessionData {
  sessionId: string;
  task: string;
  steps: StepRecord[];
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.replace(/\\/g, '/') === __filename.replace(/\\/g, '/');
if (isMain) {
  config({ path: resolve(__dirname, '..', '..', '.env') });

  const dataDir = resolve(__dirname, '..', '..', 'data');
  const cypressDir = resolve(__dirname, '..', '..', 'cypress-tests');
  const sessionsDir = join(dataDir, 'sessions');
  const registryPath = join(dataDir, 'registry', 'components.json');
  const outputPath = join(cypressDir, 'test-plan.json');

  const args = process.argv.slice(2);
  const sessionArg = args.find((_, i) => args[i - 1] === '--session');
  const limitStr = args.find((_, i) => args[i - 1] === '--limit');
  const goalArg = args.find((_, i) => args[i - 1] === '--goal');
  const limit = limitStr ? parseInt(limitStr, 10) : 10;

  console.log('[TestPlanner] Registry:', registryPath);
  console.log('[TestPlanner] Sessions:', sessionArg ?? `all (limit: ${limit})`);
  if (goalArg) console.log('[TestPlanner] Goal:    ', goalArg);
  console.log('[TestPlanner] Output:  ', outputPath, '\n');

  await new TestPlanner().plan(sessionsDir, registryPath, outputPath, sessionArg, limit, goalArg);
}
