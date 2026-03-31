import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import { Agent } from './agent.js';

const prompt = process.argv.slice(2).join(' ').trim();

if (!prompt) {
  console.error('Usage: node index.js "<task description>"');
  console.error('Example: node index.js "go to github.com and explore the navigation"');
  process.exit(1);
}

const agent = new Agent();

try {
  await agent.run(prompt);
} catch (err) {
  console.error('\nFatal error:', err.message);
  process.exit(1);
}
