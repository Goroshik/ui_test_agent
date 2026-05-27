import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveModel } from './utils.js';
import { createProvider } from './llm-provider.js';
import { ScreenshotCompareAgent } from './agents/snapshot-compare/snapshot-compare-agent.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const { client, model: configuredModel, kind } = createProvider('analyzer');

try {
  const model = configuredModel || (kind === 'ollama' ? await resolveModel(client) : '');
  if (!model) throw new Error('No analyzer model configured');
  console.log(`[snapshot-compare] provider=${kind} model=${model}`);
  const agent = new ScreenshotCompareAgent(client, model);
  await agent.process();
} catch (err) {
  console.error('\nFatal error:', (err as Error).message);
  process.exit(1);
}
