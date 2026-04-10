import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

const MEMORY_PATH = resolve(process.cwd(), 'data', 'memory.json');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VisitRecord {
  lastVisited: string;
  visitCount: number;
}

interface Memory {
  visits: Record<string, VisitRecord>;
}

// ── I/O ───────────────────────────────────────────────────────────────────────

async function load(): Promise<Memory> {
  if (!existsSync(MEMORY_PATH)) return { visits: {} };
  try {
    const parsed = JSON.parse(await readFile(MEMORY_PATH, 'utf-8')) as Record<string, unknown>;
    return { visits: (parsed.visits as Memory['visits']) ?? {} };
  } catch {
    return { visits: {} };
  }
}

async function save(memory: Memory): Promise<void> {
  const dir = dirname(MEMORY_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

// ── Visit tracking ────────────────────────────────────────────────────────────

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

// ── Summary for LLM prompts ───────────────────────────────────────────────────

export async function getVisitSummary(limit = 20): Promise<string> {
  const { visits } = await load();
  const entries = Object.entries(visits)
    .sort((a, b) => b[1].lastVisited.localeCompare(a[1].lastVisited))
    .slice(0, limit);
  if (entries.length === 0) return '';
  return `Previously visited URLs:\n${entries.map(([u]) => `- ${u}`).join('\n')}`;
}
