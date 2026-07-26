import { config } from 'dotenv';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import { readdirSync, existsSync } from 'fs';
import { AdversarialAgent } from './agents/adversarial/adversarial-agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'data');
const sessionsDir = resolve(dataDir, 'sessions');

const arg = process.argv[2]?.trim();
let sessionDir: string;
if (arg) {
  sessionDir = arg.includes('/') || arg.includes('\\') ? resolve(arg) : join(sessionsDir, arg);
} else {
  if (!existsSync(sessionsDir)) {
    console.error('No sessions dir:', sessionsDir);
    process.exit(1);
  }
  const sessions = readdirSync(sessionsDir).sort();
  const latest = sessions[sessions.length - 1];
  if (sessions.length === 0 || !latest) {
    console.error('No sessions found in', sessionsDir);
    process.exit(1);
  }
  sessionDir = join(sessionsDir, latest);
  console.log(`No session specified — using latest: ${latest}`);
}

console.log(`[Adversarial] Session: ${sessionDir}\n`);

try {
  await new AdversarialAgent().run(sessionDir, dataDir);
} catch (err) {
  console.error('Adversarial error:', (err as Error).message);
  process.exitCode = 1;
}
