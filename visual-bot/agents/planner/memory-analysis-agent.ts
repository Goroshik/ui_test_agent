import OpenAI from 'openai';
import { getPages, PageRecord } from '../../memory.js';
import { resolveModel } from '../../utils.js';

const MAX_PAGES_IN_CONTEXT = 12;

const ANALYSIS_PROMPT = `You are a navigation analyst for a browser automation agent.

IMPORTANT: Always respond in Russian.
You have a knowledge base of previously analyzed pages (URL → what's on the page).
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

function scorePageRelevance(url: string, page: PageRecord, keywords: string[]): number {
  const text = [url, page.title, page.purpose, page.navigation, page.forms, page.keyActions, page.sections]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return keywords.reduce((score, kw) => score + (text.includes(kw) ? 1 : 0), 0);
}

function extractKeywords(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[\s,./\-_]+/)
    .filter(w => w.length > 2);
}

export class MemoryAnalysisAgent {
  constructor(private readonly client: OpenAI) {}

  async analyze(userTask: string): Promise<string> {
    const pages = await getPages();
    const allEntries = Object.entries(pages);

    if (allEntries.length === 0) {
      console.log('[MemoryAnalysis] No page knowledge yet — skipping.');
      return '';
    }

    const keywords = extractKeywords(userTask);

    // Score and sort by relevance, fall back to recency for ties
    const scored = allEntries
      .map(([url, p]) => ({ url, p, score: scorePageRelevance(url, p, keywords) }))
      .sort((a, b) => b.score - a.score || b.p.analyzedAt.localeCompare(a.p.analyzedAt));

    const entries = scored.slice(0, MAX_PAGES_IN_CONTEXT).map(({ url, p }) => [url, p] as [string, PageRecord]);

    console.log(
      `\n[MemoryAnalysis] Consulting ${entries.length}/${allEntries.length} page(s) (filtered by relevance)...`
    );

    const knowledgeBase = entries
      .map(([url, p]) => [
        `URL: ${url}`,
        p.title      ? `Title: ${p.title}`           : '',
        p.purpose    ? `Purpose: ${p.purpose}`        : '',
        p.navigation ? `Navigation: ${p.navigation}`  : '',
        p.forms      ? `Forms: ${p.forms}`            : '',
        p.keyActions ? `Key actions: ${p.keyActions}` : '',
        p.sections   ? `Sections: ${p.sections}`      : '',
      ].filter(Boolean).join('\n'))
      .join('\n\n---\n\n');

    let analysis: string;
    try {
      const response = await this.client.chat.completions.create({
        model: await resolveModel(this.client),
        temperature: 0.2,
        messages: [
          { role: 'system', content: ANALYSIS_PROMPT },
          { role: 'user', content: `Task: ${userTask}\n\nKnowledge base:\n\n${knowledgeBase}` },
        ],
      });
      analysis = response.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      console.warn(`[MemoryAnalysis] Failed: ${(err as Error).message}`);
      return '';
    }

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
