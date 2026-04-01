import { config } from 'dotenv';
import OpenAI from 'openai';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveModel } from './utils.js';
import { ScreenshotCompareAgent } from './agents/snapshot-compare/snapshot-compare-agent.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const client = new OpenAI({
  baseURL: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1',
  apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
});

try {
  const model = await resolveModel(client);
  const agent = new ScreenshotCompareAgent(client, model);
  await agent.process();
} catch (err) {
  console.error('\nFatal error:', (err as Error).message);
  process.exit(1);
}
