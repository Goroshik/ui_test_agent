import { describe, it, expect } from 'vitest';
import { TOOL_CATALOG, REGISTRY_TOOLS, toolSchema, formatToolCatalogForPlanner } from './tool-catalog.js';

const NAMES = Object.keys(TOOL_CATALOG);

describe('TOOL_CATALOG — integrity', () => {
  it('is not empty', () => {
    expect(NAMES.length).toBeGreaterThan(0);
  });

  it.each(NAMES)('gives "%s" a signature, a description and a schema', (name) => {
    const doc = TOOL_CATALOG[name];

    expect(doc?.signature).toMatch(/^[a-z_]+\(/);
    expect(doc?.description.length).toBeGreaterThan(0);
    expect(doc?.schema).toMatchObject({ type: 'object' });
  });

  it('starts every signature with the tool name — the prompt must not misname a tool', () => {
    for (const name of NAMES) {
      expect(TOOL_CATALOG[name]?.signature.startsWith(`${name}(`)).toBe(true);
    }
  });

  it('keeps descriptions to one line', () => {
    for (const name of NAMES) {
      expect(TOOL_CATALOG[name]?.description).not.toContain('\n');
    }
  });
});

describe('REGISTRY_TOOLS', () => {
  it('only names tools the catalogue knows', () => {
    for (const name of REGISTRY_TOOLS) {
      expect(NAMES).toContain(name);
    }
  });

  it('covers both registry lookups', () => {
    expect([...REGISTRY_TOOLS].sort()).toEqual([
      'registry_get_page_components',
      'registry_search_components',
    ]);
  });
});

describe('toolSchema', () => {
  it('returns the catalogued schema', () => {
    expect(toolSchema('browser_navigate')).toMatchObject({ required: ['url'] });
  });

  it('falls back to a permissive schema for a tool MCP added that we do not document', () => {
    expect(toolSchema('browser_something_new')).toEqual({ type: 'object', properties: {} });
  });

  it('does not hand back a schema that would reject every call', () => {
    expect(toolSchema('unknown')).not.toHaveProperty('required');
  });
});

describe('formatToolCatalogForPlanner', () => {
  const rendered = formatToolCatalogForPlanner();

  it('tells the planner about the registry lookups — the gap this catalogue exists to close', () => {
    expect(rendered).toContain('registry_get_page_components');
    expect(rendered).toContain('registry_search_components');
  });

  it('includes the snapshot tool the whole workflow depends on', () => {
    expect(rendered).toContain('browser_snapshot()');
  });

  it('lists every planning-relevant tool and nothing else', () => {
    const expected = NAMES.filter((n) => TOOL_CATALOG[n]?.planningRelevant);
    const listed = rendered.split('\n').map((line) => line.replace(/^- /, '').split('(')[0]);

    expect(listed.sort()).toEqual(expected.sort());
  });

  it('leaves tab and window plumbing out of the plan', () => {
    expect(rendered).not.toContain('browser_tab_new');
    expect(rendered).not.toContain('browser_resize');
  });

  it('renders one bullet per tool with its description', () => {
    for (const line of rendered.split('\n')) {
      expect(line).toMatch(/^- [a-z_]+\([^)]*\) — .+$/);
    }
  });
});
