import OpenAI from 'openai';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { VisualDiff } from './visual-diff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = resolve(__dirname, '..', 'screenshots');
const INCOMING_DIR = resolve(SCREENSHOTS_DIR, 'incoming');
const BASELINE_DIR = resolve(SCREENSHOTS_DIR, 'baseline');
const CHANGES_DIR = resolve(SCREENSHOTS_DIR, 'changes');

export class PostRunVisualAgent {
  private readonly diff: VisualDiff;

  constructor(client: OpenAI, model: string) {
    this.diff = new VisualDiff(client, model);
  }

  async process(): Promise<void> {
    await this.ensureDirs();
    const files = (await readdir(INCOMING_DIR))
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .sort();

    if (files.length === 0) {
      console.log('Post visual check: no new screenshots.');
      return;
    }

    console.log(`Post visual check: processing ${files.length} screenshot(s)...`);
    for (const file of files) {
      const incomingPath = resolve(INCOMING_DIR, file);
      const key = this.extractKey(file);
      const baselinePath = resolve(BASELINE_DIR, `${key}.png`);

      if (!existsSync(baselinePath)) {
        await rename(incomingPath, baselinePath);
        console.log(`  Baseline created: ${baselinePath}`);
        continue;
      }

      const oldBase64 = await readFile(baselinePath, 'base64');
      const newBase64 = await readFile(incomingPath, 'base64');
      const diff = await this.diff.compare(oldBase64, newBase64);

      if (!diff.changed) {
        await rm(incomingPath);
        console.log(`  Unchanged (${key}) -> removed new screenshot`);
        continue;
      }

      const stamp = this.timestamp();
      const diffDir = resolve(CHANGES_DIR, `${stamp}-${key}`);
      await mkdir(diffDir, { recursive: true });

      const oldPath = resolve(diffDir, 'old.png');
      const newPath = resolve(diffDir, 'new.png');
      const reportPath = resolve(diffDir, 'changes.txt');

      await copyFile(baselinePath, oldPath);
      await copyFile(incomingPath, newPath);
      await writeFile(reportPath, diff.summary || 'Visual change detected.', 'utf-8');

      await rename(incomingPath, baselinePath);
      console.log(`  Changed (${key}) -> saved diff: ${diffDir}`);
    }
  }

  private async ensureDirs(): Promise<void> {
    if (!existsSync(SCREENSHOTS_DIR)) await mkdir(SCREENSHOTS_DIR, { recursive: true });
    if (!existsSync(INCOMING_DIR)) await mkdir(INCOMING_DIR, { recursive: true });
    if (!existsSync(BASELINE_DIR)) await mkdir(BASELINE_DIR, { recursive: true });
    if (!existsSync(CHANGES_DIR)) await mkdir(CHANGES_DIR, { recursive: true });
  }

  private extractKey(filename: string): string {
    const m = filename.match(/^\d+-(.+)_\d{8}-\d{6}\.png$/i);
    return m?.[1] ?? filename.replace(/\.png$/i, '');
  }

  private timestamp(): string {
    const now = new Date();
    return (
      `${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}` +
      `-${String(now.getHours()).padStart(2, '0')}` +
      `${String(now.getMinutes()).padStart(2, '0')}` +
      `${String(now.getSeconds()).padStart(2, '0')}`
    );
  }
}
