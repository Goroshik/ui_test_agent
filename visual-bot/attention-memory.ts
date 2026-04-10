import OpenAI from 'openai';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

type MemoryKind = 'screenshot' | 'snapshot';

interface AttentionMemoryEntry {
  id: string;
  kind: MemoryKind;
  key: string;
  summary: string;
  rule: string;
  createdAt: string;
}

interface RulePayload {
  rule?: unknown;
}

const FILE_PATH = resolve(process.cwd(), 'data', 'attention-memory.json');

export class AttentionMemory {
  private readonly maxEntries = parseInt(process.env.ATTENTION_MEMORY_MAX || '200', 10);

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly kind: MemoryKind,
  ) {}

  async getGuidance(limit = 8): Promise<string> {
    const all = await this._load();
    const entries = all.filter((e) => e.kind === this.kind).slice(-limit);
    if (entries.length === 0) return '';
    return entries.map((e, i) => `${i + 1}. ${e.rule}`).join('\n');
  }

  async rememberChange(
    key: string,
    summary: string,
    oldSample?: string,
    newSample?: string,
  ): Promise<void> {
    const cleanSummary = (summary || '').trim();
    if (!cleanSummary) return;

    const rule = await this._summarizeRule(key, cleanSummary, oldSample, newSample);
    if (!rule) return;

    const all = await this._load();
    const duplicate = all.find(
      (e) => e.kind === this.kind && e.key === key && e.rule.toLowerCase() === rule.toLowerCase(),
    );
    if (duplicate) return;

    const entry: AttentionMemoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: this.kind,
      key,
      summary: cleanSummary.slice(0, 300),
      rule,
      createdAt: new Date().toISOString(),
    };

    const capped = [...all, entry].slice(-Math.max(1, this.maxEntries));
    await this._save(capped);
  }

  private async _summarizeRule(
    key: string,
    summary: string,
    oldSample?: string,
    newSample?: string,
  ): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You create concise QA attention rules for future UI diffs. Return strict JSON only: {"rule":"..."}.' +
              ' Rule must be one short actionable sentence, generic, and focus on visible labels/text/structure changes.',
          },
          {
            role: 'user',
            content:
              `Type: ${this.kind}\nKey: ${key}\nDetected summary: ${summary}\n` +
              (oldSample ? `Old sample:\n${oldSample.slice(0, 1800)}\n` : '') +
              (newSample ? `New sample:\n${newSample.slice(0, 1800)}\n` : ''),
          },
        ],
      });

      const text = response.choices[0]?.message?.content?.trim() ?? '';
      const payload = this._parseJson(text);
      const rule = typeof payload?.rule === 'string' ? payload.rule.trim() : '';
      return rule || this._fallbackRule(summary);
    } catch {
      return this._fallbackRule(summary);
    }
  }

  private _fallbackRule(summary: string): string {
    const trimmed = summary.trim().replace(/\s+/g, ' ');
    return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  }

  private _parseJson(input: string): RulePayload | null {
    if (!input) return null;
    const start = input.indexOf('{');
    const end = input.lastIndexOf('}');
    try {
      return JSON.parse(start >= 0 && end > start ? input.slice(start, end + 1) : input) as RulePayload;
    } catch {
      return null;
    }
  }

  private async _load(): Promise<AttentionMemoryEntry[]> {
    if (!existsSync(FILE_PATH)) return [];
    try {
      const parsed = JSON.parse(await readFile(FILE_PATH, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(this._isEntry);
    } catch {
      return [];
    }
  }

  private async _save(entries: AttentionMemoryEntry[]): Promise<void> {
    const dir = dirname(FILE_PATH);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(FILE_PATH, JSON.stringify(entries, null, 2), 'utf-8');
  }

  private _isEntry(value: unknown): value is AttentionMemoryEntry {
    const v = value as Partial<AttentionMemoryEntry>;
    return Boolean(
      v &&
      (v.kind === 'screenshot' || v.kind === 'snapshot') &&
      typeof v.id === 'string' &&
      typeof v.key === 'string' &&
      typeof v.summary === 'string' &&
      typeof v.rule === 'string' &&
      typeof v.createdAt === 'string',
    );
  }
}
