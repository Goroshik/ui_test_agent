import type OpenAI from 'openai';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import { readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { resolveModel } from './utils.js';
import { createProvider } from './llm-provider.js';
import { OllamaModelManager } from './ollama-model-manager.js';
import { Agent } from './agents/main/agent.js';
import { runAnalysisPipeline } from './run-analysis-pipeline.js';
import { PlannerAgent } from './agents/planner/planner-agent.js';
import { MemoryAnalysisAgent } from './agents/planner/memory-analysis-agent.js';
import { PostRunCompareAgent } from './agents/post-run/post-run-snapshot-compare-agent.js';
import { TaskVerificationAgent } from './agents/post-run/task-verification-agent.js';
import { RunLogger, attachLogger } from './run-logger.js';
import { connectDB, closeDB, saveRun, updateRun } from './db.js';

interface VerifyParams {
  verificationEnabled: boolean;
  validatorModel: string | undefined;
  client: OpenAI;
  mm: OllamaModelManager;
  plan: string;
  agent: Agent;
  attempt: number;
  maxRetries: number;
}

interface VerifyResult {
  taskSucceeded: boolean;
  lastFailReason: string;
  shouldRetry: boolean;
}

/** Runs task verification (if enabled) and decides whether the caller should retry. */
async function verifyAndDecideRetry(params: VerifyParams): Promise<VerifyResult> {
  const { verificationEnabled, validatorModel, client, mm, plan, agent, attempt, maxRetries } = params;
  if (!verificationEnabled) {
    return { taskSucceeded: true, lastFailReason: '', shouldRetry: false };
  }

  const effectiveValidatorModel = validatorModel ?? await resolveModel(client);
  const verification = await mm.withModel(validatorModel, () => {
    const verifier = new TaskVerificationAgent(client, effectiveValidatorModel);
    return verifier.verify(plan, agent.getLastScreenshotPath());
  });

  if (verification.success) {
    console.log('\n✅ Task verified as completed.');
    return { taskSucceeded: true, lastFailReason: '', shouldRetry: false };
  }

  console.log(`\n❌ Task not completed: ${verification.reason}`);
  return {
    taskSucceeded: false,
    lastFailReason: verification.reason,
    shouldRetry: attempt <= maxRetries,
  };
}

async function cleanIncomingDirs(): Promise<void> {
  const screenshotsDir = resolve(process.cwd(), 'screenshots');
  const dirs = [
    resolve(screenshotsDir, 'incoming'),
    resolve(screenshotsDir, 'snapshots-incoming'),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = await readdir(dir);
    if (files.length === 0) continue;
    for (const file of files) {
      await rm(resolve(dir, file), { force: true });
    }
    console.log(`[Cleanup] Removed ${files.length} file(s) from ${dir}`);
  }
}

const userTask = process.argv.slice(2).join(' ').trim();

if (!userTask) {
  console.error('Usage: npx tsx visual-bot/index.ts "<task description>"');
  console.error('Example: npx tsx visual-bot/index.ts "go to github.com and explore the navigation"');
  process.exit(1);
}

// ─── Terminal key listener ────────────────────────────────────────────────────
// Press 's' to gracefully stop the agent after its current step.
// Ctrl+C always exits immediately.
let currentAgent: import('./agents/main/agent.js').Agent | null = null;
let ttyListenerActive = false;

function onKeyPress(key: string): void {
  if (key === 's' || key === 'S') {
    currentAgent?.requestStop();
  } else if (key === '\u0003') { // Ctrl+C
    process.exit(1);
  }
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onKeyPress);
  ttyListenerActive = true;
  console.log('Tip: press "s" to stop the agent after the current step.\n');
}

// Main + planner stay on LM Studio (local browser execution).
const { client } = createProvider('main');
// Analyzer pipeline (snapshot compare, pipeline runner, post-run) can run on a cloud provider.
const analyzer = createProvider('analyzer');

await connectDB();
const mongoRunId = await saveRun({ task: userTask });

// Create a per-run log file in logs/ directory
const runId = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .replace('T', '_')
  .slice(0, 19);
const logger = new RunLogger(runId, mongoRunId ?? undefined);
await logger.init(userTask);
attachLogger(client as Parameters<typeof attachLogger>[0], logger, 'LLM');
if (analyzer.client !== client) {
  attachLogger(analyzer.client as Parameters<typeof attachLogger>[0], logger, 'LLM-analyzer');
}

try {
  const mm = new OllamaModelManager();

  // Model roles — each phase uses a dedicated model; if not configured, falls back to resolveModel
  const plannerModel = process.env.OLLAMA_PLANNER_MODEL;
  const mainModel = process.env.OLLAMA_MAIN_MODEL || process.env.OLLAMA_MODEL;
  const validatorModel = process.env.OLLAMA_VALIDATOR_MODEL;

  const plannerEnabled = process.env.PLANNER_ENABLED !== 'false';
  const maxRetries = parseInt(process.env.MAX_RETRIES || '2', 10);
  const verificationEnabled = process.env.VERIFICATION_ENABLED !== 'false';

  // 1. Analyze existing page memory → build navigation context for the planner
  // 2. Planner builds step-by-step execution path using site knowledge
  let plan: string;
  if (plannerEnabled) {
    plan = await mm.withModel(plannerModel, async () => {
      const memoryAnalysis = await new MemoryAnalysisAgent(client, plannerModel).analyze(userTask);
      return new PlannerAgent(client, plannerModel).plan(userTask, memoryAnalysis);
    });
  } else {
    plan = userTask;
  }

  let taskSucceeded = false;
  let lastFailReason = '';

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`[Retry ${attempt - 1}/${maxRetries}] Previous attempt failed: ${lastFailReason}`);
      console.log(`[Retry] Restarting agent...`);
      console.log('─'.repeat(50));
      await cleanIncomingDirs();
    }

    // 3. Main agent executes the plan
    const agent = new Agent(client, logger, mongoRunId ?? undefined, mainModel);
    currentAgent = agent;
    await mm.withModel(mainModel, () => agent.run(plan));
    currentAgent = null;

    // 4. Verify task completion BEFORE running heavy analysis pipeline
    const verifyResult = await verifyAndDecideRetry({
      verificationEnabled, validatorModel, client, mm, plan, agent, attempt, maxRetries,
    });
    taskSucceeded = verifyResult.taskSucceeded;
    lastFailReason = verifyResult.lastFailReason;
    if (verifyResult.shouldRetry) {
      continue; // skip pipeline, go straight to retry
    }

    // 4b. Run analysis pipeline on collected session data (only if task passed or verification disabled)
    await runAnalysisPipeline({ agent, analyzer, mm, mainModel });

    break; // exit retry loop — pipeline already ran
  }

  if (!taskSucceeded) {
    console.log(`\n⚠️  Task failed after ${maxRetries} retries. Last reason: ${lastFailReason}`);
  }

  const screenshotAnalysisEnabled = process.env.SCREENSHOT_ANALYSIS_ENABLED !== 'false';
  const snapshotAnalysisEnabled = process.env.SNAPSHOT_ANALYSIS_ENABLED !== 'false';

  // 5. Visual + snapshot diff against baselines
  const compareModel =
    analyzer.model || (analyzer.kind === 'ollama' ? await resolveModel(analyzer.client) : '');
  if (!compareModel) throw new Error('No analyzer model configured for post-run compare');
  const compareAgent = new PostRunCompareAgent(analyzer.client, compareModel);
  if (screenshotAnalysisEnabled) {
    await compareAgent.processScreenshots();
  }
  if (snapshotAnalysisEnabled) {
    await compareAgent.processSnapshots();
  }

  // 6. Clean up incoming dirs — remove any leftover files (including .json sidecars
  //    that BaseCompareAgent skips)
  await cleanIncomingDirs();

  await logger.logEnd();
  if (mongoRunId) await updateRun(mongoRunId, { status: 'completed' });
} catch (err) {
  await logger.logEnd();
  const errMsg = (err as Error).message;
  if (mongoRunId) await updateRun(mongoRunId, { status: 'failed', errorMessage: errMsg });
  console.error('\nFatal error:', errMsg);
  process.exitCode = 1;
} finally {
  if (ttyListenerActive) {
    process.stdin.removeListener('data', onKeyPress);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  await closeDB();
}
