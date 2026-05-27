import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveModel } from './utils.js';
import { createProvider } from './llm-provider.js';
import { SnapshotTextCompareAgent } from './agents/snapshot-text-compare/snapshot-text-compare-agent.js';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const { client, model: configuredModel, kind } = createProvider('analyzer');

try {
  const model = configuredModel || (kind === 'ollama' ? await resolveModel(client) : '');
  if (!model) throw new Error('No analyzer model configured');
  console.log(`[snapshot-text-compare] provider=${kind} model=${model}`);
  const agent = new SnapshotTextCompareAgent(client, model);
  await agent.process();
} catch (err) {
  console.error('\nFatal error:', (err as Error).message);
  process.exit(1);
}
