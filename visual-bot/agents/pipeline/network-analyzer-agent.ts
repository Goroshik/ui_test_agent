import OpenAI from 'openai';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { NetworkStepMap } from '../../pipeline/types.js';

// Domains and path patterns that are never meaningful API calls
const NOISE_DOMAINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'google-analytics.com',
  'stats.g.doubleclick.net',
  'www.google.',
  'accounts.google.com/gsi',
  'ajax.googleapis.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
];

const NOISE_EXTENSIONS = /\.(js|css|woff2?|ttf|eot|png|jpg|jpeg|gif|svg|ico|webp|map|chunk\.js)(\?|$)/i;

const BATCH_SIZE = 10; // steps per LLM call

/**
 * Reads network log files for each step and builds a map of
 * UI interactions → API calls.
 * Output: analyzed/network-map.json.
 */
export class NetworkAnalyzerAgent {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  private async _listNetworkFiles(networkDir: string): Promise<string[] | null> {
    try {
      return (await readdir(networkDir))
        .filter((f) => f.endsWith('-network.json') && !f.includes('-after'))
        .sort();
    } catch {
      return null;
    }
  }

  private async _loadNetworkLog(
    networkDir: string,
    files: string[],
  ): Promise<Array<{ stepId: string; requests: string[] }>> {
    const networkLog: Array<{ stepId: string; requests: string[] }> = [];
    for (const file of files) {
      const stepId = file.replace('-network.json', '');
      try {
        const raw = JSON.parse(await readFile(join(networkDir, file), 'utf-8')) as { raw?: string };
        const filtered = this._filterRequests(raw.raw ?? '');
        if (filtered.length > 0) {
          networkLog.push({ stepId, requests: filtered });
        }
      } catch {
        // skip malformed files
      }
    }
    return networkLog;
  }

  private _logBatchRange(batch: Array<{ stepId: string; requests: string[] }>, batchNumber: number): void {
    const first = batch[0];
    const last = batch[batch.length - 1];
    const range = first && last ? `${first.stepId}…${last.stepId}` : '';
    console.log(`[NetworkAnalyzer] Batch ${batchNumber}: steps ${range}`);
  }

  private async _extractAllBatches(
    networkLog: Array<{ stepId: string; requests: string[] }>,
  ): Promise<NetworkStepMap[]> {
    const allMaps: NetworkStepMap[] = [];
    for (let i = 0; i < networkLog.length; i += BATCH_SIZE) {
      const batch = networkLog.slice(i, i + BATCH_SIZE);
      this._logBatchRange(batch, Math.floor(i / BATCH_SIZE) + 1);
      const maps = await this._extract(batch);
      allMaps.push(...maps);
    }
    return allMaps;
  }

  async analyze(sessionDir: string): Promise<void> {
    const networkDir = join(sessionDir, 'raw', 'network');
    const files = await this._listNetworkFiles(networkDir);

    if (files === null) {
      console.log('[NetworkAnalyzer] No network directory, skipping');
      return;
    }

    if (files.length === 0) {
      console.log('[NetworkAnalyzer] No network files found');
      return;
    }

    const networkLog = await this._loadNetworkLog(networkDir, files);

    if (networkLog.length === 0) {
      console.log('[NetworkAnalyzer] No meaningful API calls found after filtering');
      // Write empty result so downstream agents don't fail
      await writeFile(
        join(sessionDir, 'analyzed', 'network-map.json'),
        JSON.stringify([], null, 2),
        'utf-8',
      );
      return;
    }

    console.log(`[NetworkAnalyzer] ${networkLog.length} step(s) with API calls (batches of ${BATCH_SIZE})…`);

    const allMaps = await this._extractAllBatches(networkLog);

    const outPath = join(sessionDir, 'analyzed', 'network-map.json');
    await writeFile(outPath, JSON.stringify(allMaps, null, 2), 'utf-8');
    console.log(`[NetworkAnalyzer] Saved ${allMaps.length} step map(s) → ${outPath}`);
  }

  /**
   * Filters raw network log text: keeps only app API calls, drops analytics/fonts/static assets.
   * Returns array of clean "[METHOD] /path/... => [STATUS]" lines.
   */
  private _filterRequests(raw: string): string[] {
    const lines = raw.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Only lines that look like request entries
      if (!/^\[(GET|POST|PUT|PATCH|DELETE|HEAD)\]/.test(trimmed)) continue;

      // Extract URL
      const urlMatch = trimmed.match(/\]\s+(https?:\/\/[^\s=>]+)/);
      const url = urlMatch?.[1];
      if (!url) continue;

      // Skip noise domains
      if (NOISE_DOMAINS.some((d) => url.includes(d))) continue;

      // Skip static asset extensions
      try {
        const pathname = new URL(url).pathname;
        if (NOISE_EXTENSIONS.test(pathname)) continue;
      } catch {
        continue;
      }

      // Keep — strip long query strings to reduce token count
      const cleanLine = trimmed.replace(/\?[^\s=>]{80,}/, '?...');
      result.push(cleanLine);
    }

    return result;
  }

  private async _extract(
    batch: Array<{ stepId: string; requests: string[] }>,
  ): Promise<NetworkStepMap[]> {
    const prompt = `You are analyzing network request logs from a browser session.
Each entry has a stepId and the filtered API calls captured during that step.

For each step return:
{
  "stepId": "step-007",
  "triggers": [
    {
      "method": "POST",
      "urlPattern": "/api/checkout",
      "requestPayloadShape": { "cartId": "string", "items": "array" },
      "expectedStatus": 200,
      "responseShape": { "orderId": "string", "total": "number" }
    }
  ]
}

Steps with no relevant API calls should have "triggers": [].
Use path patterns without domain (e.g. "/api/users" not "https://example.com/api/users").

Network log:
\`\`\`
${batch.map((s) => `[${s.stepId}]\n${s.requests.join('\n')}`).join('\n\n')}
\`\`\`

Return ONLY a valid JSON array. No explanation.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });

      const text = response.choices[0]?.message?.content ?? '';
      return this._parseJsonArray<NetworkStepMap>(text);
    } catch (err) {
      console.warn('[NetworkAnalyzer] LLM call failed:', (err as Error).message);
      return [];
    }
  }

  private _parseJsonArray<T>(text: string): T[] {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      return JSON.parse(match[0]) as T[];
    } catch {
      return [];
    }
  }
}
