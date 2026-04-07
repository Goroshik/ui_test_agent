import OpenAI from 'openai';
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { ComponentOrchestrator } from '../dom-components/orchestrator.js';
import { dbGetComponentsByUrl } from '../../db.js';

const SNAPSHOTS_DIR = resolve(process.cwd(), 'screenshots');

/** Extract URL from the first few lines of the snapshot (no LLM needed). */
function extractUrl(text: string): string | null {
  const match = text.match(/Page URL:\s*(https?:\/\/[^\s'"]+)/i);
  return match?.[1] ?? null;
}

async function collectSnapshots(dirs: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = await readdir(dir);
    for (const f of files.filter((n) => n.endsWith('.txt'))) {
      paths.push(resolve(dir, f));
    }
  }
  return paths;
}

export class DomMemoryAgent {
  private readonly orchestrator: ComponentOrchestrator;

  constructor(client: OpenAI, model: string) {
    this.orchestrator = new ComponentOrchestrator(client, model);
  }

  async process(force = false): Promise<void> {
    const dirs = [
      resolve(SNAPSHOTS_DIR, 'snapshots-incoming'),
      resolve(SNAPSHOTS_DIR, 'snapshots-baseline'),
    ];

    const allSnapshots = await collectSnapshots(dirs);

    if (allSnapshots.length === 0) {
      console.log('\n[DomMemory] No snapshots found.');
      return;
    }

    // Group by stable key — keep newest file per group
    const groups = new Map<string, string>();
    for (const p of allSnapshots.sort()) {
      const stem = p.replace(/\\/g, '/').split('/').at(-1) ?? '';
      const key = stem.replace(/^\d+-/, '').replace(/_\d{8}-\d{6}\.txt$/i, '');
      groups.set(key, p);
    }

    const candidates = [...groups.values()];
    console.log(`\n[DomMemory] Processing ${candidates.length} snapshot group(s)...`);
    let processed = 0;

    for (const filePath of candidates) {
      const filename = filePath.replace(/\\/g, '/').split('/').at(-1) ?? filePath;

      let snapshotText: string;
      try {
        snapshotText = await readFile(filePath, 'utf-8');
      } catch {
        console.log(`  Skipping: cannot read ${filename}`);
        continue;
      }

      const url = extractUrl(snapshotText);
      if (!url) {
        console.log(`  Skipping ${filename}: URL not found`);
        continue;
      }

      // Skip if already has components and not forced
      if (!force) {
        const existing = await dbGetComponentsByUrl(url);
        if (existing.length > 0) {
          console.log(`  Already analyzed: ${url} (${existing.length} component(s)) — skipping`);
          continue;
        }
      }

      const MAX_CHARS = 4000;
      const truncated = snapshotText.length > MAX_CHARS
        ? snapshotText.slice(0, MAX_CHARS) + '\n... (truncated)'
        : snapshotText;

      console.log(`  ${filename} → ${url}`);
      await this.orchestrator.process(url, truncated);
      processed++;
    }

    console.log(`\n[DomMemory] Done. ${processed} snapshot(s) processed.`);
  }
}
