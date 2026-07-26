import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { normalizePagePath } from './url-path.js';

const MEMORY_PATH = resolve(process.cwd(), 'data', 'memory.json');

/** Concrete URLs kept per page so the planner still has something navigable. */
const MAX_EXAMPLES = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VisitRecord {
  lastVisited: string;
  visitCount: number;
  /** Real URLs seen for this normalised page, newest first. */
  examples?: string[];
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

/** Newest-first list of concrete URLs for a page, capped and deduped. */
function mergeExamples(existing: string[] | undefined, url: string): string[] {
  return [...new Set([url, ...(existing ?? [])])].slice(0, MAX_EXAMPLES);
}

/**
 * Records a visit under the normalised page path, not the raw URL. Keying by raw
 * URL made every sort order and every record id its own "page", so the summary
 * below filled up with near-duplicates and squeezed out real knowledge.
 */
export async function recordVisit(url: string): Promise<void> {
  const memory = await load();
  const key = normalizePagePath(url);
  const existing = memory.visits[key];
  memory.visits[key] = {
    lastVisited: new Date().toISOString(),
    visitCount: (existing?.visitCount ?? 0) + 1,
    examples: mergeExamples(existing?.examples, url),
  };
  await save(memory);
}

export async function hasVisited(url: string): Promise<boolean> {
  const memory = await load();
  return normalizePagePath(url) in memory.visits;
}

// ── Summary for LLM prompts ───────────────────────────────────────────────────

function formatVisit(path: string, record: VisitRecord): string {
  const example = record.examples?.[0];
  const suffix = example && example !== path ? ` (e.g. ${example})` : '';
  return `- ${path} — visited ${record.visitCount}x${suffix}`;
}

export async function getVisitSummary(limit = 20): Promise<string> {
  const { visits } = await load();
  const entries = Object.entries(visits)
    .sort((a, b) => b[1].lastVisited.localeCompare(a[1].lastVisited))
    .slice(0, limit);
  if (entries.length === 0) return '';
  const lines = entries.map(([path, record]) => formatVisit(path, record));
  return `Previously visited pages:\n${lines.join('\n')}`;
}
