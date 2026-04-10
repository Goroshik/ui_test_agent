import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import { readdirSync } from 'fs';
import OpenAI from 'openai';
import { PipelineRunner } from './agents/pipeline/pipeline-runner.js';

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
} else {
  // Pick the most recent session by folder name (they're ISO-like, so lexicographic sort works)
  const sessions = readdirSync(sessionsDir).sort();
  if (sessions.length === 0) {
    console.error('No sessions found in', sessionsDir);
    process.exit(1);
  }
  const latest = sessions[sessions.length - 1];
  sessionDir = resolve(sessionsDir, latest);
  console.log(`No session specified — using latest: ${latest}`);
}

console.log(`Session: ${sessionDir}`);
console.log(`Data:    ${dataDir}\n`);

const client = new OpenAI({
  baseURL: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1',
  apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
});

const model = process.env.LM_STUDIO_MAIN_MODEL || process.env.LM_STUDIO_MODEL || 'default';

try {
  await new PipelineRunner(client, model).run(sessionDir, dataDir);
} catch (err) {
  console.error('Pipeline error:', (err as Error).message);
  process.exitCode = 1;
}
