import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveModel } from './utils.js';
import type { LlmProvider } from './llm-provider.js';
import type { OllamaModelManager } from './ollama-model-manager.js';
import type { Agent } from './agents/main/agent.js';
import { PipelineRunner } from './agents/pipeline/pipeline-runner.js';

export interface RunPipelineParams {
  agent: Agent;
  analyzer: LlmProvider;
  mm: OllamaModelManager;
  mainModel: string | undefined;
}

/**
 * Runs the analysis pipeline on the collected session data, if enabled and a
 * session exists.
 *
 * Lives outside index.ts on purpose: index.ts is an entry point excluded from
 * coverage, so anything in it is invisible to the CRAP gate however well tested.
 * This module sits in the same directory, so the `..`/data path below resolves
 * exactly as it did before.
 */
export async function runAnalysisPipeline(params: RunPipelineParams): Promise<void> {
  const { agent, analyzer, mm, mainModel } = params;
  const pipelineEnabled = process.env.PIPELINE_ENABLED !== 'false';
  if (!pipelineEnabled) return;

  const sessionDir = agent.getSessionDirectory();
  if (!sessionDir) return;

  const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');
  const pipelineModel =
    analyzer.model || (analyzer.kind === 'ollama' ? await resolveModel(analyzer.client) : '');
  if (!pipelineModel) throw new Error('No analyzer model configured for pipeline');

  const runPipeline = (): Promise<void> =>
    new PipelineRunner(analyzer.client, pipelineModel).run(sessionDir, dataDir);

  if (analyzer.kind === 'ollama') {
    await mm.withModel(analyzer.model || mainModel, runPipeline);
  } else {
    await runPipeline();
  }
}
