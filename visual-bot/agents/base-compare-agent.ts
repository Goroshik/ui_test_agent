import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { DiffResult } from '../utils.js';

export abstract class BaseCompareAgent {
  private readonly baselineKeepCount = parseInt(process.env.BASELINE_KEEP_COUNT || '1', 10);
  private readonly changesKeepCount = parseInt(process.env.CHANGES_KEEP_COUNT || '5', 10);
  private readonly cleanupChangesAfterProcess = (process.env.CLEANUP_CHANGES_AFTER_PROCESS ?? 'true') === 'true';

  protected abstract readonly SCREENSHOTS_DIR: string;
  protected abstract readonly INCOMING_DIR: string;
  protected abstract readonly BASELINE_DIR: string;
  protected abstract readonly CHANGES_DIR: string;
  protected abstract readonly ext: string;
  /** Additional extensions accepted for incoming files (besides ext). Override in subclasses. */
  protected readonly extraExts: string[] = [];
  protected abstract readonly label: string;

  protected abstract readContent(filePath: string): Promise<string>;
  protected abstract runDiff(oldContent: string, newContent: string, key: string): Promise<DiffResult>;

  async process(): Promise<void> {
    await this.ensureDirs();
    const acceptedExts = [this.ext, ...this.extraExts];
    const files = (await readdir(this.INCOMING_DIR))
      .filter((name) => acceptedExts.some((e) => name.toLowerCase().endsWith(e)))
      .sort();

    if (files.length === 0) {
      console.log(`${this.label}: no new files.`);
      return;
    }

    console.log(`${this.label}: processing ${files.length} file(s)...`);
    for (const file of files) {
      const incomingPath = resolve(this.INCOMING_DIR, file);
      const key = this.extractKey(file);
      const baselines = await this.listBaselines(key);
      const baselinePath = baselines.at(-1) ?? null;

      const fileExt = this.fileExt(file);

      if (!baselinePath) {
        const newBaselinePath = resolve(this.BASELINE_DIR, `${key}__${this.timestamp()}${fileExt}`);
        await rename(incomingPath, newBaselinePath);
        await this.pruneOldBaselines(key, this.baselineKeepCount);
        console.log(`  Baseline created: ${newBaselinePath}`);
        continue;
      }

      const oldContent = await this.readContent(baselinePath);
      const newContent = await this.readContent(incomingPath);
      const diff = await this.runDiff(oldContent, newContent, key);

      if (!diff.changed) {
        await rm(incomingPath);
        console.log(`  Unchanged (${key}) -> removed`);
        continue;
      }

      const stamp = this.timestamp();
      const diffDir = resolve(this.CHANGES_DIR, `${stamp}-${key}`);
      await mkdir(diffDir, { recursive: true });

      const baselineExt = this.fileExt(baselinePath);
      await copyFile(baselinePath, resolve(diffDir, `old${baselineExt}`));
      await copyFile(incomingPath, resolve(diffDir, `new${fileExt}`));
      await writeFile(resolve(diffDir, 'changes.txt'), diff.summary || 'Change detected.', 'utf-8');

      const newBaselinePath = resolve(this.BASELINE_DIR, `${key}__${stamp}${fileExt}`);
      await rename(incomingPath, newBaselinePath);
      await this.pruneOldBaselines(key, this.baselineKeepCount);
      await this.pruneOldChanges(key, this.changesKeepCount);
      console.log(`  Changed (${key}) -> saved diff: ${diffDir}`);
    }

    if (this.cleanupChangesAfterProcess) {
      await this.clearChangesDir();
    }
  }

  private async clearChangesDir(): Promise<void> {
    if (!existsSync(this.CHANGES_DIR)) return;
    const entries = await readdir(this.CHANGES_DIR);
    for (const entry of entries) {
      await rm(resolve(this.CHANGES_DIR, entry), { recursive: true, force: true });
    }
    if (entries.length > 0) {
      console.log(`  ${this.label}: cleaned up ${entries.length} change(s) from ${this.CHANGES_DIR}`);
    }
  }

  protected fileExt(filename: string): string {
    const m = filename.match(/(\.[^.]+)$/);
    return m?.[1]?.toLowerCase() ?? this.ext;
  }

  protected extractKey(filename: string): string {
    const m = filename.match(/^\d+-(.+)_\d{8}-\d{6}\.[^.]+$/i);
    return m?.[1] ?? filename.replace(/\.[^.]+$/i, '');
  }

  protected async ensureDirs(): Promise<void> {
    for (const dir of [this.SCREENSHOTS_DIR, this.INCOMING_DIR, this.BASELINE_DIR, this.CHANGES_DIR]) {
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    }
  }

  protected async listBaselines(key: string): Promise<string[]> {
    const names = await readdir(this.BASELINE_DIR);
    const lKey = key.toLowerCase();
    const candidates = names.filter((n) => {
      const low = n.toLowerCase();
      return low.startsWith(`${lKey}__`) || low.replace(/\.[^.]+$/, '') === lKey;
    });

    const withTime = await Promise.all(
      candidates.map(async (name) => {
        const fullPath = resolve(this.BASELINE_DIR, name);
        const meta = await stat(fullPath);
        return { fullPath, time: meta.mtimeMs };
      })
    );

    withTime.sort((a, b) => a.time - b.time);
    return withTime.map((x) => x.fullPath);
  }

  protected async pruneOldBaselines(key: string, keep: number): Promise<void> {
    if (keep < 1) return;
    const baselines = await this.listBaselines(key);
    if (baselines.length <= keep) return;
    for (const path of baselines.slice(0, baselines.length - keep)) {
      if (existsSync(path)) await rm(path);
    }
  }

  protected async pruneOldChanges(key: string, keep: number): Promise<void> {
    if (keep < 1) return;
    const names = await readdir(this.CHANGES_DIR);
    const matching = names
      .filter((name) => name.toLowerCase().endsWith(`-${key.toLowerCase()}`))
      .map((name) => resolve(this.CHANGES_DIR, name));

    const withTime = await Promise.all(
      matching.map(async (fullPath) => {
        const meta = await stat(fullPath);
        return { fullPath, time: meta.mtimeMs };
      })
    );

    withTime.sort((a, b) => a.time - b.time);
    if (withTime.length <= keep) return;

    for (const entry of withTime.slice(0, withTime.length - keep)) {
      if (existsSync(entry.fullPath)) {
        await rm(entry.fullPath, { recursive: true, force: true });
      }
    }
  }

  protected timestamp(): string {
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
