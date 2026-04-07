import OpenAI from 'openai';
import { ComponentSplitter } from './splitter.js';
import { ComponentAnalyzer } from './analyzer.js';
import { hashContent } from './hasher.js';
import {
  dbUpsertComponent,
  dbGetComponent,
  dbFindComponentByHash,
  type ComponentDoc,
} from '../../db.js';

/**
 * Orchestrates the two-stage component analysis pipeline:
 *   Stage 1 — split snapshot into named UI blocks (splitter)
 *   Stage 2 — describe each block in parallel (analyzer)
 *
 * Skips blocks whose content hasn't changed (same hash).
 * Reuses descriptions across URLs when block content is identical.
 */
export class ComponentOrchestrator {
  private readonly splitter: ComponentSplitter;
  private readonly analyzer: ComponentAnalyzer;

  constructor(client: OpenAI, model: string) {
    this.splitter = new ComponentSplitter(client, model);
    this.analyzer = new ComponentAnalyzer(client, model);
  }

  async process(url: string, snapshotText: string): Promise<void> {
    // Stage 1: identify and extract blocks
    const blocks = await this.splitter.split(snapshotText);

    if (blocks.length === 0) {
      console.log(`  [Components] No blocks identified for ${url}`);
      return;
    }

    console.log(`  [Components] ${blocks.length} block(s): ${blocks.map((b) => b.blockName).join(', ')}`);

    // Stage 2: analyze each block in parallel
    await Promise.all(
      blocks.map(async (block) => {
        const hash = hashContent(block.content);

        // Same URL + same block + same content → nothing changed
        const existing = await dbGetComponent(url, block.blockName);
        if (existing?.contentHash === hash) {
          console.log(`  [Components] Unchanged — skip: ${block.blockName}`);
          return;
        }

        // Same content exists for a different URL → reuse description, no LLM call
        const sameContent = await dbFindComponentByHash(hash);
        if (sameContent) {
          console.log(`  [Components] Reuse from "${sameContent.url}": ${block.blockName}`);
          await dbUpsertComponent(this.buildDoc(url, block.blockName, hash, sameContent.description));
          return;
        }

        // New or changed — call LLM
        console.log(`  [Components] Analyzing: ${block.blockName}`);
        const description = await this.analyzer.describe(block.blockName, block.content);
        if (!description) return;

        await dbUpsertComponent(this.buildDoc(url, block.blockName, hash, description));
        console.log(`  [Components] Saved: ${block.blockName}`);
      }),
    );
  }

  private buildDoc(url: string, blockName: string, contentHash: string, description: string): ComponentDoc {
    return { url, blockName, contentHash, description, analyzedAt: new Date().toISOString() };
  }
}
