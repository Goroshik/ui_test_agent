import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  isDBConnected,
  dbUpsertDomPage,
  dbGetAllDomPages,
  dbGetDomPageByUrl,
} from './db.js';

const DOM_MEMORY_PATH = resolve(process.cwd(), 'dom-memory.json');

// ── Types ────────────────────────────────────────────────────────────────────

export interface DomPageRecord {
  landmarks?: string;
  headings?: string;
  interactive?: string;
  forms?: string;
  structure?: string;
  analyzedAt: string;
}

interface DomMemory {
  pages: Record<string, DomPageRecord>;
}

// ── File fallback ─────────────────────────────────────────────────────────────

async function loadFile(): Promise<DomMemory> {
  if (!existsSync(DOM_MEMORY_PATH)) return { pages: {} };
  try {
    const raw = await readFile(DOM_MEMORY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { pages: (parsed.pages as DomMemory['pages']) ?? {} };
  } catch {
    return { pages: {} };
  }
}

async function saveFile(memory: DomMemory): Promise<void> {
  await writeFile(DOM_MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

// ── DOM page knowledge ────────────────────────────────────────────────────────

export async function saveDomPage(
  url: string,
  record: Omit<DomPageRecord, 'analyzedAt'>
): Promise<void> {
  // Strip undefined fields — allows partial updates without clobbering existing data
  const defined = Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== undefined)
  ) as Omit<DomPageRecord, 'analyzedAt'>;

  const patch: DomPageRecord = { ...defined, analyzedAt: new Date().toISOString() };

  if (isDBConnected()) {
    // MongoDB $set only writes provided fields — safe for partial updates
    await dbUpsertDomPage(url, patch);
  } else {
    // File path: merge with existing record so partial calls don't lose prior fields
    const memory = await loadFile();
    memory.pages[url] = { ...memory.pages[url], ...patch };
    await saveFile(memory);
  }
}

export async function getDomPages(): Promise<Record<string, DomPageRecord>> {
  if (isDBConnected()) {
    return dbGetAllDomPages() as Promise<Record<string, DomPageRecord>>;
  }
  const memory = await loadFile();
  return memory.pages;
}

// ── Summary for LLM prompts ───────────────────────────────────────────────────

export async function getDomContextSummary(): Promise<string> {
  const pages = await getDomPages();
  const entries = Object.entries(pages);
  if (entries.length === 0) return '';

  const lines = entries.map(([url, p]) => {
    const parts: string[] = [`${url}`];
    if (p.landmarks)   parts.push(`  Landmarks:    ${p.landmarks}`);
    if (p.headings)    parts.push(`  Headings:     ${p.headings}`);
    if (p.interactive) parts.push(`  Interactive:  ${p.interactive}`);
    if (p.forms)       parts.push(`  Forms:        ${p.forms}`);
    if (p.structure)   parts.push(`  Structure:    ${p.structure}`);
    return parts.join('\n');
  });

  return `Known DOM structures:\n${lines.join('\n\n')}`;
}

export async function getDomSummaryForUrl(url: string): Promise<string | null> {
  let p: DomPageRecord | null | undefined;
  if (isDBConnected()) {
    p = await dbGetDomPageByUrl(url) as DomPageRecord | null;
  } else {
    const memory = await loadFile();
    p = memory.pages[url];
  }
  if (!p) return null;

  const parts: string[] = [];
  if (p.landmarks)   parts.push(`Landmarks: ${p.landmarks}`);
  if (p.headings)    parts.push(`Headings: ${p.headings}`);
  if (p.interactive) parts.push(`Interactive: ${p.interactive}`);
  if (p.forms)       parts.push(`Forms: ${p.forms}`);
  if (p.structure)   parts.push(`Structure: ${p.structure}`);
  return parts.join('\n') || null;
}
