import OpenAI from 'openai';
import { readFile, readdir, stat } from 'fs/promises';
import { resolve } from 'path';
import { existsSync } from 'fs';

export interface VerificationResult {
  success: boolean;
  reason: string;
}

const SCREENSHOTS_INCOMING = resolve(process.cwd(), 'screenshots', 'incoming');

const SYSTEM_PROMPT = `You are a task completion verifier. You will be shown a screenshot of a browser and a task/plan description.
Your job is to determine whether the task was successfully completed based on what you see in the screenshot.

IMPORTANT: Always respond in Russian.

Respond with a JSON object (no markdown fences) in exactly this format:
{
  "success": true or false,
  "reason": "brief explanation in Russian of why the task succeeded or failed"
}

Be strict: if there is any doubt that the task was not fully completed, return success: false.`;

export class TaskVerificationAgent {
  private client: OpenAI;
  private model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async verify(task: string, screenshotPath?: string | null): Promise<VerificationResult> {
    const imgPath = screenshotPath ?? (await this._findLastScreenshot());

    if (!imgPath || !existsSync(imgPath)) {
      return { success: false, reason: 'Скриншот не найден — невозможно проверить результат' };
    }

    let base64: string;
    try {
      const buf = await readFile(imgPath);
      base64 = buf.toString('base64');
    } catch {
      return { success: false, reason: 'Не удалось прочитать файл скриншота' };
    }

    const ext = imgPath.endsWith('.jpg') || imgPath.endsWith('.jpeg') ? 'jpeg' : 'png';
    const dataUrl = `data:image/${ext};base64,${base64}`;

    console.log(`\n[Verifier] Checking task completion using screenshot: ${imgPath}`);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Task/Plan:\n${task}\n\nLook at the screenshot and determine if the task was fully completed.`,
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      temperature: 0.1,
    });

    const raw = response.choices[0].message.content?.trim() ?? '';

    try {
      // Strip possible markdown fences
      const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      const parsed = JSON.parse(jsonStr) as { success: boolean; reason: string };
      console.log(`[Verifier] Result: ${parsed.success ? '✅ SUCCESS' : '❌ FAILED'} — ${parsed.reason}`);
      return { success: Boolean(parsed.success), reason: parsed.reason ?? '' };
    } catch {
      // If we can't parse JSON, treat as failure
      console.log(`[Verifier] Could not parse response: ${raw.slice(0, 200)}`);
      return { success: false, reason: `Не удалось разобрать ответ верификатора: ${raw.slice(0, 100)}` };
    }
  }

  /** Finds the most recently modified screenshot in the incoming directory. */
  private async _findLastScreenshot(): Promise<string | null> {
    if (!existsSync(SCREENSHOTS_INCOMING)) return null;

    const files = await readdir(SCREENSHOTS_INCOMING);
    const imageFiles = files.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
    if (imageFiles.length === 0) return null;

    // Sort by mtime descending, pick the newest
    const withStats = await Promise.all(
      imageFiles.map(async (f) => {
        const fullPath = resolve(SCREENSHOTS_INCOMING, f);
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtimeMs };
      }),
    );

    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats[0].path;
  }
}
