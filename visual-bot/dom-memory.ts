import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

const DOM_MEMORY_PATH = resolve(process.cwd(), 'dom-memory.json');

// ── Types ────────────────────────────────────────────────────────────────────

export interface DomPageRecord {
  landmarks?: string;    // nav, main, header, footer, aside landmarks present
  headings?: string;     // heading hierarchy (h1 → h2 → h3)
  interactive?: string;  // buttons, links, inputs — comma-separated
  forms?: string;        // form fields, grouped by form
  structure?: string;    // brief tree overview (3–5 lines)
  analyzedAt: string;
}

interface DomMemory {
  pages: Record<string, DomPageRecord>;
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function load(): Promise<DomMemory> {
  if (!existsSync(DOM_MEMORY_PATH)) {
    return { pages: {} };
  }
  try {
    const raw = await readFile(DOM_MEMORY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { pages: (parsed.pages as DomMemory['pages']) ?? {} };
  } catch {
    return { pages: {} };
  }
}

async function save(memory: DomMemory): Promise<void> {
  await writeFile(DOM_MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

// ── DOM page knowledge (updated by DomMemoryAgent) ───────────────────────────

export async function saveDomPage(
  url: string,
  record: Omit<DomPageRecord, 'analyzedAt'>
): Promise<void> {
  const memory = await load();
  memory.pages[url] = { ...record, analyzedAt: new Date().toISOString() };
  await save(memory);
}

export async function getDomPages(): Promise<Record<string, DomPageRecord>> {
  const memory = await load();
  return memory.pages;
}

// ── Summary for LLM prompts ───────────────────────────────────────────────────

export async function getDomContextSummary(): Promise<string> {
  const memory = await load();
  const entries = Object.entries(memory.pages);
  if (entries.length === 0) return '';

  const lines = entries.map(([url, p]) => {
    const parts: string[] = [`${url}`];
    if (p.landmarks)    parts.push(`  Landmarks:    ${p.landmarks}`);
    if (p.headings)     parts.push(`  Headings:     ${p.headings}`);
    if (p.interactive)  parts.push(`  Interactive:  ${p.interactive}`);
    if (p.forms)        parts.push(`  Forms:        ${p.forms}`);
    if (p.structure)    parts.push(`  Structure:    ${p.structure}`);
    return parts.join('\n');
  });

  return `Known DOM structures:\n${lines.join('\n\n')}`;
}

export async function getDomSummaryForUrl(url: string): Promise<string | null> {
  const memory = await load();
  const p = memory.pages[url];
  if (!p) return null;

  const parts: string[] = [];
  if (p.landmarks)   parts.push(`Landmarks: ${p.landmarks}`);
  if (p.headings)    parts.push(`Headings: ${p.headings}`);
  if (p.interactive) parts.push(`Interactive: ${p.interactive}`);
  if (p.forms)       parts.push(`Forms: ${p.forms}`);
  if (p.structure)   parts.push(`Structure: ${p.structure}`);
  return parts.join('\n') || null;
}
