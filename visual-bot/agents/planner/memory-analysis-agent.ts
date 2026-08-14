import OpenAI from 'openai';
import { getRegistryPages, type RegistryPageRecord } from '../../registry-context.js';
import { resolveModel } from '../../utils.js';

/**
 * Page budget for the knowledge base sent to the model.
 *
 * Deliberately generous: the keyword scorer below matches task words against
 * English paths and component labels, but tasks here are written in Russian, so
 * for a Russian-only task nothing matches and the "relevance filter" degrades to
 * picking by recency — silently, and looking like it filtered. The model is far
 * better at judging relevance than a substring test, so the right move is to send
 * it everything that fits and only fall back to scoring when we genuinely must cut.
 */
const MAX_PAGES_IN_CONTEXT = parseInt(process.env.MEMORY_MAX_PAGES || '60', 10);

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

export type SelectionReason = 'all' | 'scored' | 'recency';

export interface PageSelection {
  pages: RegistryPageRecord[];
  /** How the cut was made — reported so a useless keyword match is visible, not silent. */
  reason: SelectionReason;
}

export const SELECTION_NOTE: Record<SelectionReason, string> = {
  all: 'all known pages',
  scored: 'over budget — cut by keyword relevance',
  recency: 'over budget — no keyword matched the task, cut by recency',
};

/** True when at least one page shares a word with the task. */
function anyKeywordMatches(pages: RegistryPageRecord[], keywords: string[]): boolean {
  return pages.some((p) => scorePageRelevance(p, keywords) > 0);
}

export class MemoryAnalysisAgent {
  constructor(private readonly client: OpenAI, private readonly modelOverride?: string) {}

  /** Picks the pages to send, and says how — see MAX_PAGES_IN_CONTEXT for why. */
  private _selectRelevantPages(allPages: RegistryPageRecord[], userTask: string): PageSelection {
    if (allPages.length <= MAX_PAGES_IN_CONTEXT) {
      return { pages: allPages, reason: 'all' };
    }

    const keywords = extractKeywords(userTask);
    const scored = allPages
      .map((p) => ({ p, score: scorePageRelevance(p, keywords) }))
      .sort((a, b) => b.score - a.score || b.p.lastSeen.localeCompare(a.p.lastSeen));

    return {
      pages: scored.slice(0, MAX_PAGES_IN_CONTEXT).map(({ p }) => p),
      reason: anyKeywordMatches(allPages, keywords) ? 'scored' : 'recency',
    };
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

    const { pages, reason } = this._selectRelevantPages(allPages, userTask);

    console.log(
      `\n[MemoryAnalysis] Consulting ${pages.length}/${allPages.length} page(s) (${SELECTION_NOTE[reason]})...`
    );

    const analysis = await this._requestAnalysis(userTask, pages);

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
