import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

/**
 * File-based storage for block-level DOM component descriptions.
 * Replaces the MongoDB `components` collection used by ComponentOrchestrator.
 * Stored at data/dom-components.json.
 *
 * Structure:
 * {
 *   "<url>": {
 *     "<blockName>": { blockName, contentHash, description, analyzedAt }
 *   }
 * }
 */

export interface DomComponentDoc {
  url: string;
  blockName: string;
  contentHash: string;
  description: string;
  analyzedAt: string;
}

type Store = Record<string, Record<string, Omit<DomComponentDoc, 'url'>>>;

const STORE_PATH = resolve(process.cwd(), 'data', 'dom-components.json');

async function load(): Promise<Store> {
  if (!existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(await readFile(STORE_PATH, 'utf-8')) as Store;
  } catch {
    return {};
  }
}

async function save(data: Store): Promise<void> {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export async function upsertComponent(doc: DomComponentDoc): Promise<void> {
  const data = await load();
  const urlBlocks = data[doc.url] ?? {};
  data[doc.url] = urlBlocks;
  urlBlocks[doc.blockName] = {
    blockName: doc.blockName,
    contentHash: doc.contentHash,
    description: doc.description,
    analyzedAt: doc.analyzedAt,
  };
  await save(data);
}

export async function getComponent(url: string, blockName: string): Promise<DomComponentDoc | null> {
  const data = await load();
  const block = data[url]?.[blockName];
  if (!block) return null;
  return { url, ...block };
}

/** Find any block with matching contentHash across all URLs. */
export async function findComponentByHash(contentHash: string): Promise<DomComponentDoc | null> {
  const data = await load();
  for (const [url, blocks] of Object.entries(data)) {
    for (const block of Object.values(blocks)) {
      if (block.contentHash === contentHash) return { url, ...block };
    }
  }
  return null;
}

export async function getComponentsByUrl(url: string): Promise<DomComponentDoc[]> {
  const data = await load();
  const blocks = data[url];
  if (!blocks) return [];
  return Object.values(blocks).map((b) => ({ url, ...b }));
}
