import OpenAI from 'openai';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { AriaAnalyzerAgent } from './aria-analyzer-agent.js';
import { DomAnalyzerAgent } from './dom-analyzer-agent.js';
import { NetworkAnalyzerAgent } from './network-analyzer-agent.js';
import { IdentityResolutionAgent } from './identity-resolution-agent.js';
import { NeedsTestIdReportAgent } from './needs-testid-report-agent.js';
import type { SessionMeta } from '../../pipeline/types.js';

/**
 * Orchestrates the post-run analysis pipeline (Steps 2–5):
 *   1. ARIA Analyzer   → analyzed/aria-components.json
 *   2. DOM Analyzer    → analyzed/dom-components.json
 *   3. Network Analyzer → analyzed/network-map.json
 *   4. Identity Resolution → registry/components.json, registry/pages.json
 */
export class PipelineRunner {
  private readonly ariaAgent: AriaAnalyzerAgent;
  private readonly domAgent: DomAnalyzerAgent;
  private readonly networkAgent: NetworkAnalyzerAgent;
  private readonly identityAgent: IdentityResolutionAgent;
  private readonly reportAgent: NeedsTestIdReportAgent;

  constructor(client: OpenAI, model: string) {
    this.ariaAgent = new AriaAnalyzerAgent(client, model);
    this.domAgent = new DomAnalyzerAgent(client, model);
    this.networkAgent = new NetworkAnalyzerAgent(client, model);
    this.identityAgent = new IdentityResolutionAgent(client, model);
    this.reportAgent = new NeedsTestIdReportAgent(client, model);
  }

  async run(sessionDir: string, dataDir: string): Promise<void> {
    console.log('\n[Pipeline] Starting post-run analysis…');

    // Load step metadata for URL mapping
    const stepMeta = await this._loadStepMeta(sessionDir);
    if (stepMeta.length === 0) {
      console.log('[Pipeline] No steps to analyze, skipping');
      return;
    }

    // Steps 2–4: analyze raw artifacts in parallel
    await Promise.all([
      this.ariaAgent.analyze(sessionDir, stepMeta),
      this.domAgent.analyze(sessionDir, stepMeta),
      this.networkAgent.analyze(sessionDir),
    ]);

    // Step 5: identity resolution (needs all analyzed files)
    await this.identityAgent.run(sessionDir, dataDir);

    // Step 6: classify registry → write needs-testid report
    await this.reportAgent.run(dataDir);

    console.log('[Pipeline] Analysis complete.\n');
  }

  private async _loadStepMeta(
    sessionDir: string,
  ): Promise<Array<{ stepId: string; url: string }>> {
    const metaPath = join(sessionDir, 'session-meta.json');
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as SessionMeta;
      return meta.steps.map((s) => ({ stepId: s.stepId, url: s.url }));
    } catch {
      return [];
    }
  }
}
