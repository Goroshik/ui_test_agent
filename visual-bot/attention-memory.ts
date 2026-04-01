import OpenAI from 'openai';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';

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

export class AttentionMemory {
  private readonly filePath = resolve(process.cwd(), 'screenshots', 'attention-memory.json');
  private readonly maxEntries = parseInt(process.env.ATTENTION_MEMORY_MAX || '200', 10);

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly kind: MemoryKind
  ) {}

  async getGuidance(limit = 8): Promise<string> {
    const all = await this.load();
    const entries = all
      .filter((e) => e.kind === this.kind)
      .slice(-limit);

    if (entries.length === 0) return '';

    return entries
      .map((e, i) => `${i + 1}. ${e.rule}`)
      .join('\n');
  }

  async rememberChange(
    key: string,
    summary: string,
    oldSample?: string,
    newSample?: string
  ): Promise<void> {
    const cleanSummary = (summary || '').trim();
    if (!cleanSummary) return;

    const rule = await this.summarizeRule(key, cleanSummary, oldSample, newSample);
    if (!rule) return;

    const all = await this.load();
    const duplicate = all.find(
      (e) =>
        e.kind === this.kind &&
        e.key === key &&
        e.rule.toLowerCase() === rule.toLowerCase()
    );
    if (duplicate) return;

    const now = new Date().toISOString();
    all.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: this.kind,
      key,
      summary: cleanSummary.slice(0, 300),
      rule,
      createdAt: now,
    });

    const capped = all.slice(-Math.max(1, this.maxEntries));
    await this.save(capped);
  }

  private async summarizeRule(
    key: string,
    summary: string,
    oldSample?: string,
    newSample?: string
  ): Promise<string> {
    try {
      const oldCut = oldSample ? oldSample.slice(0, 1800) : '';
      const newCut = newSample ? newSample.slice(0, 1800) : '';

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
              `Type: ${this.kind}\n` +
              `Key: ${key}\n` +
              `Detected summary: ${summary}\n` +
              (oldCut ? `Old sample:\n${oldCut}\n` : '') +
              (newCut ? `New sample:\n${newCut}\n` : ''),
          },
        ],
      });

      const text = response.choices[0]?.message?.content?.trim() ?? '';
      const payload = this.parseRulePayload(text);
      const rule = typeof payload?.rule === 'string' ? payload.rule.trim() : '';
      return rule || this.fallbackRule(summary);
    } catch {
      return this.fallbackRule(summary);
    }
  }

  private fallbackRule(summary: string): string {
    const trimmed = summary.trim().replace(/\s+/g, ' ');
    return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  }

  private parseRulePayload(input: string): RulePayload | null {
    if (!input) return null;
    const firstBrace = input.indexOf('{');
    const lastBrace = input.lastIndexOf('}');
    const payload = firstBrace >= 0 && lastBrace > firstBrace
      ? input.slice(firstBrace, lastBrace + 1)
      : input;
    try {
      return JSON.parse(payload) as RulePayload;
    } catch {
      return null;
    }
  }

  private async load(): Promise<AttentionMemoryEntry[]> {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(this.isEntry);
    } catch {
      return [];
    }
  }

  private async save(entries: AttentionMemoryEntry[]): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(this.filePath, JSON.stringify(entries, null, 2), 'utf-8');
  }

  private isEntry(value: unknown): value is AttentionMemoryEntry {
    const v = value as Partial<AttentionMemoryEntry>;
    return Boolean(
      v &&
      (v.kind === 'screenshot' || v.kind === 'snapshot') &&
      typeof v.id === 'string' &&
      typeof v.key === 'string' &&
      typeof v.summary === 'string' &&
      typeof v.rule === 'string' &&
      typeof v.createdAt === 'string'
    );
  }
}
