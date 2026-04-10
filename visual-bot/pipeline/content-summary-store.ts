import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

/**
 * File-based cache for content summaries (screenshot/snapshot descriptions).
 * Replaces the MongoDB content_summaries collection.
 * Stored at data/content-summaries.json as { "<key>__<kind>": "summary text" }.
 */

const STORE_PATH = resolve(process.cwd(), 'data', 'content-summaries.json');

async function load(): Promise<Record<string, string>> {
  if (!existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(await readFile(STORE_PATH, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function save(data: Record<string, string>): Promise<void> {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export async function getContentSummary(key: string, kind: string): Promise<string | null> {
  const data = await load();
  return data[`${key}__${kind}`] ?? null;
}

export async function upsertContentSummary(key: string, kind: string, summary: string): Promise<void> {
  const data = await load();
  data[`${key}__${kind}`] = summary;
  await save(data);
}
