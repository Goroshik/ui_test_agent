import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';

/** PipelineRunner.run is mocked so no real analysis pipeline is started. */
const runs: Array<{ model: string; sessionDir: string; dataDir: string }> = [];

vi.mock('./agents/pipeline/pipeline-runner.js', () => ({
  PipelineRunner: class {
    private readonly model: string;
    constructor(_client: unknown, model: string) {
      this.model = model;
    }
    run(sessionDir: string, dataDir: string): Promise<void> {
      runs.push({ model: this.model, sessionDir, dataDir });
      return Promise.resolve();
    }
  },
}));

/** resolveModel is mocked so the ollama probe never hits the network. */
let resolvedModel = 'probed-model';

vi.mock('./utils.js', () => ({
  resolveModel: (): Promise<string> => Promise.resolve(resolvedModel),
}));

const { runAnalysisPipeline } = await import('./run-analysis-pipeline.js');

type Params = Parameters<typeof runAnalysisPipeline>[0];

const savedPipelineEnabled = process.env.PIPELINE_ENABLED;

beforeEach(() => {
  runs.length = 0;
  resolvedModel = 'probed-model';
  delete process.env.PIPELINE_ENABLED;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedPipelineEnabled === undefined) delete process.env.PIPELINE_ENABLED;
  else process.env.PIPELINE_ENABLED = savedPipelineEnabled;
});

function params(options: {
  sessionDir?: string | null;
  kind?: 'ollama' | 'openrouter';
  analyzerModel?: string;
  mainModel?: string;
  withModelCalls?: Array<string | undefined>;
} = {}): Params {
  const {
    sessionDir = '/tmp/session-1',
    kind = 'openrouter',
    analyzerModel = 'analyzer-model',
    mainModel = 'main-model',
    withModelCalls = [],
  } = options;

  return {
    agent: { getSessionDirectory: () => sessionDir } as never,
    analyzer: { kind, model: analyzerModel, client: {} as unknown as OpenAI },
    mm: {
      withModel: (model: string | undefined, fn: () => Promise<void>): Promise<void> => {
        withModelCalls.push(model);
        return fn();
      },
    } as never,
    mainModel,
  };
}

describe('runAnalysisPipeline', () => {
  it('runs the pipeline for the collected session', async () => {
    await runAnalysisPipeline(params());

    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionDir).toBe('/tmp/session-1');
    expect(runs[0]?.model).toBe('analyzer-model');
  });

  it('resolves the data directory next to the project root', async () => {
    await runAnalysisPipeline(params());
    expect(runs[0]?.dataDir.replace(/\\/g, '/')).toMatch(/\/data$/);
  });

  it('does nothing when PIPELINE_ENABLED is "false"', async () => {
    process.env.PIPELINE_ENABLED = 'false';
    await runAnalysisPipeline(params());
    expect(runs).toEqual([]);
  });

  it('still runs for any other PIPELINE_ENABLED value', async () => {
    process.env.PIPELINE_ENABLED = 'true';
    await runAnalysisPipeline(params());
    expect(runs).toHaveLength(1);
  });

  it('does nothing when the agent recorded no session', async () => {
    await runAnalysisPipeline(params({ sessionDir: null }));
    expect(runs).toEqual([]);
  });

  it('probes for a model when an ollama analyzer declares none', async () => {
    resolvedModel = 'discovered-model';
    await runAnalysisPipeline(params({ kind: 'ollama', analyzerModel: '' }));

    expect(runs[0]?.model).toBe('discovered-model');
  });

  it('throws when no analyzer model can be determined', async () => {
    resolvedModel = '';
    await expect(
      runAnalysisPipeline(params({ kind: 'ollama', analyzerModel: '' })),
    ).rejects.toThrow(/No analyzer model configured for pipeline/);
  });

  it('throws for a non-ollama analyzer with no model, without probing', async () => {
    await expect(
      runAnalysisPipeline(params({ kind: 'openrouter', analyzerModel: '' })),
    ).rejects.toThrow(/No analyzer model configured for pipeline/);
  });

  it('wraps the run in the model manager for an ollama analyzer', async () => {
    const withModelCalls: Array<string | undefined> = [];
    await runAnalysisPipeline(
      params({ kind: 'ollama', analyzerModel: 'llama-3', withModelCalls }),
    );

    expect(withModelCalls).toEqual(['llama-3']);
    expect(runs).toHaveLength(1);
  });

  it('falls back to the main model when swapping for an unnamed ollama analyzer', async () => {
    const withModelCalls: Array<string | undefined> = [];
    await runAnalysisPipeline(
      params({ kind: 'ollama', analyzerModel: '', mainModel: 'main-model', withModelCalls }),
    );

    expect(withModelCalls).toEqual(['main-model']);
  });

  it('does not involve the model manager for a non-ollama analyzer', async () => {
    const withModelCalls: Array<string | undefined> = [];
    await runAnalysisPipeline(params({ kind: 'openrouter', withModelCalls }));

    expect(withModelCalls).toEqual([]);
    expect(runs).toHaveLength(1);
  });
});
