import OpenAI from 'openai';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { BaseCompareAgent } from '../base-compare-agent.js';
import { VisualTextDiff } from '../../visual-text-diff.js';
import type { DiffResult } from '../../utils.js';

const SCREENSHOTS_DIR = resolve(process.cwd(), 'screenshots');

export class SnapshotTextCompareAgent extends BaseCompareAgent {
  protected readonly SCREENSHOTS_DIR = SCREENSHOTS_DIR;
  protected readonly INCOMING_DIR = resolve(SCREENSHOTS_DIR, 'snapshots-incoming');
  protected readonly BASELINE_DIR = resolve(SCREENSHOTS_DIR, 'snapshots-baseline');
  protected readonly CHANGES_DIR = resolve(SCREENSHOTS_DIR, 'snapshots-changes');
  protected readonly ext = '.txt';
  protected readonly label = 'Snapshot text compare';

  private readonly diff: VisualTextDiff;

  constructor(client: OpenAI, model: string) {
    super();
    this.diff = new VisualTextDiff(client, model);
  }

  protected async readContent(filePath: string): Promise<string> {
    return readFile(filePath, 'utf-8');
  }

  protected async runDiff(oldContent: string, newContent: string, key: string): Promise<DiffResult> {
    return this.diff.compare(oldContent, newContent, key);
  }
}
