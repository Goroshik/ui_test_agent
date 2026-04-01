import OpenAI from 'openai';
import { parseDiffJson, type DiffResult } from './utils.js';
import { AttentionMemory } from './attention-memory.js';

export type { DiffResult as TextDiffResult };

export class VisualTextDiff {
  private readonly memory: AttentionMemory;

  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {
    this.memory = new AttentionMemory(client, model, 'snapshot');
  }

  async compare(oldSnapshot: string, newSnapshot: string, key: string): Promise<DiffResult> {
    const deterministicChanged = this.hasDeterministicChange(oldSnapshot, newSnapshot);
    const guidance = await this.memory.getGuidance();

    let text = '';
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Compare two accessibility snapshots. Return strict JSON only: {"changed":boolean,"summary":string}. Be sensitive to visible label/text changes (e.g. "Company policies" -> "Policies"). Ignore only volatile ids/refs if the visible structure is equivalent.' +
              (guidance ? `\n\nPast attention rules:\n${guidance}` : ''),
          },
          {
            role: 'user',
            content: `Old snapshot:\n${oldSnapshot}\n\nNew snapshot:\n${newSnapshot}`,
          },
        ],
      });
      text = response.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
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

    const parsed = parseDiffJson(text);
    if (!parsed) {
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
        await this.memory.rememberChange(key, result.summary, oldSnapshot, newSnapshot);
      }
      return result;
    }

    if (!parsed.changed && deterministicChanged) {
      const result: DiffResult = {
        changed: true,
        summary:
          parsed.summary || 'Deterministic snapshot diff detected text/structure changes.',
      };
      await this.memory.rememberChange(key, result.summary, oldSnapshot, newSnapshot);
      return result;
    }

    if (parsed.changed) {
      await this.memory.rememberChange(key, parsed.summary, oldSnapshot, newSnapshot);
    }

    return parsed;
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
