import { MongoClient, ObjectId, Db } from 'mongodb';

let _db: Db | null = null;
let _client: MongoClient | null = null;

export function isDBConnected(): boolean {
  return _db !== null;
}

export async function closeDB(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
  }
}

export async function connectDB(): Promise<Db | null> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.warn('[MongoDB] MONGO_URI not set — skipping DB integration');
    return null;
  }
  try {
    _client = new MongoClient(uri);
    await _client.connect();
    _db = _client.db();
    console.log('[MongoDB] Connected:', uri);
    return _db;
  } catch (err) {
    console.warn('[MongoDB] Connection failed:', (err as Error).message);
    return null;
  }
}

function getDB(): Db {
  if (!_db) throw new Error('MongoDB not connected');
  return _db;
}

/** Shallow-copies a Mongo document and strips the given fields (e.g. `_id`, the lookup key). */
function omitFields(doc: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...doc };
  for (const field of fields) {
    delete rest[field];
  }
  return rest;
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export interface RunData {
  task: string;
  model?: string;
  plan?: string;
}

export async function saveRun(data: RunData): Promise<ObjectId | null> {
  try {
    const result = await getDB().collection('runs').insertOne({
      startedAt: new Date(),
      task: data.task,
      status: 'running',
      model: data.model ?? null,
      plan: data.plan ?? null,
      finishedAt: null,
      summary: null,
      errorMessage: null,
      iterationsCount: null,
    });
    return result.insertedId;
  } catch (err) {
    console.warn('[MongoDB] saveRun failed:', (err as Error).message);
    return null;
  }
}

export async function updateRun(runId: ObjectId, update: {
  status: 'completed' | 'failed';
  summary?: string;
  errorMessage?: string;
  iterationsCount?: number;
}): Promise<void> {
  try {
    await getDB().collection('runs').updateOne(
      { _id: runId },
      { $set: { ...update, finishedAt: new Date() } },
    );
  } catch (err) {
    console.warn('[MongoDB] updateRun failed:', (err as Error).message);
  }
}

// ─── Steps ───────────────────────────────────────────────────────────────────

export interface StepData {
  runId: ObjectId;
  stepNumber: number;
  action: string;
  args?: Record<string, unknown>;
  url?: string | null;
  screenshotPath?: string | null;
  result?: string | null;
  notes?: string | null;
  durationMs?: number | null;
  isError?: boolean;
}

export async function saveStep(data: StepData): Promise<void> {
  try {
    await getDB().collection('steps').insertOne({
      ...data,
      timestamp: new Date(),
    });
  } catch (err) {
    console.warn('[MongoDB] saveStep failed:', (err as Error).message);
  }
}

// ─── Run Logs ─────────────────────────────────────────────────────────────────

export interface RunLogEntry {
  runId: ObjectId;
  type: 'response' | 'error';
  agent?: string;
  tool?: string;
  args?: unknown;
  content: string;
}

export async function dbSaveLog(entry: RunLogEntry): Promise<void> {
  try {
    await getDB().collection('run_logs').insertOne({
      ...entry,
      timestamp: new Date(),
    });
  } catch (err) {
    console.warn('[MongoDB] dbSaveLog failed:', (err as Error).message);
  }
}

// ─── Page Visits ─────────────────────────────────────────────────────────────

export async function dbUpsertVisit(url: string, lastVisited: Date, visitCount: number): Promise<void> {
  try {
    await getDB().collection('page_visits').updateOne(
      { url },
      { $set: { url, lastVisited, visitCount } },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[MongoDB] dbUpsertVisit failed:', (err as Error).message);
  }
}

export async function dbGetAllVisits(): Promise<Record<string, { lastVisited: string; visitCount: number }>> {
  try {
    const docs = await getDB().collection('page_visits').find().toArray();
    const result: Record<string, { lastVisited: string; visitCount: number }> = {};
    for (const doc of docs) {
      result[doc.url as string] = {
        lastVisited: (doc.lastVisited as Date).toISOString(),
        visitCount: doc.visitCount as number,
      };
    }
    return result;
  } catch (err) {
    console.warn('[MongoDB] dbGetAllVisits failed:', (err as Error).message);
    return {};
  }
}

export async function dbHasVisit(url: string): Promise<boolean> {
  try {
    const count = await getDB().collection('page_visits').countDocuments({ url });
    return count > 0;
  } catch {
    return false;
  }
}

// ─── Page Knowledge ──────────────────────────────────────────────────────────

export interface PageKnowledgeDoc {
  url: string;
  title?: string;
  purpose?: string;
  navigation?: string;
  forms?: string;
  keyActions?: string;
  sections?: string;
  analyzedAt: string;
}

export async function dbUpsertPageKnowledge(url: string, record: Omit<PageKnowledgeDoc, 'url'>): Promise<void> {
  try {
    await getDB().collection('page_knowledge').updateOne(
      { url },
      { $set: { url, ...record } },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[MongoDB] dbUpsertPageKnowledge failed:', (err as Error).message);
  }
}

export async function dbGetAllPageKnowledge(): Promise<Record<string, Omit<PageKnowledgeDoc, 'url'>>> {
  try {
    const docs = await getDB().collection('page_knowledge').find().toArray();
    const result: Record<string, Omit<PageKnowledgeDoc, 'url'>> = {};
    for (const doc of docs) {
      const url = doc.url as string;
      result[url] = omitFields(doc, ['url', '_id']) as Omit<PageKnowledgeDoc, 'url'>;
    }
    return result;
  } catch (err) {
    console.warn('[MongoDB] dbGetAllPageKnowledge failed:', (err as Error).message);
    return {};
  }
}

// ─── DOM Memory ──────────────────────────────────────────────────────────────

export interface DomPageDoc {
  url: string;
  landmarks?: string;
  headings?: string;
  interactive?: string;
  forms?: string;
  structure?: string;
  analyzedAt: string;
}

export async function dbUpsertDomPage(url: string, record: Omit<DomPageDoc, 'url'>): Promise<void> {
  try {
    await getDB().collection('dom_memory').updateOne(
      { url },
      { $set: { url, ...record } },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[MongoDB] dbUpsertDomPage failed:', (err as Error).message);
  }
}

export async function dbGetAllDomPages(): Promise<Record<string, Omit<DomPageDoc, 'url'>>> {
  try {
    const docs = await getDB().collection('dom_memory').find().toArray();
    const result: Record<string, Omit<DomPageDoc, 'url'>> = {};
    for (const doc of docs) {
      const url = doc.url as string;
      result[url] = omitFields(doc, ['url', '_id']) as Omit<DomPageDoc, 'url'>;
    }
    return result;
  } catch (err) {
    console.warn('[MongoDB] dbGetAllDomPages failed:', (err as Error).message);
    return {};
  }
}

export async function dbGetDomPageByUrl(url: string): Promise<Omit<DomPageDoc, 'url'> | null> {
  try {
    const doc = await getDB().collection('dom_memory').findOne({ url });
    if (!doc) return null;
    return omitFields(doc, ['url', '_id']) as Omit<DomPageDoc, 'url'>;
  } catch {
    return null;
  }
}

// ─── Attention Memory ────────────────────────────────────────────────────────

export interface AttentionEntryDoc {
  id: string;
  kind: 'screenshot' | 'snapshot';
  key: string;
  summary: string;
  rule: string;
  createdAt: string;
}

export async function dbUpsertAttentionEntry(entry: AttentionEntryDoc): Promise<void> {
  try {
    await getDB().collection('attention_memory').updateOne(
      { id: entry.id },
      { $set: entry },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[MongoDB] dbUpsertAttentionEntry failed:', (err as Error).message);
  }
}

export async function dbGetAttentionEntries(kind?: string, limit?: number): Promise<AttentionEntryDoc[]> {
  try {
    const filter = kind ? { kind } : {};
    let cursor = getDB().collection('attention_memory')
      .find(filter)
      .sort({ createdAt: 1 });
    if (limit) cursor = cursor.limit(limit);
    const docs = await cursor.toArray();
    return docs.map((d) => ({
      id: d.id as string,
      kind: d.kind as 'screenshot' | 'snapshot',
      key: d.key as string,
      summary: d.summary as string,
      rule: d.rule as string,
      createdAt: d.createdAt as string,
    }));
  } catch (err) {
    console.warn('[MongoDB] dbGetAttentionEntries failed:', (err as Error).message);
    return [];
  }
}

export async function dbCountAttentionEntries(): Promise<number> {
  try {
    return await getDB().collection('attention_memory').countDocuments();
  } catch {
    return 0;
  }
}

export async function dbPruneAttentionEntries(maxEntries: number): Promise<void> {
  try {
    const count = await getDB().collection('attention_memory').countDocuments();
    if (count <= maxEntries) return;
    const toDelete = count - maxEntries;
    const oldest = await getDB().collection('attention_memory')
      .find()
      .sort({ createdAt: 1 })
      .limit(toDelete)
      .toArray();
    const ids = oldest.map((d) => d._id);
    await getDB().collection('attention_memory').deleteMany({ _id: { $in: ids } });
  } catch (err) {
    console.warn('[MongoDB] dbPruneAttentionEntries failed:', (err as Error).message);
  }
}

// ─── Components ──────────────────────────────────────────────────────────────
// Per-URL, per-block descriptions of page components (navbar, sidebar, etc.)

export interface ComponentDoc {
  url: string;
  blockName: string;
  contentHash: string;
  description: string;
  analyzedAt: string;
}

export async function dbUpsertComponent(doc: ComponentDoc): Promise<void> {
  try {
    await getDB().collection('components').updateOne(
      { url: doc.url, blockName: doc.blockName },
      { $set: doc },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[MongoDB] dbUpsertComponent failed:', (err as Error).message);
  }
}

export async function dbGetComponent(url: string, blockName: string): Promise<ComponentDoc | null> {
  try {
    const doc = await getDB().collection('components').findOne({ url, blockName });
    return doc ? (doc as unknown as ComponentDoc) : null;
  } catch {
    return null;
  }
}

/** Find any existing component with same content hash — enables cross-URL description reuse. */
export async function dbFindComponentByHash(contentHash: string): Promise<ComponentDoc | null> {
  try {
    const doc = await getDB().collection('components').findOne({ contentHash });
    return doc ? (doc as unknown as ComponentDoc) : null;
  } catch {
    return null;
  }
}

export async function dbGetComponentsByUrl(url: string): Promise<ComponentDoc[]> {
  try {
    const docs = await getDB().collection('components').find({ url }).toArray();
    return docs as unknown as ComponentDoc[];
  } catch {
    return [];
  }
}

// ─── Content Summaries ───────────────────────────────────────────────────────
// Compact per-key descriptions of baseline content (snapshot or screenshot).
// Stored so each compare call only sends summaries to the LLM, not full content.

export async function dbUpsertContentSummary(key: string, kind: string, summary: string): Promise<void> {
  try {
    await getDB().collection('content_summaries').updateOne(
      { key, kind },
      { $set: { key, kind, summary, analyzedAt: new Date().toISOString() } },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[MongoDB] dbUpsertContentSummary failed:', (err as Error).message);
  }
}

export async function dbGetContentSummary(key: string, kind: string): Promise<string | null> {
  try {
    const doc = await getDB().collection('content_summaries').findOne({ key, kind });
    return doc ? (doc.summary as string) : null;
  } catch {
    return null;
  }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export async function getRunHistory(limit = 10): Promise<unknown[]> {
  const db = getDB();
  const runs = await db.collection('runs')
    .find()
    .sort({ startedAt: -1 })
    .limit(limit)
    .toArray();

  const runIds = runs.map((r) => r._id);
  const steps = await db.collection('steps')
    .find({ runId: { $in: runIds } })
    .sort({ stepNumber: 1 })
    .toArray();

  return runs.map((run) => ({
    ...run,
    steps: steps.filter((s) => (s.runId as ObjectId).toString() === run._id.toString()),
  }));
}

export async function getRun(runId: ObjectId): Promise<unknown> {
  const db = getDB();
  const run = await db.collection('runs').findOne({ _id: runId });
  if (!run) return null;
  const steps = await db.collection('steps')
    .find({ runId })
    .sort({ stepNumber: 1 })
    .toArray();
  return { ...run, steps };
}
