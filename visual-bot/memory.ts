import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

const MEMORY_PATH = resolve(process.cwd(), 'memory.json');

// ── Types ────────────────────────────────────────────────────────────────────

export interface VisitRecord {
  lastVisited: string;
  visitCount: number;
}

export interface PageRecord {
  title?: string;
  purpose?: string;
  navigation?: string;
  forms?: string;
  keyActions?: string;
  sections?: string;
  analyzedAt: string;
}

interface Memory {
  visits: Record<string, VisitRecord>;
  pages:  Record<string, PageRecord>;
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function load(): Promise<Memory> {
  if (!existsSync(MEMORY_PATH)) {
    return { visits: {}, pages: {} };
  }
  try {
    const raw = await readFile(MEMORY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Migrate old format { visited: {...} } → new format
    if (parsed.visited && !parsed.visits) {
      return { visits: {}, pages: {} };
    }

    return {
      visits: (parsed.visits as Memory['visits']) ?? {},
      pages:  (parsed.pages  as Memory['pages'])  ?? {},
    };
  } catch {
    return { visits: {}, pages: {} };
  }
}

async function save(memory: Memory): Promise<void> {
  await writeFile(MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

// ── Visit tracking (updated by the main agent) ────────────────────────────────

export async function recordVisit(url: string): Promise<void> {
  const memory = await load();
  const existing = memory.visits[url];
  memory.visits[url] = {
    lastVisited: new Date().toISOString(),
    visitCount: (existing?.visitCount ?? 0) + 1,
  };
  await save(memory);
}

export async function hasVisited(url: string): Promise<boolean> {
  const memory = await load();
  return url in memory.visits;
}

// ── Page knowledge (updated by PageMemoryAgent) ───────────────────────────────

export async function savePage(url: string, record: Omit<PageRecord, 'analyzedAt'>): Promise<void> {
  const memory = await load();
  memory.pages[url] = { ...record, analyzedAt: new Date().toISOString() };
  await save(memory);
}

export async function getPages(): Promise<Record<string, PageRecord>> {
  const memory = await load();
  return memory.pages;
}

// ── Summary for LLM prompts ───────────────────────────────────────────────────

export async function getVisitSummary(): Promise<string> {
  const memory = await load();
  const urls = Object.keys(memory.visits);
  if (urls.length === 0) return '';
  return `Previously visited URLs:\n${urls.map((u) => `- ${u}`).join('\n')}`;
}

export async function getPageSummary(): Promise<string> {
  const memory = await load();
  const entries = Object.entries(memory.pages);
  if (entries.length === 0) return '';
  const lines = entries.map(([url, p]) =>
    `${url}\n  ${p.title ?? 'Unknown page'} — ${p.purpose ?? ''}`
  );
  return `Known pages:\n${lines.join('\n')}`;
}
