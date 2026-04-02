import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import { readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import OpenAI from 'openai';
import { resolveModel } from './utils.js';
import { Agent } from './agents/main/agent.js';
import { PlannerAgent } from './agents/planner/planner-agent.js';
import { MemoryAnalysisAgent } from './agents/planner/memory-analysis-agent.js';
import { PageMemoryAgent } from './agents/post-run/page-memory-agent.js';
import { DomMemoryAgent } from './agents/post-run/dom-memory-agent.js';
import { PostRunCompareAgent } from './agents/post-run/post-run-snapshot-compare-agent.js';
import { RunLogger, attachLogger } from './run-logger.js';

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

const client = new OpenAI({
  baseURL: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1',
  apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
});

// Create a per-run log file in logs/ directory
const runId = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .replace('T', '_')
  .slice(0, 19);
const logger = new RunLogger(runId);
await logger.init(userTask);
attachLogger(client as Parameters<typeof attachLogger>[0], logger, 'LLM');

try {
  const model = await resolveModel(client);

  // 1. Analyze existing page memory → build navigation context for the planner
  const memoryAnalysis = await new MemoryAnalysisAgent(client).analyze(userTask);

  // 2. Planner builds step-by-step execution path using site knowledge
  const plan = await new PlannerAgent(client).plan(userTask, memoryAnalysis);

  // 3. Main agent executes the plan
  const agent = new Agent(client, logger);
  await agent.run(plan);

  // 4. Analyze screenshots taken this run → write page descriptions to memory
  //    Must run before PostRunCompareAgent moves files out of incoming/
  await new PageMemoryAgent(client, model).process();

  // 4b. Analyze accessibility snapshots → write DOM structure to dom-memory.json
  await new DomMemoryAgent(client, model).process();

  // 5. Visual + snapshot diff against baselines
  const visualDisabled = process.env.VISUAL_DISABLED === 'true';
  if (!visualDisabled) {
    await new PostRunCompareAgent(client, model).process();
  }

  // 6. Clean up incoming dirs — remove any leftover files (including .json sidecars
  //    that BaseCompareAgent skips, and all files when VISUAL_DISABLED=true)
  await cleanIncomingDirs();

  await logger.logEnd();
} catch (err) {
  await logger.logEnd();
  console.error('\nFatal error:', (err as Error).message);
  process.exit(1);
}
