/**
 * The pipeline as three steps, each runnable on its own or back to back.
 *
 *   crawl    — drive the browser from a task prompt, record the session
 *   analyze  — turn recorded sessions into the component registry
 *   generate — turn the registry into Cypress tests, then validate them
 *
 * Steps run as separate processes on purpose: they are independently useful
 * (re-analyze without re-crawling, regenerate without re-analyzing) and a
 * failure in a later step cannot lose the work of an earlier one.
 *
 * This module is pure — it decides *what* to run. `run.ts` does the spawning.
 */

export type StepName = 'crawl' | 'analyze' | 'generate';

export const STEP_NAMES: readonly StepName[] = ['crawl', 'analyze', 'generate'];

export interface StepCommand {
  /** Step this command belongs to — several commands may share one. */
  step: StepName;
  /** Human-readable label for progress output. */
  label: string;
  /** Script path, relative to the repo root. */
  script: string;
  args: string[];
  /** Extra environment for this command only. */
  env: Record<string, string>;
}

export interface Invocation {
  steps: StepName[];
  /** Task prompt for `crawl`; empty for the other steps. */
  task: string;
  /** Session id for `analyze`; empty means "the most recent one". */
  sessionId: string;
}

export interface ParseError {
  error: string;
}

export const USAGE = `Usage: npx tsx visual-bot/run.ts <step> [options]

Steps:
  crawl "<task>"        drive the browser from a task prompt, record the session
  analyze [sessionId]   build the component registry from recorded sessions
  generate              generate Cypress tests from the registry, then validate
  all "<task>"          crawl, then analyze, then generate

Options:
  --session <id>        session to analyze (default: the most recent one)

Examples:
  npx tsx visual-bot/run.ts crawl "log in and open the team page"
  npx tsx visual-bot/run.ts analyze
  npx tsx visual-bot/run.ts generate
  npx tsx visual-bot/run.ts all "log in and open the team page"`;

/**
 * `crawl` is index.ts with every analysis phase switched off — analysis is step
 * 2's job, and keeping it here is what made the old single command hard to
 * re-run. Set explicitly rather than relying on defaults so a stray .env cannot
 * silently pull analysis back into the crawl.
 */
const CRAWL_ENV: Record<string, string> = {
  PIPELINE_ENABLED: 'false',
  SCREENSHOT_ANALYSIS_ENABLED: 'false',
  SNAPSHOT_ANALYSIS_ENABLED: 'false',
};

function isStepName(value: string): value is StepName {
  return (STEP_NAMES as readonly string[]).includes(value);
}

function readSessionFlag(argv: readonly string[]): string {
  const index = argv.indexOf('--session');
  if (index === -1) return '';
  return argv[index + 1]?.trim() ?? '';
}

/** Positional arguments, with the `--session <id>` pair removed. */
function positionals(argv: readonly string[]): string[] {
  const index = argv.indexOf('--session');
  const rest = index === -1 ? [...argv] : [...argv.slice(0, index), ...argv.slice(index + 2)];
  return rest.filter((a) => a !== '');
}

/** Steps a command name expands to, or null when the name is not a command. */
function resolveSteps(command: string): StepName[] | null {
  if (command === 'all') return [...STEP_NAMES];
  return isStepName(command) ? [command] : null;
}

function resolveSessionId(command: string, sessionFlag: string, rest: readonly string[]): string {
  if (sessionFlag) return sessionFlag;
  return command === 'analyze' ? (rest[0] ?? '') : '';
}

export function parseArgs(argv: readonly string[]): Invocation | ParseError {
  const [command, ...rest] = positionals(argv);
  if (!command) return { error: 'No step given.' };

  const steps = resolveSteps(command);
  if (!steps) return { error: `Unknown step "${command}".` };

  const needsTask = steps.includes('crawl');
  const task = needsTask ? rest.join(' ').trim() : '';
  if (needsTask && !task) return { error: `Step "${command}" needs a task prompt.` };

  return { steps, task, sessionId: resolveSessionId(command, readSessionFlag(argv), rest) };
}

function crawlCommand(task: string): StepCommand {
  return {
    step: 'crawl',
    label: 'crawl — browse the app and record the session',
    script: 'visual-bot/index.ts',
    args: [task],
    env: CRAWL_ENV,
  };
}

function analyzeCommands(sessionId: string): StepCommand[] {
  const registry: StepCommand = {
    step: 'analyze',
    label: 'analyze — build the component registry',
    script: 'visual-bot/run-pipeline.ts',
    args: sessionId ? [sessionId] : [],
    env: {},
  };

  const compare: StepCommand[] = [];
  if (process.env.SNAPSHOT_ANALYSIS_ENABLED !== 'false') {
    compare.push({
      step: 'analyze',
      label: 'analyze — diff ARIA snapshots against baselines',
      script: 'visual-bot/snapshot-text-compare.ts',
      args: [],
      env: {},
    });
  }
  if (process.env.SCREENSHOT_ANALYSIS_ENABLED === 'true') {
    compare.push({
      step: 'analyze',
      label: 'analyze — diff screenshots against baselines (needs a vision model)',
      script: 'visual-bot/snapshot-compare.ts',
      args: [],
      env: {},
    });
  }

  return [registry, ...compare];
}

const GENERATE_SCRIPTS: ReadonlyArray<{ label: string; script: string }> = [
  { label: 'plan test scenarios', script: 'visual-bot/generators/test-planner.ts' },
  { label: 'generate selectors', script: 'visual-bot/generators/selectors-generator.ts' },
  { label: 'generate fixtures', script: 'visual-bot/generators/fixtures-generator.ts' },
  { label: 'generate Cypress specs', script: 'visual-bot/generators/test-generator.ts' },
  { label: 'validate generated specs', script: 'visual-bot/validators/test-validator.ts' },
];

function generateCommands(): StepCommand[] {
  return GENERATE_SCRIPTS.map(({ label, script }) => ({
    step: 'generate',
    label: `generate — ${label}`,
    script,
    args: [],
    env: {},
  }));
}

const BUILDERS: Record<StepName, (inv: Invocation) => StepCommand[]> = {
  crawl: (inv) => [crawlCommand(inv.task)],
  analyze: (inv) => analyzeCommands(inv.sessionId),
  generate: () => generateCommands(),
};

/** Expands an invocation into the ordered list of commands to run. */
export function buildCommands(invocation: Invocation): StepCommand[] {
  return invocation.steps.flatMap((step) => BUILDERS[step](invocation));
}
