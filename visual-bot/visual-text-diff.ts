import OpenAI from 'openai';
import { parseDiffJson, type DiffResult } from './utils.js';
import { AttentionMemory } from './attention-memory.js';
import { getContentSummary, upsertContentSummary } from './pipeline/content-summary-store.js';

export type { DiffResult as TextDiffResult };

interface ChatCompletionLike {
  choices: { message?: { content?: string | null } | null }[];
}

interface CompareContext {
  key: string;
  oldSnapshot: string;
  newSnapshot: string;
}

export class VisualTextDiff {
  private readonly memory: AttentionMemory;

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {
    this.memory = new AttentionMemory(client, model, 'snapshot');
  }

  async compare(oldSnapshot: string, newSnapshot: string, key: string): Promise<DiffResult> {
    const deterministicChanged = this.hasDeterministicChange(oldSnapshot, newSnapshot);
    return this.compareBatched(oldSnapshot, newSnapshot, key, deterministicChanged);
  }

  // ─── Batched approach (file-cached summaries) ─────────────────────────────────

  private async compareBatched(
    oldSnapshot: string,
    newSnapshot: string,
    key: string,
    deterministicChanged: boolean,
  ): Promise<DiffResult> {
    const guidance = await this.memory.getGuidance();

    // Step 1: get or create baseline summary (one LLM call, small context)
    let oldSummary = await getContentSummary(key, 'snapshot');
    if (!oldSummary) {
      oldSummary = await this.summarizeSnapshot(oldSnapshot, key);
      await upsertContentSummary(key, 'snapshot', oldSummary);
    }

    // Step 2: summarize incoming (one LLM call, small context)
    const newSummary = await this.summarizeSnapshot(newSnapshot, key);

    // Step 3: compare summaries (tiny context)
    const result = await this.compareSummaries(oldSummary, newSummary, key, guidance);

    if (!result.changed && deterministicChanged) {
      result.changed = true;
      result.summary = result.summary || 'Deterministic snapshot diff detected text/structure changes.';
    }

    if (result.changed) {
      await upsertContentSummary(key, 'snapshot', newSummary);
      await this.memory.rememberChange(key, result.summary, oldSnapshot, newSnapshot);
    }

    return result;
  }

  private async summarizeSnapshot(content: string, key: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Summarize this accessibility snapshot in under 200 words. Cover: page title, main navigation, key interactive elements, form fields, visible text labels. Focus on semantic structure and visible content.',
          },
          {
            role: 'user',
            content: `Key: ${key}\n\nSnapshot:\n${content}`,
          },
        ],
      });
      return response.choices[0]?.message?.content?.trim() ?? content.slice(0, 500);
    } catch {
      // Fallback: use truncated raw content as summary
      return content.slice(0, 500);
    }
  }

  private extractResponseText(response: ChatCompletionLike): string {
    return response.choices[0]?.message?.content?.trim() ?? '';
  }

  private buildSummaryComparePrompt(guidance: string): string {
    const base =
      'Compare two webpage state descriptions. Return strict JSON only: {"changed":boolean,"summary":string}. Be sensitive to visible label/text changes. Ignore only volatile ids/refs if visible structure is equivalent.';
    return guidance ? `${base}\n\nPast attention rules:\n${guidance}` : base;
  }

  private buildSummaryCompareError(err: unknown): DiffResult {
    const message = (err as Error).message ?? String(err);
    console.warn(`  VisualTextDiff: compare summaries error: ${message}`);
    return { changed: true, summary: `Compare unavailable: ${message}` };
  }

  private async compareSummaries(
    oldSummary: string,
    newSummary: string,
    key: string,
    guidance: string,
  ): Promise<DiffResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          { role: 'system', content: this.buildSummaryComparePrompt(guidance) },
          {
            role: 'user',
            content: `Key: ${key}\n\nOld state:\n${oldSummary}\n\nNew state:\n${newSummary}`,
          },
        ],
      });
      const text = this.extractResponseText(response);
      return parseDiffJson(text) ?? { changed: true, summary: text || 'Non-JSON response; treated as changed.' };
    } catch (err) {
      return this.buildSummaryCompareError(err);
    }
  }

  // ─── Full-content approach (fallback, no DB) ─────────────────────────────────

  private buildFullComparePrompt(guidance: string): string {
    const base =
      'Compare two accessibility snapshots. Return strict JSON only: {"changed":boolean,"summary":string}. Be sensitive to visible label/text changes (e.g. "Company policies" -> "Policies"). Ignore only volatile ids/refs if the visible structure is equivalent.';
    return guidance ? `${base}\n\nPast attention rules:\n${guidance}` : base;
  }

  private async requestFullCompareText(
    oldSnapshot: string,
    newSnapshot: string,
    guidance: string,
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        { role: 'system', content: this.buildFullComparePrompt(guidance) },
        {
          role: 'user',
          content: `Old snapshot:\n${oldSnapshot}\n\nNew snapshot:\n${newSnapshot}`,
        },
      ],
    });
    return this.extractResponseText(response);
  }

  private buildLlmUnavailableResult(deterministicChanged: boolean, err: unknown): DiffResult {
    const status = (err as { status?: number }).status;
    const message = (err as Error).message ?? String(err);
    console.warn(`  VisualTextDiff: API error (${status ?? 'unknown'}): ${message}`);
    if (deterministicChanged) {
      return {
        changed: true,
        summary: 'Deterministic snapshot diff detected content changes (LLM unavailable).',
      };
    }
    return {
      changed: false,
      summary: 'No deterministic snapshot differences detected (LLM unavailable).',
    };
  }

  private async resolveNonJsonFullCompare(
    text: string,
    deterministicChanged: boolean,
    ctx: CompareContext,
  ): Promise<DiffResult> {
    const result = deterministicChanged
      ? {
          changed: true,
          summary:
            text || 'Model returned non-JSON; deterministic snapshot diff detected changes.',
        }
      : {
          changed: false,
          summary: 'Model returned non-JSON; deterministic snapshot diff found no changes.',
        };
    if (result.changed) {
      await this.memory.rememberChange(ctx.key, result.summary, ctx.oldSnapshot, ctx.newSnapshot);
    }
    return result;
  }

  private async resolveParsedFullCompare(
    parsed: DiffResult,
    deterministicChanged: boolean,
    ctx: CompareContext,
  ): Promise<DiffResult> {
    if (!parsed.changed && deterministicChanged) {
      const result: DiffResult = {
        changed: true,
        summary:
          parsed.summary || 'Deterministic snapshot diff detected text/structure changes.',
      };
      await this.memory.rememberChange(ctx.key, result.summary, ctx.oldSnapshot, ctx.newSnapshot);
      return result;
    }

    if (parsed.changed) {
      await this.memory.rememberChange(ctx.key, parsed.summary, ctx.oldSnapshot, ctx.newSnapshot);
    }

    return parsed;
  }

  private async compareFull(
    oldSnapshot: string,
    newSnapshot: string,
    key: string,
    deterministicChanged: boolean,
  ): Promise<DiffResult> {
    const guidance = await this.memory.getGuidance();
    const ctx: CompareContext = { key, oldSnapshot, newSnapshot };

    let text: string;
    try {
      text = await this.requestFullCompareText(oldSnapshot, newSnapshot, guidance);
    } catch (err) {
      return this.buildLlmUnavailableResult(deterministicChanged, err);
    }

    const parsed = parseDiffJson(text);
    if (!parsed) {
      return this.resolveNonJsonFullCompare(text, deterministicChanged, ctx);
    }

    return this.resolveParsedFullCompare(parsed, deterministicChanged, ctx);
  }

  private hasDeterministicChange(oldSnapshot: string, newSnapshot: string): boolean {
    const oldNorm = this.normalizeSnapshot(oldSnapshot);
    const newNorm = this.normalizeSnapshot(newSnapshot);
    return oldNorm !== newNorm;
  }

  private normalizeSnapshot(snapshot: string): string {
    const yaml = this.extractYaml(snapshot);
    return yaml
      .toLowerCase()
      .replace(/\[ref=e\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractYaml(snapshot: string): string {
    const match = snapshot.match(/```yaml\s*([\s\S]*?)```/i);
    return match?.[1] ?? snapshot;
  }
}
