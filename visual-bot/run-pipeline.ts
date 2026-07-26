import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import { readdirSync, existsSync } from 'fs';
import { PipelineRunner } from './agents/pipeline/pipeline-runner.js';
import { createProvider } from './llm-provider.js';
import { resolveModel } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'data');
const sessionsDir = resolve(dataDir, 'sessions');

// Accept a session ID/path as optional argument, otherwise use the latest session
const arg = process.argv[2]?.trim();

let sessionDir: string;
if (arg) {
  // Allow full path or just the session ID (folder name)
  sessionDir = arg.includes('/') || arg.includes('\\')
    ? resolve(arg)
    : resolve(sessionsDir, arg);
} else if (!existsSync(sessionsDir)) {
  console.error(`No sessions recorded yet (${sessionsDir} does not exist).`);
  console.error('Run the crawl step first: npx tsx visual-bot/run.ts crawl "<task>"');
  process.exit(1);
} else {
  // Pick the most recent session by folder name (they're ISO-like, so lexicographic sort works)
  const sessions = readdirSync(sessionsDir).sort();
  const latest = sessions[sessions.length - 1];
  if (sessions.length === 0 || !latest) {
    console.error('No sessions found in', sessionsDir);
    process.exit(1);
  }
  sessionDir = resolve(sessionsDir, latest);
  console.log(`No session specified — using latest: ${latest}`);
}

console.log(`Session: ${sessionDir}`);
console.log(`Data:    ${dataDir}\n`);

const { client, model: configuredModel, kind } = createProvider('analyzer');
const model = configuredModel || (kind === 'ollama' ? await resolveModel(client) : '');
if (!model) throw new Error('No analyzer model configured');
console.log(`[run-pipeline] provider=${kind} model=${model}\n`);

try {
  await new PipelineRunner(client, model).run(sessionDir, dataDir);
} catch (err) {
  console.error('Pipeline error:', (err as Error).message);
  process.exitCode = 1;
}
