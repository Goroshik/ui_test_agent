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
  ClassifiedComponent,
} from '../pipeline/types.js';
import type { TestPlan, TestScenario } from './test-planner.js';
import { runLlm } from '../agents/test-gen/llm-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Static portion of the generation prompt — no per-call interpolation, so it's
// hoisted out of _buildPrompt to keep that method short.
const PROMPT_GENERATION_RULES_HEAD = `GENERATION RULES:
1. Import SELECTORS as a named export: import { SELECTORS } from '../../support/selectors'
   NEVER use default import.
2. Use ONLY the exact SELECTORS paths from SELECTOR ACCESS MAP above.
   NEVER use bracket notation with kebab-case IDs.
   SELECTORS values are plain CSS strings — use them DIRECTLY: cy.get(SELECTORS.NS.KEY)
3. Each cy.intercept() MUST go inside beforeEach(), BEFORE cy.visit()
4. After every click/fill that triggers a network call → cy.wait('@alias')
5. Verify state BEFORE interaction: .should('exist').and('be.visible')
6. Verify state AFTER interaction (post_interaction assertions from registry)
7. Storage changes (from step storageDiff) → verify via cy.window().its('localStorage')
8. Add // STEP N: comment before each logical step
9. describe title format: "PageName: Scenario Name"
10. it title format: "should <action> <expected result>"
11. File header must include session ID and step range
12. `;

const PROMPT_STATIC_TAIL = `

FORBIDDEN (these are AUTO-REJECTED by the validator):
- .fill('text')                       ← Playwright; use cy.get(...).clear().type('text')
- await page.…                        ← Playwright; this is Cypress, no page object
- page.locator(...) / page.getByXxx() ← Playwright; use cy.get(SELECTORS.X.Y)
- getByTestId / getByRole / getByText ← Playwright; use SELECTORS.X.Y
- expect(...)                         ← Jest/Playwright; use .should('...')
- async/await in it() or beforeEach() ← Cypress chains aren't promises
- cy.wait(1000) or any numeric wait   ← only cy.wait('@alias') or { timeout } option
- Hardcoded selector strings          ← only SELECTORS.NAMESPACE.KEY dot notation
- SELECTORS['kebab-case-id']          ← only dot notation
- Hardcoded credentials               ← use Cypress.env('email') / Cypress.env('password')
- Markdown code fences or any prose

CORRECT vs WRONG (memorize):
WRONG:  await page.getByTestId('email').fill('a@b');
RIGHT:  cy.get(SELECTORS.LOGIN.EMAIL).clear().type('a@b');

WRONG:  cy.wait(500);
RIGHT:  cy.wait('@login');

WRONG:  expect(value).toBe('x');
RIGHT:  cy.wrap(value).should('eq', 'x');

Generate it() blocks:
1. Happy path (the recorded flow succeeds)
2. For each edge case in TEST PLAN — generate a separate it() block.
   - Each edge case carries "input" (the exact value to type) and "expected"
     (what to assert). USE THEM. Type the given input, assert the expected outcome.
   - For input-validation cases (required-empty, invalid-email, maxlength-exceeded,
     pattern-mismatch, out-of-range, xss-injection, whitespace-only): type the
     input, attempt submit, then assert the form was NOT submitted / an error is
     shown (e.g. cy.url() unchanged, or an error/invalid state visible).
   - For network-error / network-status: cy.intercept the real method+url from the
     description with that statusCode, click, cy.wait('@alias'), assert graceful error.
   If no edge cases listed: add one network-error case if there are network actions.

CRITICAL: Your response must start directly with // and contain only valid JavaScript.`;

// Lazily-loaded Cypress cheatsheet. Injected into every prompt so the LLM
// has a precise reference for Cypress-only syntax (no Playwright, no Jest).
let CHEATSHEET_CACHE: string | null = null;
async function loadCheatsheet(): Promise<string> {
  if (CHEATSHEET_CACHE !== null) return CHEATSHEET_CACHE;
  const path = resolve(__dirname, '..', '..', 'docs', 'cypress-cheatsheet.md');
  try {
    CHEATSHEET_CACHE = await readFile(path, 'utf-8');
  } catch {
    CHEATSHEET_CACHE = '';
  }
  return CHEATSHEET_CACHE;
}

interface PageTestParams {
  sessionId: string;
  pagePath: string;
  steps: StepRecord[];
  components: ComponentRecord[];
  cypressDir: string;
  scenario?: TestScenario | undefined;
  blockers: ComponentRecord[];
}

interface SkippedSpecParams {
  sessionId: string;
  pagePath: string;
  scenarioName: string;
  blockers: ComponentRecord[];
  outPath: string;
  outDir: string;
}

interface PromptSections {
  cheatsheetSection: string;
  edgeCasesSection: string;
  fixturesSection: string;
  selectorMapSection: string;
  availableFixturesSection: string;
}

interface PromptContext {
  sessionId: string;
  pagePath: string;
  scenarioName: string;
  scenario?: TestScenario | undefined;
  isLoginPage: boolean;
  steps: StepRecord[];
  components: ComponentRecord[];
  sections: PromptSections;
}

interface FallbackParams {
  sessionId: string;
  pagePath: string;
  scenarioName: string;
  steps: StepRecord[];
  components: ComponentRecord[];
}

interface FileContentParams {
  prompt: string;
  pageSlug: string;
  sessionId: string;
  pagePath: string;
  scenarioName: string;
  steps: StepRecord[];
  components: ComponentRecord[];
}

export class TestGenerator {
  async generate(
    sessionDir: string,
    dataDir: string,
    cypressDir: string,
    plan?: TestPlan,
  ): Promise<void> {
    const steps = await this._loadSteps(sessionDir);
    if (steps.length === 0) {
      console.log('[TestGenerator] No steps found in', sessionDir);
      return;
    }

    const meta = await this._loadMeta(sessionDir);
    const sessionId = meta?.sessionId ?? sessionDir.split(/[\\/]/).pop() ?? 'unknown';

    const registry = await this._loadRegistryForSession(dataDir);
    if (!registry) return;

    const blockingIds = await this._loadBlockingIds(dataDir);
    const planScenarios = plan?.scenarios.filter((s) => s.sessionId === sessionId) ?? [];
    const byPage = this._groupByPage(steps);

    this._logGenerateSummary({
      sessionId,
      stepCount: steps.length,
      pageCount: Object.keys(byPage).length,
      blockingCount: blockingIds.size,
      planScenarioCount: planScenarios.length,
    });

    for (const [pagePath, pageSteps] of Object.entries(byPage)) {
      const relevantComponents = this._relevantComponents(registry, pagePath);
      const pageScenario = planScenarios.find((s) => s.page === pagePath);
      const pageBlockers = relevantComponents.filter((c) => blockingIds.has(c.id));
      await this._generatePageTest({
        sessionId,
        pagePath,
        steps: pageSteps,
        components: relevantComponents,
        cypressDir,
        scenario: pageScenario,
        blockers: pageBlockers,
      });
    }
  }

  private async _loadRegistryForSession(dataDir: string): Promise<ComponentRegistry | null> {
    const registryPath = join(dataDir, 'registry', 'components.json');
    if (!existsSync(registryPath)) {
      console.log('[TestGenerator] Registry not found:', registryPath);
      return null;
    }
    return JSON.parse(await readFile(registryPath, 'utf-8')) as ComponentRegistry;
  }

  private async _loadBlockingIds(dataDir: string): Promise<Set<string>> {
    // Load classification report (if pipeline produced one) — used to skip blocking specs.
    const classificationPath = join(dataDir, 'reports', 'classification.json');
    let classification: ClassifiedComponent[] = [];
    if (existsSync(classificationPath)) {
      try {
        classification = JSON.parse(await readFile(classificationPath, 'utf-8')) as ClassifiedComponent[];
      } catch {
        // ignore — proceed without
      }
    }
    return new Set(classification.filter((c) => c.blocking).map((c) => c.componentId));
  }

  private _logGenerateSummary(info: {
    sessionId: string;
    stepCount: number;
    pageCount: number;
    blockingCount: number;
    planScenarioCount: number;
  }): void {
    console.log(
      `[TestGenerator] Session ${info.sessionId}: ${info.stepCount} steps across ${info.pageCount} page(s)`,
    );
    if (info.blockingCount > 0) {
      console.log(
        `[TestGenerator] ${info.blockingCount} component(s) blocked by missing data-testid — see data/reports/needs-testid.md`,
      );
    }
    if (info.planScenarioCount > 0) {
      console.log(`[TestGenerator] Plan: ${info.planScenarioCount} scenario(s) for this session`);
    }
  }

  private async _generatePageTest(params: PageTestParams): Promise<void> {
    const { sessionId, pagePath, steps, components, cypressDir, scenario, blockers } = params;
    const scenarioName = scenario?.name ?? this._inferScenarioName(steps);
    const { relFile, outPath, outDir } = this._resolveOutputPath(cypressDir, pagePath, scenarioName, scenario);

    console.log(`[TestGenerator] Generating ${relFile}…`);

    // If any interacted component on this page has no stable selector,
    // emit a skipped test pointing at the report so devs see the gap.
    const skipped = await this._writeSkippedSpecIfBlocked({
      sessionId, pagePath, scenarioName, blockers, outPath, outDir,
    });
    if (skipped) return;

    const isLoginPage = pagePath.includes('login');
    const { fixturesSection, availableFixturesSection } = await this._buildFixturesSections(cypressDir, scenario);
    const sections: PromptSections = {
      cheatsheetSection: await this._buildCheatsheetSection(),
      edgeCasesSection: this._buildEdgeCasesSection(scenario),
      fixturesSection,
      selectorMapSection: this._buildSelectorMapSection(components),
      availableFixturesSection,
    };

    const prompt = this._buildPrompt({
      sessionId, pagePath, scenarioName, scenario, isLoginPage, steps, components, sections,
    });

    const pageSlug = this._toKebab(pagePath.replace(/^\//, '') || 'home');
    const fileContent = await this._resolveFileContent({
      prompt, pageSlug, sessionId, pagePath, scenarioName, steps, components,
    });

    await mkdir(outDir, { recursive: true });
    await writeFile(outPath, fileContent, 'utf-8');
    console.log(`[TestGenerator] Written: ${outPath}`);
  }

  private _resolveOutputPath(
    cypressDir: string,
    pagePath: string,
    scenarioName: string,
    scenario: TestScenario | undefined,
  ): { relFile: string; outPath: string; outDir: string } {
    const pageSlug = this._toKebab(pagePath.replace(/^\//, '') || 'home');
    const scenarioSlug = this._toKebab(scenarioName);
    const relFile = scenario?.file ?? `cypress/e2e/${pageSlug}/${scenarioSlug}.cy.js`;
    const outPath = join(cypressDir, relFile);
    const outDir = dirname(outPath);
    return { relFile, outPath, outDir };
  }

  private async _writeSkippedSpecIfBlocked(params: SkippedSpecParams): Promise<boolean> {
    const { sessionId, pagePath, scenarioName, blockers, outPath, outDir } = params;
    if (blockers.length === 0) return false;
    const skipped = this._renderSkippedSpec(sessionId, pagePath, scenarioName, blockers);
    await mkdir(outDir, { recursive: true });
    await writeFile(outPath, skipped, 'utf-8');
    console.log(`[TestGenerator] Skipped (blocked by ${blockers.length} missing testid): ${outPath}`);
    return true;
  }

  private _buildEdgeCasesSection(scenario: TestScenario | undefined): string {
    return scenario?.edgeCases.length
      ? `\nTEST PLAN — EDGE CASES TO COVER:\n${JSON.stringify(scenario.edgeCases, null, 2)}`
      : '';
  }

  private async _buildFixturesSections(
    cypressDir: string,
    scenario: TestScenario | undefined,
  ): Promise<{ fixturesSection: string; availableFixturesSection: string }> {
    const fixturesSection = scenario?.fixtureFiles.length
      ? `\nREQUIRED FIXTURES (from test plan):\n${scenario.fixtureFiles.join('\n')}`
      : '';

    // List fixtures that ACTUALLY EXIST on disk. The LLM must reference only these.
    const fixturesDir = join(cypressDir, 'cypress', 'fixtures');
    let availableFixtures: string[] = [];
    try {
      availableFixtures = (await readdir(fixturesDir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      // ignore — no fixtures dir
    }
    const availableFixturesSection = availableFixtures.length > 0
      ? `\nAVAILABLE FIXTURES (only reference these — never invent a fixture filename):\n${availableFixtures.map((f) => `  - ${f}`).join('\n')}\n\nIf the network call you need has NO matching fixture above, use inline mock body instead of { fixture: ... }, e.g.:\n  cy.intercept('POST', '**/api/x', { statusCode: 200, body: { ok: true } }).as('x');`
      : `\nNO FIXTURES AVAILABLE. Do NOT use { fixture: ... } in cy.intercept — only inline { statusCode, body }.`;

    return { fixturesSection, availableFixturesSection };
  }

  private _buildSelectorMapSection(components: ComponentRecord[]): string {
    const selectorMap = this._buildSelectorMap(components);
    return selectorMap.length > 0
      ? `\nSELECTOR ACCESS MAP (use these exact paths — do NOT guess or use bracket notation):\n${selectorMap.map(({ id, key, selector }) => `  component "${id}" → ${key}  (selector: "${selector}")`).join('\n')}`
      : '';
  }

  private async _buildCheatsheetSection(): Promise<string> {
    const cheatsheet = await loadCheatsheet();
    return cheatsheet
      ? `\nCYPRESS CHEATSHEET (binding — every rule below MUST hold in the output):\n${cheatsheet}\n`
      : '';
  }

  private _buildPrompt(ctx: PromptContext): string {
    const { sessionId, pagePath, scenarioName, scenario, isLoginPage, steps, components, sections } = ctx;
    return `You are generating a Cypress test based on a recorded browser session.
Output ONLY raw JavaScript — no markdown, no code fences, no backticks, no explanation.
The very first character of your output must be "/" (the start of a JS comment).

You are writing CYPRESS tests, NOT Playwright. Read the cheatsheet below in full.
${sections.cheatsheetSection}
SESSION ID: ${sessionId}
PAGE: ${pagePath}
SCENARIO: ${scenarioName}
PRIORITY: ${scenario?.priority ?? 'medium'}
${scenario?.description ? `DESCRIPTION: ${scenario.description}` : ''}
${sections.edgeCasesSection}
${sections.fixturesSection}

COMPONENT REGISTRY (relevant components for this page):
${JSON.stringify(components, null, 2)}
${sections.selectorMapSection}
${sections.availableFixturesSection}

SESSION STEPS (the recorded user interactions):
${JSON.stringify(steps, null, 2)}

GENERATION RULES:
1. Import SELECTORS as a named export: import { SELECTORS } from '../../support/selectors'
   NEVER use default import.
2. Use ONLY the exact SELECTORS paths from SELECTOR ACCESS MAP above.
   NEVER use bracket notation with kebab-case IDs.
   SELECTORS values are plain CSS strings — use them DIRECTLY: cy.get(SELECTORS.NS.KEY)
3. Each cy.intercept() MUST go inside beforeEach(), BEFORE cy.visit()
4. After every click/fill that triggers a network call → cy.wait('@alias')
5. Verify state BEFORE interaction: .should('exist').and('be.visible')
6. Verify state AFTER interaction (post_interaction assertions from registry)
7. Storage changes (from step storageDiff) → verify via cy.window().its('localStorage')
8. Add // STEP N: comment before each logical step
9. describe title format: "PageName: Scenario Name"
10. it title format: "should <action> <expected result>"
11. File header must include session ID and step range
12. ${isLoginPage
      ? 'This IS the login page — do NOT call cy.login() here'
      : 'Call cy.login() as the FIRST line inside beforeEach(), before any cy.intercept() or cy.visit(). cy.login() takes NO arguments.'}

FORBIDDEN (these are AUTO-REJECTED by the validator):
- .fill('text')                       ← Playwright; use cy.get(...).clear().type('text')
- await page.…                        ← Playwright; this is Cypress, no page object
- page.locator(...) / page.getByXxx() ← Playwright; use cy.get(SELECTORS.X.Y)
- getByTestId / getByRole / getByText ← Playwright; use SELECTORS.X.Y
- expect(...)                         ← Jest/Playwright; use .should('...')
- async/await in it() or beforeEach() ← Cypress chains aren't promises
- cy.wait(1000) or any numeric wait   ← only cy.wait('@alias') or { timeout } option
- Hardcoded selector strings          ← only SELECTORS.NAMESPACE.KEY dot notation
- SELECTORS['kebab-case-id']          ← only dot notation
- Hardcoded credentials               ← use Cypress.env('email') / Cypress.env('password')
- Markdown code fences or any prose

CORRECT vs WRONG (memorize):
WRONG:  await page.getByTestId('email').fill('a@b');
RIGHT:  cy.get(SELECTORS.LOGIN.EMAIL).clear().type('a@b');

WRONG:  cy.wait(500);
RIGHT:  cy.wait('@login');

WRONG:  expect(value).toBe('x');
RIGHT:  cy.wrap(value).should('eq', 'x');

Generate it() blocks:
1. Happy path (the recorded flow succeeds)
2. For each edge case in TEST PLAN — generate a separate it() block.
   - Each edge case carries "input" (the exact value to type) and "expected"
     (what to assert). USE THEM. Type the given input, assert the expected outcome.
   - For input-validation cases (required-empty, invalid-email, maxlength-exceeded,
     pattern-mismatch, out-of-range, xss-injection, whitespace-only): type the
     input, attempt submit, then assert the form was NOT submitted / an error is
     shown (e.g. cy.url() unchanged, or an error/invalid state visible).
   - For network-error / network-status: cy.intercept the real method+url from the
     description with that statusCode, click, cy.wait('@alias'), assert graceful error.
   If no edge cases listed: add one network-error case if there are network actions.

CRITICAL: Your response must start directly with // and contain only valid JavaScript.`;
  }

  private async _resolveFileContent(params: FileContentParams): Promise<string> {
    const { prompt, pageSlug, sessionId, pagePath, scenarioName, steps, components } = params;
    try {
      let fileContent = await runLlm(prompt);
      fileContent = fileContent
        .replace(/^```(?:javascript|js)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
      if (!fileContent.includes('describe(') || !fileContent.includes('cy.')) {
        throw new Error('Response does not look like a Cypress test');
      }
      return fileContent;
    } catch (err) {
      console.warn(`[TestGenerator] Claude failed for ${pageSlug}:`, (err as Error).message);
      return this._generateFallback({ sessionId, pagePath, scenarioName, steps, components });
    }
  }

  private _renderSkippedSpec(
    sessionId: string,
    pagePath: string,
    scenarioName: string,
    blockers: ComponentRecord[],
  ): string {
    const pageLabel = this._toPageLabel(pagePath);
    const items = blockers
      .map((b) => `//   - ${b.label} (${b.componentType})  id=${b.id}`)
      .join('\n');
    return [
      '// AUTOGENERATED — blocked by missing data-testid',
      `// Session: ${sessionId}`,
      `// Page:    ${pagePath}`,
      '//',
      '// The following interacted components have no stable selector.',
      '// See data/reports/needs-testid.md for suggested test-id names.',
      items,
      '',
      `describe.skip('${pageLabel}: ${scenarioName}', () => {`,
      `  it('is blocked until missing data-testid attributes are added', () => {`,
      `    // see data/reports/needs-testid.md`,
      `  });`,
      `});`,
      '',
    ].join('\n');
  }

  private _generateFallback(params: FallbackParams): string {
    const { sessionId, pagePath, scenarioName, steps, components } = params;
    const pageLabel = this._toPageLabel(pagePath);
    const stepLines = steps
      .filter((s) => s.action.type !== 'navigate')
      .map((s, i) => this._buildFallbackStepLine(s, i, components));

    return [
      '// AUTOGENERATED — do not edit manually',
      `// Session: ${sessionId}`,
      `// Steps: step-001 → step-${String(steps.length).padStart(3, '0')}`,
      '',
      "import { SELECTORS } from '../../support/selectors';",
      '',
      `describe('${pageLabel}: ${scenarioName}', () => {`,
      '  beforeEach(() => {',
      '    cy.clearLocalStorage();',
      '    cy.clearCookies();',
      '  });',
      '',
      `  it('should complete ${scenarioName.toLowerCase()} successfully', () => {`,
      `    cy.visit('${pagePath}');`,
      '',
      ...stepLines,
      '  });',
      '});',
    ].join('\n') + '\n';
  }

  private _toPageLabel(pagePath: string): string {
    return (pagePath.replace(/^\//, '') || 'home')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private _buildFallbackStepLine(s: StepRecord, i: number, components: ComponentRecord[]): string {
    const comp = components.find((c) =>
      c.selectors.testid && s.action.element?.testid &&
      c.selectors.testid.includes(s.action.element.testid),
    );
    const sel = comp
      ? `SELECTORS.${this._toUpperSnake(comp.pages[0]?.replace(/^\//, '') || 'home')}.${this._toUpperSnake(comp.label)}`
      : `/* TODO: selector for step ${i + 1} */`;
    if (s.action.type === 'click') {
      return `    // STEP ${i + 1}: ${s.action.description}\n    cy.get(${sel}).should('be.visible').click();`;
    }
    if (s.action.type === 'fill') {
      return `    // STEP ${i + 1}: ${s.action.description}\n    cy.get(${sel}).clear().type(${JSON.stringify(s.action.value ?? '')});`;
    }
    return `    // STEP ${i + 1}: ${s.action.description}`;
  }

  private _groupByPage(steps: StepRecord[]): Record<string, StepRecord[]> {
    const result: Record<string, StepRecord[]> = {};
    for (const step of steps) {
      let pagePath: string;
      try { pagePath = new URL(step.url.startsWith('http') ? step.url : `http://x${step.url}`).pathname; }
      catch { pagePath = step.url; }
      (result[pagePath] ??= []).push(step);
    }
    return result;
  }

  private _relevantComponents(registry: ComponentRegistry, pagePath: string): ComponentRecord[] {
    return Object.values(registry.components).filter(
      (c) => c.pages.includes(pagePath) || c.pages.length > 2,
    );
  }

  private _buildSelectorMap(components: ComponentRecord[]): Array<{ id: string; key: string; selector: string }> {
    return components.map((c) => {
      const page = c.pages[0] ?? '/';
      const pageSlug = page.replace(/^\//, '') || 'home';
      const namespace = this._toUpperSnake(pageSlug);
      const key = this._toUpperSnake(c.label);
      return { id: c.id, key: `SELECTORS.${namespace}.${key}`, selector: c.selectors.preferred ?? '' };
    });
  }

  private _inferScenarioName(steps: StepRecord[]): string {
    const descriptions = steps.filter((s) => s.action.type !== 'navigate').map((s) => s.action.description).slice(0, 3);
    if (descriptions.length === 0) return 'Main Flow';
    const first = descriptions[0] ?? 'Main Flow';
    return first.length > 40 ? first.slice(0, 40) : first;
  }

  private _toKebab(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'flow';
  }

  private _toUpperSnake(str: string): string {
    return str.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase() || 'UNKNOWN';
  }

  private async _loadSteps(sessionDir: string): Promise<StepRecord[]> {
    const stepsDir = join(sessionDir, 'steps');
    if (!existsSync(stepsDir)) return [];
    const files = (await readdir(stepsDir)).filter((f) => f.endsWith('.json')).sort();
    const steps: StepRecord[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(stepsDir, file), 'utf-8');
        const step = JSON.parse(raw) as StepRecord;
        if (step.status === 'complete') steps.push(step);
      } catch { /* skip corrupt */ }
    }
    return steps;
  }

  private async _loadMeta(sessionDir: string): Promise<SessionMeta | null> {
    const path = join(sessionDir, 'session-meta.json');
    if (!existsSync(path)) return null;
    try { return JSON.parse(await readFile(path, 'utf-8')) as SessionMeta; }
    catch { return null; }
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.replace(/\\/g, '/') === __filename.replace(/\\/g, '/');
if (isMain) {
  config({ path: resolve(__dirname, '..', '..', '.env') });

  const dataDir = resolve(__dirname, '..', '..', 'data');
  const sessionsDir = join(dataDir, 'sessions');
  const cypressDir = resolve(__dirname, '..', '..', 'cypress-tests');

  const args = process.argv.slice(2);
  const sessionArg = args.find((_, i) => args[i - 1] === '--session');

  let sessionDirs: string[];
  if (sessionArg) {
    const resolved = sessionArg.includes('/') || sessionArg.includes('\\')
      ? resolve(sessionArg)
      : join(sessionsDir, sessionArg);
    sessionDirs = [resolved];
  } else {
    sessionDirs = await _allSessions(sessionsDir);
  }

  if (sessionDirs.length === 0) {
    console.error('[TestGenerator] No sessions found in', sessionsDir);
    process.exit(1);
  }

  const planPath = join(cypressDir, 'test-plan.json');
  let plan: TestPlan | undefined;
  if (existsSync(planPath)) {
    try {
      plan = JSON.parse(await readFile(planPath, 'utf-8')) as TestPlan;
      console.log(`[TestGenerator] Plan loaded: ${plan.scenarios.length} scenario(s)`);
    } catch {
      console.warn('[TestGenerator] Failed to parse test-plan.json, proceeding without plan');
    }
  } else {
    console.log('[TestGenerator] No test-plan.json found — run generate:plan first for better results');
  }

  console.log(`[TestGenerator] Sessions: ${sessionDirs.length}`);
  console.log(`[TestGenerator] Cypress:  ${cypressDir}\n`);

  const generator = new TestGenerator();
  for (const sessionDir of sessionDirs) {
    console.log(`\n[TestGenerator] ── Session: ${sessionDir}`);
    await generator.generate(sessionDir, dataDir, cypressDir, plan);
  }
}

async function _allSessions(sessionsDir: string): Promise<string[]> {
  if (!existsSync(sessionsDir)) return [];
  try {
    const entries = await readdir(sessionsDir);
    return entries.sort().map((e) => join(sessionsDir, e));
  } catch { return []; }
}
