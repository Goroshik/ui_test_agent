import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { ComponentRegistry, ComponentRecord } from './pipeline/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageEntry {
  title: string;
  components: string[];
  lastSeen: string;
}

export interface RegistryPageRecord {
  path: string;
  components: string;  // formatted component labels for LLM context
  lastSeen: string;
}

// ── I/O + Cache ───────────────────────────────────────────────────────────────

const DATA_DIR = resolve(process.cwd(), 'data');

let _registryCache: ComponentRegistry | null = null;
let _pagesCache: Record<string, PageEntry> | null = null;

async function loadRegistry(): Promise<ComponentRegistry> {
  if (_registryCache) return _registryCache;
  const path = resolve(DATA_DIR, 'registry', 'components.json');
  if (!existsSync(path)) return { version: '1.0', lastUpdated: '', components: {} };
  try {
    _registryCache = JSON.parse(await readFile(path, 'utf-8')) as ComponentRegistry;
    return _registryCache;
  } catch {
    return { version: '1.0', lastUpdated: '', components: {} };
  }
}

async function loadPages(): Promise<Record<string, PageEntry>> {
  if (_pagesCache) return _pagesCache;
  const path = resolve(DATA_DIR, 'registry', 'pages.json');
  if (!existsSync(path)) return {};
  try {
    _pagesCache = JSON.parse(await readFile(path, 'utf-8')) as Record<string, PageEntry>;
    return _pagesCache;
  } catch {
    return {};
  }
}

/** Invalidate caches — call after registry is updated on disk. */
export function invalidateRegistryCache(): void {
  _registryCache = null;
  _pagesCache = null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Summary of known pages for LLM system prompt context.
 * Replaces memory.ts getPageSummary().
 */
export async function getPageSummary(limit = 15): Promise<string> {
  const [pages, registry] = await Promise.all([loadPages(), loadRegistry()]);

  const entries = Object.entries(pages)
    .sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen))
    .slice(0, limit);

  if (entries.length === 0) return '';

  const lines = entries.map(([path, page]) => {
    const compLabels = page.components
      .slice(0, 8)
      .map((id) => {
        const c = registry.components[id];
        return c ? `${c.label} (${c.componentType})` : null;
      })
      .filter(Boolean)
      .join(', ');
    return `${path}: ${compLabels || 'no components'}`;
  });

  return `Known pages:\n${lines.join('\n')}`;
}

/**
 * Rich page records for relevance scoring by MemoryAnalysisAgent.
 * Replaces memory.ts getPages().
 */
export async function getRegistryPages(): Promise<RegistryPageRecord[]> {
  const [pages, registry] = await Promise.all([loadPages(), loadRegistry()]);

  return Object.entries(pages)
    .sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen))
    .map(([path, page]) => {
      const comps = page.components
        .map((id) => {
          const c = registry.components[id];
          return c ? `${c.label} (${c.componentType})` : null;
        })
        .filter(Boolean)
        .join(', ');
      return { path, components: comps, lastSeen: page.lastSeen };
    });
}

/**
 * Component context for a specific URL — injected into agent conversation after navigation.
 * Replaces dom-memory.ts getDomSummaryForUrl().
 */
export async function getComponentContextForUrl(url: string): Promise<string | null> {
  const [pages, registry] = await Promise.all([loadPages(), loadRegistry()]);

  let pagePath: string;
  try {
    pagePath = new URL(url).pathname;
  } catch {
    pagePath = url;
  }

  const page = pages[pagePath];
  if (!page || page.components.length === 0) return null;

  const parts = page.components
    .map((id) => {
      const c = registry.components[id];
      if (!c) return null;
      return `- ${c.label} (${c.componentType}): ${c.selectors.preferred}`;
    })
    .filter((p): p is string => p !== null);

  if (parts.length === 0) return null;
  return `Known components on this page:\n${parts.join('\n')}`;
}

// ── Tool handlers (Variant 1) ─────────────────────────────────────────────────

function _formatComponentForTool(c: ComponentRecord): string {
  const actions = c.actions.map((a) => {
    let s = `    - ${a.type}`;
    if (a.value) s += `: "${a.value}"`;
    if (a.navigation) s += ` → navigates to ${a.navigation.to}`;
    return s;
  }).join('\n');

  const pre = c.assertions.pre_interaction.join(', ');
  const post = c.assertions.post_interaction.join(', ');

  return [
    `[${c.id}]`,
    `  label: ${c.label}`,
    `  type: ${c.componentType}`,
    `  selector: ${c.selectors.preferred}`,
    c.selectors.testid ? `  testid: ${c.selectors.testid}` : null,
    actions ? `  actions:\n${actions}` : null,
    pre  ? `  assert before: ${pre}`  : null,
    post ? `  assert after:  ${post}` : null,
    `  confidence: ${c.confidence} (seen ${c.seenCount}x)`,
    c.notes ? `  notes: ${c.notes}` : null,
  ].filter(Boolean).join('\n');
}

/**
 * Tool handler: returns full component details for a page path.
 * Used by registry_get_page_components tool.
 */
export async function toolGetPageComponents(pagePath: string): Promise<string> {
  // Normalize: strip query string / hash, ensure leading slash
  let path = pagePath.trim();
  try { path = new URL(path).pathname; } catch { /* already a path */ }
  if (!path.startsWith('/')) path = '/' + path;

  const pages = await loadPages();
  const page = pages[path];
  if (!page) {
    // Fuzzy fallback: find pages whose path contains the query
    const matches = Object.keys(pages).filter((p) => p.includes(path));
    if (matches.length === 0) return `No page found for "${path}". Known pages: ${Object.keys(pages).join(', ')}`;
    // Return summary of matches instead
    return `Exact page "${path}" not found. Did you mean:\n${matches.map((m) => `  ${m} (${pages[m].components.length} components)`).join('\n')}`;
  }

  if (page.components.length === 0) return `Page "${path}" has no registered components.`;

  const registry = await loadRegistry();
  const formatted = page.components
    .map((id) => {
      const c = registry.components[id];
      return c ? _formatComponentForTool(c) : `[${id}] (not found in registry)`;
    })
    .join('\n\n');

  return `Components on ${path} (${page.components.length} total):\n\n${formatted}`;
}

/**
 * Tool handler: search components by label or id keyword.
 * Used by registry_search_components tool.
 */
export async function toolSearchComponents(query: string): Promise<string> {
  const q = query.toLowerCase().trim();
  if (!q) return 'Provide a non-empty search query.';

  const [pages, registry] = await Promise.all([loadPages(), loadRegistry()]);

  const matched = Object.values(registry.components).filter(
    (c) => c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q),
  );

  if (matched.length === 0) {
    // Also search page paths
    const pageMatches = Object.keys(pages).filter((p) => p.includes(q));
    if (pageMatches.length > 0) {
      return `No components matched "${query}", but found pages:\n${pageMatches.map((p) => `  ${p} (${pages[p].components.length} components)`).join('\n')}\nTry registry_get_page_components with one of these paths.`;
    }
    return `No components or pages found matching "${query}".`;
  }

  const limited = matched.slice(0, 20);
  const formatted = limited.map(_formatComponentForTool).join('\n\n');
  const suffix = matched.length > 20 ? `\n\n(${matched.length - 20} more results — refine your query)` : '';
  return `Found ${matched.length} component(s) matching "${query}":\n\n${formatted}${suffix}`;
}
