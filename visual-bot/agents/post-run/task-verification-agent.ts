import OpenAI from 'openai';
import { readFile, readdir, stat } from 'fs/promises';
import { resolve } from 'path';
import { existsSync } from 'fs';

export interface VerificationResult {
  success: boolean;
  reason: string;
}

const SNAPSHOTS_INCOMING = resolve(process.cwd(), 'screenshots', 'snapshots-incoming');

/** ARIA snapshots of a busy page run long; trim before paying per token. */
const MAX_SNAPSHOT_CHARS = parseInt(process.env.VERIFICATION_SNAPSHOT_MAX_CHARS || '20000', 10);

const SYSTEM_PROMPT = `You are a task completion verifier. You will be given the accessibility (ARIA) snapshot of a browser page and a task/plan description.
Your job is to determine whether the task was successfully completed based on what the snapshot shows.

The snapshot is the page's accessibility tree: the page URL plus roles, labels, headings, form values, links and buttons. Judge by what it contains — the expected URL, a success banner, the expected row in a table — and by what it lacks: a validation error, a still-open dialog, a form that clearly never submitted.

IMPORTANT: Always respond in Russian.

Respond with a JSON object (no markdown fences) in exactly this format:
{
  "success": true or false,
  "reason": "brief explanation in Russian of why the task succeeded or failed"
}

Be strict: if there is any doubt that the task was not fully completed, return success: false.`;

/** Keeps the head and tail of an over-long snapshot — alerts and dialogs land at either end. */
export function truncateSnapshot(snapshot: string, maxChars = MAX_SNAPSHOT_CHARS): string {
  if (snapshot.length <= maxChars) return snapshot;
  const half = Math.floor(maxChars / 2);
  const omitted = snapshot.length - half * 2;
  return `${snapshot.slice(0, half)}\n\n…[${omitted} chars omitted]…\n\n${snapshot.slice(-half)}`;
}

export class TaskVerificationAgent {
  private client: OpenAI;
  private model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async verify(task: string, snapshot?: string | null): Promise<VerificationResult> {
    const text = snapshot?.trim() || (await this._readLastSnapshot());
    if (!text) {
      return { success: false, reason: 'ARIA snapshot not found — cannot verify the result' };
    }

    console.log(`\n[Verifier] Checking task completion using ARIA snapshot (${text.length} chars)`);
    const raw = await this._requestVerification(task, truncateSnapshot(text));
    return this._parseVerificationResponse(raw);
  }

  private async _requestVerification(task: string, snapshot: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Task/Plan:\n${task}\n\nPage accessibility snapshot:\n${snapshot}\n\nDetermine whether the task was fully completed.`,
        },
      ],
      temperature: 0.1,
    });

    const choice = response.choices[0];
    return choice?.message.content?.trim() ?? '';
  }

  private _parseVerificationResponse(raw: string): VerificationResult {
    try {
      // Strip possible markdown fences
      const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      const parsed = JSON.parse(jsonStr) as { success: boolean; reason: string };
      console.log(`[Verifier] Result: ${parsed.success ? '✅ SUCCESS' : '❌ FAILED'} — ${parsed.reason}`);
      return { success: Boolean(parsed.success), reason: parsed.reason ?? '' };
    } catch {
      // If we can't parse JSON, treat as failure
      console.log(`[Verifier] Could not parse response: ${raw.slice(0, 200)}`);
      return { success: false, reason: `Could not parse the verifier response: ${raw.slice(0, 100)}` };
    }
  }

  /** Fallback when the agent held no in-memory snapshot: newest saved snapshot on disk. */
  private async _readLastSnapshot(): Promise<string> {
    const path = await this._findLastSnapshotFile();
    if (!path) return '';
    try {
      return (await readFile(path, 'utf-8')).trim();
    } catch {
      return '';
    }
  }

  /** Finds the most recently modified snapshot in the incoming directory. */
  private async _findLastSnapshotFile(): Promise<string | null> {
    if (!existsSync(SNAPSHOTS_INCOMING)) return null;

    const files = await readdir(SNAPSHOTS_INCOMING);
    const textFiles = files.filter((f) => f.toLowerCase().endsWith('.txt'));
    if (textFiles.length === 0) return null;

    // Sort by mtime descending, pick the newest
    const withStats = await Promise.all(
      textFiles.map(async (f) => {
        const fullPath = resolve(SNAPSHOTS_INCOMING, f);
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtimeMs };
      }),
    );

    withStats.sort((a, b) => b.mtime - a.mtime);
    const newest = withStats[0];
    return newest ? newest.path : null;
  }
}
