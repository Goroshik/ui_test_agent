import OpenAI from 'openai';
import { ScreenshotCompareAgent } from '../snapshot-compare/snapshot-compare-agent.js';
import { SnapshotTextCompareAgent } from '../snapshot-text-compare/snapshot-text-compare-agent.js';

export class PostRunCompareAgent {
  private readonly screenshotCompareAgent: ScreenshotCompareAgent;
  private readonly snapshotTextCompareAgent: SnapshotTextCompareAgent;

  constructor(client: OpenAI, model: string) {
    this.screenshotCompareAgent = new ScreenshotCompareAgent(client, model);
    this.snapshotTextCompareAgent = new SnapshotTextCompareAgent(client, model);
  }

  async process(): Promise<void> {
    await this.screenshotCompareAgent.process();
    await this.snapshotTextCompareAgent.process();
  }
}

export { PostRunCompareAgent as PostRunSnapshotCompareAgent };
export { PostRunCompareAgent as PostRunVisualAgent };
