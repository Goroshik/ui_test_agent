import OpenAI from 'openai';
import { getRegistryPages, type RegistryPageRecord } from '../../registry-context.js';
import { resolveModel } from '../../utils.js';

const MAX_PAGES_IN_CONTEXT = 12;

const ANALYSIS_PROMPT = `You are a navigation analyst for a browser automation agent.

IMPORTANT: Always respond in Russian.
You have a knowledge base of previously analyzed pages (URL path → components on the page).
Given a task, identify relevant pages and suggest an optimal navigation path.

Return plain text in this structure:
Relevant pages:
- <url>: <why it's relevant>

Suggested path:
1. <url> — <what to do / look for>
2. ...

Known shortcuts:
- <e.g. "Settings link is in the top navbar on the home page">

If no pages in the knowledge base are relevant, write: NO_RELEVANT_MEMORY`;

function scorePageRelevance(record: RegistryPageRecord, keywords: string[]): number {
  const text = [record.path, record.components].join(' ').toLowerCase();
  return keywords.reduce((score, kw) => score + (text.includes(kw) ? 1 : 0), 0);
}

function extractKeywords(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[\s,./\-_]+/)
    .filter(w => w.length > 2);
}

export class MemoryAnalysisAgent {
  constructor(private readonly client: OpenAI, private readonly modelOverride?: string) {}

  private _selectRelevantPages(allPages: RegistryPageRecord[], userTask: string): RegistryPageRecord[] {
    const keywords = extractKeywords(userTask);

    // Score by relevance, fall back to recency for ties
    const scored = allPages
      .map((p) => ({ p, score: scorePageRelevance(p, keywords) }))
      .sort((a, b) => b.score - a.score || b.p.lastSeen.localeCompare(a.p.lastSeen));

    return scored.slice(0, MAX_PAGES_IN_CONTEXT).map(({ p }) => p);
  }

  private async _requestAnalysis(userTask: string, entries: RegistryPageRecord[]): Promise<string> {
    const knowledgeBase = entries
      .map((p) => `Path: ${p.path}\nComponents: ${p.components || 'none'}`)
      .join('\n\n---\n\n');

    try {
      const response = await this.client.chat.completions.create({
        model: await resolveModel(this.client, this.modelOverride),
        temperature: 0.2,
        messages: [
          { role: 'system', content: ANALYSIS_PROMPT },
          { role: 'user', content: `Task: ${userTask}\n\nKnowledge base:\n\n${knowledgeBase}` },
        ],
      });
      return response.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      console.warn(`[MemoryAnalysis] Failed: ${(err as Error).message}`);
      return '';
    }
  }

  async analyze(userTask: string): Promise<string> {
    const allPages = await getRegistryPages();

    if (allPages.length === 0) {
      console.log('[MemoryAnalysis] No page knowledge yet — skipping.');
      return '';
    }

    const entries = this._selectRelevantPages(allPages, userTask);

    console.log(
      `\n[MemoryAnalysis] Consulting ${entries.length}/${allPages.length} page(s) (filtered by relevance)...`
    );

    const analysis = await this._requestAnalysis(userTask, entries);

    if (!analysis || analysis.includes('NO_RELEVANT_MEMORY')) {
      console.log('[MemoryAnalysis] No relevant pages for this task.');
      return '';
    }

    console.log('\n[MemoryAnalysis] Site knowledge:');
    console.log('─'.repeat(50));
    console.log(analysis);
    console.log('─'.repeat(50));

    return analysis;
  }
}
