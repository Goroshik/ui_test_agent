import OpenAI from 'openai';
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { saveDomPage, getDomPages, type DomPageRecord } from '../../dom-memory.js';

const SNAPSHOTS_DIR = resolve(process.cwd(), 'screenshots');

const ANALYZE_PROMPT = `You are analyzing a Playwright accessibility tree snapshot for a test automation agent.

The snapshot is the raw output of browser_snapshot — it represents the DOM structure as an accessibility tree.

Your task:
1. Extract the URL from the "Page URL:" line at the top
2. Identify the structural elements of the page

Return ONLY this exact format (no markdown, no extra text):
URL: <full url including http/https>
Landmarks: <comma-separated landmark roles present: navigation, main, banner, contentinfo, complementary, form, search, region — or "none">
Headings: <heading hierarchy as text, e.g. "H1: Page Title > H2: Section A, Section B" — or "none">
Interactive: <comma-separated list of key buttons, links, and inputs — max 15 items — or "none">
Forms: <list of forms with their fields, e.g. "Login form: email, password, submit button" — or "none">
Structure: <1–2 sentences describing the overall DOM layout>

If you cannot determine the URL, write: URL: unknown`;

function parseResponse(text: string): { url: string | null; record: Omit<DomPageRecord, 'analyzedAt'> } {
  const get = (key: string): string | undefined => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'));
    return match?.[1]?.trim();
  };

  const url = get('URL');
  return {
    url: !url || url === 'unknown' ? null : url,
    record: {
      landmarks:   get('Landmarks'),
      headings:    get('Headings'),
      interactive: get('Interactive'),
      forms:       get('Forms'),
      structure:   get('Structure'),
    },
  };
}

/** Extract URL from the first few lines of the snapshot text itself (fast path, no LLM needed). */
function extractUrlFromSnapshot(text: string): string | null {
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
  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

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

    const existingPages = await getDomPages();

    // Group by stable key (strip step number and timestamp) — keep newest per group
    const groups = new Map<string, string>();
    for (const p of allSnapshots.sort()) {
      const stem = p.replace(/\\/g, '/').split('/').at(-1) ?? '';
      const groupKey = stem.replace(/^\d+-/, '').replace(/_\d{8}-\d{6}\.txt$/i, '');
      groups.set(groupKey, p);
    }

    const candidates = [...groups.values()];
    console.log(`\n[DomMemory] Analyzing ${candidates.length} snapshot group(s)...`);
    let saved = 0;

    for (const filePath of candidates) {
      const filename = filePath.replace(/\\/g, '/').split('/').at(-1) ?? filePath;

      let snapshotText: string;
      try {
        snapshotText = await readFile(filePath, 'utf-8');
      } catch {
        console.log(`  Skipping: cannot read ${filename}`);
        continue;
      }

      // Fast-path: extract URL without LLM
      const fastUrl = extractUrlFromSnapshot(snapshotText);

      // Skip if already analyzed and not forced
      if (!force && fastUrl && existingPages[fastUrl]) {
        console.log(`  Already known: ${fastUrl} — skipping (use --force to re-analyze)`);
        continue;
      }

      // Truncate large snapshots to avoid overwhelming the LLM context
      const MAX_CHARS = 6000;
      const truncated = snapshotText.length > MAX_CHARS
        ? snapshotText.slice(0, MAX_CHARS) + '\n... (truncated)'
        : snapshotText;

      console.log(`  File: ${filename} (${Math.round(snapshotText.length / 1024)} KB)`);

      let raw: string;
      try {
        console.log(`    Sending to model: ${this.model} ...`);
        const response = await this.client.chat.completions.create({
          model: this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: ANALYZE_PROMPT },
            { role: 'user', content: `Snapshot file: ${filename}\n\n${truncated}` },
          ],
        });
        raw = response.choices[0]?.message?.content?.trim() ?? '';
        console.log(`    Response: ${raw.slice(0, 120)}`);
      } catch (err) {
        const e = err as { message?: string };
        console.warn(`  ✗ Failed: ${filename} — ${e.message}`);
        continue;
      }

      const { url: parsedUrl, record } = parseResponse(raw);
      const url = parsedUrl ?? fastUrl;

      if (!url) {
        console.log(`  Skipping ${filename}: URL not detected`);
        continue;
      }

      if (!force && existingPages[url]) {
        console.log(`  Already known: ${url} — skipping`);
        continue;
      }

      await saveDomPage(url, record);
      console.log(`  ✓ ${url}`);
      if (record.structure) console.log(`      Structure: ${record.structure}`);
      saved++;
    }

    console.log(`\n[DomMemory] Done. ${saved} page(s) updated.`);
  }
}
