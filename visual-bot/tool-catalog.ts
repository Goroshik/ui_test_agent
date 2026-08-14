import type OpenAI from 'openai';

/**
 * Single source of truth for the tools the agent can call: names, JSON schemas
 * for the function-calling API, and the one-line descriptions the planner sees.
 *
 * These three used to live apart — schemas in agent.ts, prose in the planner's
 * system prompt — and had already drifted: the planner was never told the
 * registry lookup tools exist, so it could not plan a lookup and the knowledge
 * accumulated across runs never reached a plan. Keeping them in one record makes
 * that class of drift a test failure instead of a silent capability gap.
 */

export interface ToolDoc {
  /** Call signature shown to the planner, e.g. `browser_click(element, ref)`. */
  signature: string;
  /** One line, imperative, what the tool does. */
  description: string;
  /** JSON schema for the function-calling API. */
  schema: OpenAI.FunctionParameters;
  /** Tools the planner should not be told about — noise for planning. */
  planningRelevant: boolean;
}

const OBJECT_NO_PARAMS: OpenAI.FunctionParameters = { type: 'object', properties: {} };

function doc(signature: string, description: string, schema: OpenAI.FunctionParameters, planningRelevant = true): ToolDoc {
  return { signature, description, schema, planningRelevant };
}

export const TOOL_CATALOG: Record<string, ToolDoc> = {
  // ── Navigation ──
  browser_navigate: doc(
    'browser_navigate(url)',
    'navigate to a URL',
    { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  ),
  browser_navigate_back: doc('browser_navigate_back()', 'go back in history', OBJECT_NO_PARAMS),
  browser_navigate_forward: doc('browser_navigate_forward()', 'go forward in history', OBJECT_NO_PARAMS),

  // ── Reading the page ──
  browser_snapshot: doc(
    'browser_snapshot()',
    'get the accessibility tree — ALWAYS call this before any interaction, refs come from here',
    OBJECT_NO_PARAMS,
  ),
  browser_take_screenshot: doc(
    'browser_take_screenshot()',
    'capture a screenshot (saved as an artifact; the agent reads the snapshot, not the image)',
    { type: 'object', properties: { raw: { type: 'boolean' } } },
  ),
  browser_network_requests: doc('browser_network_requests()', 'list network requests made so far', OBJECT_NO_PARAMS),
  browser_console_messages: doc('browser_console_messages()', 'read console output', OBJECT_NO_PARAMS),

  // ── Interaction ──
  browser_click: doc(
    'browser_click(element, ref)',
    'click an element by its ref from the latest snapshot',
    { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' } }, required: ['element', 'ref'] },
  ),
  browser_type: doc(
    'browser_type(element, ref, text, submit?, slowly?)',
    'type text into an input; submit presses Enter, slowly types key by key',
    {
      type: 'object',
      properties: {
        element: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' },
        submit: { type: 'boolean' }, slowly: { type: 'boolean' },
      },
      required: ['element', 'ref', 'text'],
    },
  ),
  browser_select_option: doc(
    'browser_select_option(element, ref, values)',
    'pick one or more dropdown options',
    {
      type: 'object',
      properties: {
        element: { type: 'string' }, ref: { type: 'string' },
        values: { type: 'array', items: { type: 'string' } },
      },
      required: ['element', 'ref', 'values'],
    },
  ),
  browser_press_key: doc(
    'browser_press_key(key)',
    'press a key, e.g. Enter, Tab, Escape, ArrowDown',
    { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  ),
  browser_hover: doc(
    'browser_hover(element, ref)',
    'hover over an element to reveal menus or tooltips',
    { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' } }, required: ['element', 'ref'] },
  ),
  browser_wait_for: doc(
    'browser_wait_for(text?, textGone?, time?)',
    'wait for text to appear, text to disappear, or N seconds',
    { type: 'object', properties: { time: { type: 'number' }, text: { type: 'string' }, textGone: { type: 'string' } } },
  ),
  browser_handle_dialog: doc(
    'browser_handle_dialog(accept, promptText?)',
    'accept or dismiss a native dialog',
    { type: 'object', properties: { accept: { type: 'boolean' }, promptText: { type: 'string' } }, required: ['accept'] },
  ),
  browser_file_upload: doc(
    'browser_file_upload(paths)',
    'attach files to a file input',
    { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
  ),

  // ── Site knowledge accumulated by previous runs ──
  registry_get_page_components: doc(
    'registry_get_page_components(page)',
    'list every known component on a page with selectors, actions and assertions — use it instead of rediscovering a page',
    {
      type: 'object',
      properties: { page: { type: 'string', description: 'Page path to look up, e.g. /v1/login or /member-hr/home' } },
      required: ['page'],
    },
  ),
  registry_search_components: doc(
    'registry_search_components(query)',
    'search components by label or id across all known pages — use it to locate a control without knowing its page',
    {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keyword to search in component labels and IDs' } },
      required: ['query'],
    },
  ),

  // ── Tabs and window: available, but noise in a plan ──
  browser_tab_list: doc('browser_tab_list()', 'list open tabs', OBJECT_NO_PARAMS, false),
  browser_tab_new: doc('browser_tab_new(url?)', 'open a new tab', { type: 'object', properties: { url: { type: 'string' } } }, false),
  browser_tab_select: doc(
    'browser_tab_select(index)', 'switch to a tab',
    { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] }, false,
  ),
  browser_tab_close: doc('browser_tab_close(index?)', 'close a tab', { type: 'object', properties: { index: { type: 'number' } } }, false),
  browser_close: doc('browser_close()', 'close the browser', OBJECT_NO_PARAMS, false),
  browser_resize: doc(
    'browser_resize(width, height)', 'resize the viewport',
    { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] }, false,
  ),
  browser_generate_playwright_test: doc(
    'browser_generate_playwright_test(name, description, steps)',
    'ask Playwright MCP to emit a test — unused, this project generates Cypress',
    {
      type: 'object',
      properties: {
        name: { type: 'string' }, description: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'description', 'steps'],
    },
    false,
  ),
};

/** Tools handled in-process rather than forwarded to Playwright MCP. */
export const REGISTRY_TOOLS = new Set(['registry_get_page_components', 'registry_search_components']);

/** JSON schema for a tool name, or a permissive default for anything MCP adds. */
export function toolSchema(name: string): OpenAI.FunctionParameters {
  return TOOL_CATALOG[name]?.schema ?? OBJECT_NO_PARAMS;
}

/** The tool list for the planner's system prompt — generated, never hand-maintained. */
export function formatToolCatalogForPlanner(): string {
  return Object.values(TOOL_CATALOG)
    .filter((t) => t.planningRelevant)
    .map((t) => `- ${t.signature} — ${t.description}`)
    .join('\n');
}
