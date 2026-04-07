import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  isDBConnected,
  dbUpsertVisit,
  dbGetAllVisits,
  dbHasVisit,
  dbUpsertPageKnowledge,
  dbGetAllPageKnowledge,
} from './db.js';

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

// ── File fallback ─────────────────────────────────────────────────────────────

async function loadFile(): Promise<Memory> {
  if (!existsSync(MEMORY_PATH)) return { visits: {}, pages: {} };
  try {
    const raw = await readFile(MEMORY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.visited && !parsed.visits) return { visits: {}, pages: {} };
    return {
      visits: (parsed.visits as Memory['visits']) ?? {},
      pages:  (parsed.pages  as Memory['pages'])  ?? {},
    };
  } catch {
    return { visits: {}, pages: {} };
  }
}

async function saveFile(memory: Memory): Promise<void> {
  await writeFile(MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

// ── Visit tracking ────────────────────────────────────────────────────────────

export async function recordVisit(url: string): Promise<void> {
  if (isDBConnected()) {
    const all = await dbGetAllVisits();
    const existing = all[url];
    const visitCount = (existing?.visitCount ?? 0) + 1;
    await dbUpsertVisit(url, new Date(), visitCount);
  } else {
    const memory = await loadFile();
    const existing = memory.visits[url];
    memory.visits[url] = {
      lastVisited: new Date().toISOString(),
      visitCount: (existing?.visitCount ?? 0) + 1,
    };
    await saveFile(memory);
  }
}

export async function hasVisited(url: string): Promise<boolean> {
  if (isDBConnected()) return dbHasVisit(url);
  const memory = await loadFile();
  return url in memory.visits;
}

// ── Page knowledge ────────────────────────────────────────────────────────────

export async function savePage(url: string, record: Omit<PageRecord, 'analyzedAt'>): Promise<void> {
  const full: PageRecord = { ...record, analyzedAt: new Date().toISOString() };
  if (isDBConnected()) {
    await dbUpsertPageKnowledge(url, full);
  } else {
    const memory = await loadFile();
    memory.pages[url] = full;
    await saveFile(memory);
  }
}

export async function getPages(): Promise<Record<string, PageRecord>> {
  if (isDBConnected()) {
    return dbGetAllPageKnowledge() as Promise<Record<string, PageRecord>>;
  }
  const memory = await loadFile();
  return memory.pages;
}

// ── Summary for LLM prompts ───────────────────────────────────────────────────

export async function getVisitSummary(limit = 20): Promise<string> {
  const visits = isDBConnected()
    ? await dbGetAllVisits()
    : (await loadFile()).visits;
  const entries = Object.entries(visits)
    .sort((a, b) => b[1].lastVisited.localeCompare(a[1].lastVisited))
    .slice(0, limit);
  if (entries.length === 0) return '';
  return `Previously visited URLs:\n${entries.map(([u]) => `- ${u}`).join('\n')}`;
}

export async function getPageSummary(limit = 15): Promise<string> {
  const pages = await getPages();
  const entries = Object.entries(pages)
    .sort((a, b) => b[1].analyzedAt.localeCompare(a[1].analyzedAt))
    .slice(0, limit);
  if (entries.length === 0) return '';
  const lines = entries.map(([url, p]) =>
    `${url}\n  ${p.title ?? 'Unknown page'} — ${p.purpose ?? ''}`
  );
  return `Known pages:\n${lines.join('\n')}`;
}
