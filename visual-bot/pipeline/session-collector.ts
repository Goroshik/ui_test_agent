import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import type {
  SessionMeta,
  SessionStepSummary,
  StepRecord,
  ActionData,
  ArtifactRefs,
  AfterArtifacts,
} from './types.js';

/**
 * Manages file I/O for one browser session: directory structure,
 * session-meta.json, step-NNN.json files, and raw artifacts.
 */
export class SessionCollector {
  readonly sessionId: string;

  private readonly sessionDir: string;
  private readonly stepsDir: string;
  private readonly rawDir: string;
  private stepCounter = 0;

  constructor(dataDir: string, sessionId: string) {
    this.sessionId = sessionId;
    this.sessionDir = join(dataDir, 'sessions', sessionId);
    this.stepsDir = join(this.sessionDir, 'steps');
    this.rawDir = join(this.sessionDir, 'raw');
  }

  async init(task: string, baseUrl: string): Promise<void> {
    await mkdir(this.stepsDir, { recursive: true });
    await mkdir(join(this.sessionDir, 'analyzed'), { recursive: true });
    for (const sub of ['aria', 'dom', 'network', 'storage', 'screenshots']) {
      await mkdir(join(this.rawDir, sub), { recursive: true });
    }

    const meta: SessionMeta = {
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
      task,
      baseUrl,
      status: 'running',
      steps: [],
    };
    await this._writeMeta(meta);
    console.log(`[Pipeline] Session: ${this.sessionDir}`);
  }

  /** Allocate next step ID (step-001, step-002, …). Call BEFORE saving artifacts. */
  nextStepId(): string {
    this.stepCounter++;
    return `step-${String(this.stepCounter).padStart(3, '0')}`;
  }

  // ─── Raw artifact writers ────────────────────────────────────────────────────

  async saveAriaSnapshot(stepId: string, content: string): Promise<string> {
    const file = `${stepId}-aria.yaml`;
    await writeFile(join(this.rawDir, 'aria', file), content, 'utf-8');
    return `raw/aria/${file}`;
  }

  async saveDomSnapshot(stepId: string, content: string): Promise<string> {
    const file = `${stepId}-dom.html`;
    await writeFile(join(this.rawDir, 'dom', file), content, 'utf-8');
    return `raw/dom/${file}`;
  }

  /** Saves a structured interactive-DOM dump (live JS evaluation). */
  async saveDomDump(stepId: string, data: unknown): Promise<string> {
    const file = `${stepId}-dom.json`;
    await writeFile(join(this.rawDir, 'dom', file), JSON.stringify(data, null, 2), 'utf-8');
    return `raw/dom/${file}`;
  }

  async saveNetwork(stepId: string, data: unknown): Promise<string> {
    const file = `${stepId}-network.json`;
    await writeFile(join(this.rawDir, 'network', file), JSON.stringify(data, null, 2), 'utf-8');
    return `raw/network/${file}`;
  }

  async saveStorage(stepId: string, data: unknown): Promise<string> {
    const file = `${stepId}-storage.json`;
    await writeFile(join(this.rawDir, 'storage', file), JSON.stringify(data, null, 2), 'utf-8');
    return `raw/storage/${file}`;
  }

  async saveScreenshot(stepId: string, phase: 'before' | 'after', base64: string): Promise<string> {
    const file = `${stepId}-${phase}.webp`;
    await writeFile(join(this.rawDir, 'screenshots', file), Buffer.from(base64, 'base64'));
    return `raw/screenshots/${file}`;
  }

  // ─── Step lifecycle ───────────────────────────────────────────────────────────

  async beginStep(
    stepId: string,
    url: string,
    action: ActionData,
    before: ArtifactRefs | null,
  ): Promise<void> {
    const record: StepRecord = {
      stepId,
      stepIndex: this.stepCounter,
      timestamp: new Date().toISOString(),
      url,
      action,
      before,
      after: null,
      status: 'incomplete',
    };
    await writeFile(join(this.stepsDir, `${stepId}.json`), JSON.stringify(record, null, 2), 'utf-8');
  }

  async completeStep(stepId: string, after: AfterArtifacts): Promise<void> {
    const path = join(this.stepsDir, `${stepId}.json`);
    let record: StepRecord;
    try {
      record = JSON.parse(await readFile(path, 'utf-8')) as StepRecord;
    } catch {
      return;
    }
    record.after = after;
    record.status = 'complete';
    await writeFile(path, JSON.stringify(record, null, 2), 'utf-8');

    await this._appendStepSummary({
      stepId,
      stepIndex: record.stepIndex,
      action: record.action.type,
      description: record.action.description,
      url: record.url,
      status: 'complete',
    });
  }

  async finishSession(status: 'completed' | 'failed'): Promise<void> {
    const meta = await this._readMeta();
    if (!meta) return;
    meta.status = status;
    await this._writeMeta(meta);
  }

  get sessionDirectory(): string {
    return this.sessionDir;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async _writeMeta(meta: SessionMeta): Promise<void> {
    await writeFile(
      join(this.sessionDir, 'session-meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  private async _readMeta(): Promise<SessionMeta | null> {
    try {
      return JSON.parse(await readFile(join(this.sessionDir, 'session-meta.json'), 'utf-8')) as SessionMeta;
    } catch {
      return null;
    }
  }

  private async _appendStepSummary(summary: SessionStepSummary): Promise<void> {
    const meta = await this._readMeta();
    if (!meta) return;
    const idx = meta.steps.findIndex((s) => s.stepId === summary.stepId);
    if (idx >= 0) {
      meta.steps[idx] = summary;
    } else {
      meta.steps.push(summary);
    }
    await this._writeMeta(meta);
  }
}
