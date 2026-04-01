import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import OpenAI from 'openai';
import { resolveModel } from './utils.js';
import { PageMemoryAgent } from './agents/post-run/page-memory-agent.js';

const force = process.argv.includes('--force');

if (force) {
  console.log('[analyze-memory] Force mode: re-analyzing all screenshots');
}

const client = new OpenAI({
  baseURL: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1',
  apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
});

try {
  const model = await resolveModel(client);
  await new PageMemoryAgent(client, model).process(force);
} catch (err) {
  console.error('\nFatal error:', (err as Error).message);
  process.exit(1);
}
