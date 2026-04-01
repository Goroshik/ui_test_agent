import OpenAI from 'openai';
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { savePage, getPages, type PageRecord } from '../../memory.js';
import { resizeForVision } from '../../utils.js';

interface ScreenshotMeta {
  url?: string | null;
  step?: number;
  tool?: string;
}

async function readSidecarMeta(imagePath: string): Promise<ScreenshotMeta | null> {
  const jsonPath = imagePath.replace(/\.[^.]+$/, '.json');
  try {
    const text = await readFile(jsonPath, 'utf-8');
    return JSON.parse(text) as ScreenshotMeta;
  } catch {
    return null;
  }
}

/** Detect real image MIME type from file magic bytes, ignoring the file extension. */
function detectMime(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/png';
}

const SCREENSHOTS_DIR = resolve(process.cwd(), 'screenshots');

const DESCRIBE_PROMPT = `You are analyzing a browser screenshot for a test automation agent.

Your tasks:
1. Identify the URL — either read it from the browser address bar, or use the URL provided in context
2. Describe the page content

Return ONLY this exact format (no markdown, no extra text):
URL: <full url including http/https>
Title: <page heading or browser tab title>
Purpose: <one sentence — what this page is for>
Navigation: <comma-separated nav links / menu items / tabs visible, or "none">
Forms: <list of forms with their fields, e.g. "Login form: email, password", or "none">
Key actions: <important buttons, CTAs, dropdowns — comma-separated, or "none">
Sections: <main content sections or panels — comma-separated>

If you cannot determine the URL, write: URL: unknown`;

function parseResponse(text: string): { url: string | null; record: Omit<PageRecord, 'analyzedAt'> } {
  const get = (key: string): string | undefined => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'));
    return match?.[1]?.trim();
  };

  const url = get('URL');
  return {
    url: !url || url === 'unknown' ? null : url,
    record: {
      title:      get('Title'),
      purpose:    get('Purpose'),
      navigation: get('Navigation'),
      forms:      get('Forms'),
      keyActions: get('Key actions'),
      sections:   get('Sections'),
    },
  };
}

async function collectImages(dirs: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = await readdir(dir);
    for (const f of files.filter((n) => /\.(png|jpg|jpeg)$/i.test(n))) {
      paths.push(resolve(dir, f));
    }
  }
  return paths;
}

export class PageMemoryAgent {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

  async process(force = false): Promise<void> {
    const dirs = [
      resolve(SCREENSHOTS_DIR, 'incoming'),
      resolve(SCREENSHOTS_DIR, 'baseline'),
    ];

    const allPngs = await collectImages(dirs);

    if (allPngs.length === 0) {
      console.log('\n[PageMemory] No screenshots found.');
      return;
    }

    const existingPages = await getPages();

    // Group PNGs by page URL prefix from filename heuristic so we don't
    // send 10 screenshots of the same page. We pick the most recent per group.
    // Key = first 60 chars of filename stem after the step number.
    const groups = new Map<string, string>(); // groupKey → newest filePath
    for (const p of allPngs.sort()) {        // sort = chronological (timestamp in name)
      const stem = p.replace(/\\/g, '/').split('/').at(-1) ?? '';
      const groupKey = stem.replace(/^\d+-/, '').replace(/_\d{8}-\d{6}\.png$/i, '');
      groups.set(groupKey, p);               // overwrite → keeps newest
    }

    const candidates = [...groups.values()];

    // If not forced, skip pages already analyzed
    const toAnalyze = force
      ? candidates
      : candidates.filter((filePath) => {
          // We don't know the URL yet, so we can't skip here.
          // We'll skip after the LLM tells us the URL.
          return true;
        });

    console.log(`\n[PageMemory] Analyzing ${toAnalyze.length} screenshot group(s)...`);
    let saved = 0;

    for (const filePath of toAnalyze) {
      const filename = filePath.replace(/\\/g, '/').split('/').at(-1) ?? filePath;

      let base64: string;
      let mime: string;
      let fileSizeKb: number;
      try {
        const raw = await readFile(filePath);
        const buf = await resizeForVision(raw);
        fileSizeKb = Math.round(buf.length / 1024);
        const detectedMime = detectMime(buf);
        mime = detectedMime ?? 'image/png';
        base64 = buf.toString('base64');

        console.log(`  File: ${filename}`);
        console.log(`    Size:      ${fileSizeKb} KB  (base64: ${Math.round(base64.length / 1024)} KB)`);
        console.log(`    Extension: .${filename.split('.').at(-1)}`);
        console.log(`    Magic:     ${buf.slice(0, 4).toString('hex')}  → detected mime: ${detectedMime ?? 'unknown (fallback: image/png)'}`);
      } catch {
        console.log(`  Skipping: cannot read ${filename}`);
        continue;
      }

      const meta = await readSidecarMeta(filePath);
      const metaUrl = meta?.url ?? null;
      if (metaUrl) {
        console.log(`    Meta URL:  ${metaUrl}`);
      }

      let raw: string;
      try {
        console.log(`    Sending to model: ${this.model} ...`);
        const dataUrl = `data:${mime};base64,${base64}`;
        console.log(`    data URL prefix: ${dataUrl.slice(0, 40)}`);

        const userText = metaUrl
          ? `Screenshot file: ${filename}\nPage URL (from automation context): ${metaUrl}`
          : `Screenshot file: ${filename}`;

        const response = await this.client.chat.completions.create({
          model: this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: DESCRIBE_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        });
        raw = response.choices[0]?.message?.content?.trim() ?? '';
        console.log(`    Response: ${raw.slice(0, 120)}`);
      } catch (err) {
        const e = err as { status?: number; message?: string; error?: unknown };
        console.warn(`  ✗ Failed: ${filename}`);
        console.warn(`    Status:  ${e.status ?? 'n/a'}`);
        console.warn(`    Message: ${e.message}`);
        console.warn(`    Body:    ${JSON.stringify(e.error ?? '').slice(0, 300)}`);
        continue;
      }

      const { url: parsedUrl, record } = parseResponse(raw);

      // Prefer URL from LLM response; fall back to sidecar metadata
      const url = parsedUrl ?? metaUrl;

      if (!url) {
        console.log(`  Skipping ${filename}: URL not detected in address bar or metadata`);
        continue;
      }

      // Skip if already analyzed and not forced
      if (!force && existingPages[url]) {
        console.log(`  Already known: ${url} — skipping (use --force to re-analyze)`);
        continue;
      }

      await savePage(url, record);
      console.log(`  ✓ ${url}`);
      if (record.title)   console.log(`      Title:    ${record.title}`);
      if (record.purpose) console.log(`      Purpose:  ${record.purpose}`);
      saved++;
    }

    console.log(`\n[PageMemory] Done. ${saved} page(s) updated.`);
  }
}
