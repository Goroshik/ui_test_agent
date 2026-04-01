import OpenAI from 'openai';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { BaseCompareAgent } from '../base-compare-agent.js';
import { VisualDiff } from '../../visual-diff.js';
import type { DiffResult } from '../../utils.js';

const SCREENSHOTS_DIR = resolve(process.cwd(), 'screenshots');

export class ScreenshotCompareAgent extends BaseCompareAgent {
  protected readonly SCREENSHOTS_DIR = SCREENSHOTS_DIR;
  protected readonly INCOMING_DIR = resolve(SCREENSHOTS_DIR, 'incoming');
  protected readonly BASELINE_DIR = resolve(SCREENSHOTS_DIR, 'baseline');
  protected readonly CHANGES_DIR = resolve(SCREENSHOTS_DIR, 'changes');
  protected readonly ext = '.png';
  protected readonly label = 'Screenshot compare';

  private readonly diff: VisualDiff;

  constructor(client: OpenAI, model: string) {
    super();
    this.diff = new VisualDiff(client, model);
  }

  protected async readContent(filePath: string): Promise<string> {
    return readFile(filePath, 'base64');
  }

  protected async runDiff(oldContent: string, newContent: string, key: string): Promise<DiffResult> {
    return this.diff.compare(oldContent, newContent, key);
  }
}

export { ScreenshotCompareAgent as SnapshotCompareAgent };
