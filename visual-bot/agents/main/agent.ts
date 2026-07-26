import OpenAI from 'openai';
import { ObjectId } from 'mongodb';
import { resolve } from 'path';
import { MCPClient } from '../../mcp-client.js';
import { Screenshotter } from '../../screenshotter.js';
import { resolveModel } from '../../utils.js';
import { createProvider } from '../../llm-provider.js';
import { recordVisit, getVisitSummary } from '../../memory.js';
import { getPageSummary, getComponentContextForUrl, toolGetPageComponents, toolSearchComponents } from '../../registry-context.js';
import { RunLogger } from '../../run-logger.js';
import { checkForLoop } from '../../loop-detector.js';
import { saveStep } from '../../db.js';
import { SessionCollector } from '../../pipeline/session-collector.js';
import type { ActionData, ActionElement, ActionType } from '../../pipeline/types.js';

// Playwright MCP doesn't expose inputSchema via protocol — define them manually
const TOOL_SCHEMAS: Record<string, OpenAI.FunctionParameters> = {
  browser_navigate:      { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  browser_snapshot:      { type: 'object', properties: {} },
  browser_click:         { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' } }, required: ['element', 'ref'] },
  browser_type:          { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, slowly: { type: 'boolean' } }, required: ['element', 'ref', 'text'] },
  browser_select_option: { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } }, required: ['element', 'ref', 'values'] },
  browser_press_key:     { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  browser_hover:         { type: 'object', properties: { element: { type: 'string' }, ref: { type: 'string' } }, required: ['element', 'ref'] },
  browser_wait_for:      { type: 'object', properties: { time: { type: 'number' }, text: { type: 'string' }, textGone: { type: 'string' } } },
  browser_take_screenshot: { type: 'object', properties: { raw: { type: 'boolean' } } },
  browser_navigate_back:    { type: 'object', properties: {} },
  browser_navigate_forward: { type: 'object', properties: {} },
  browser_tab_list:      { type: 'object', properties: {} },
  browser_tab_new:       { type: 'object', properties: { url: { type: 'string' } } },
  browser_tab_select:    { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] },
  browser_tab_close:     { type: 'object', properties: { index: { type: 'number' } } },
  browser_close:         { type: 'object', properties: {} },
  browser_resize:        { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] },
  browser_handle_dialog: { type: 'object', properties: { accept: { type: 'boolean' }, promptText: { type: 'string' } }, required: ['accept'] },
  browser_file_upload:   { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
  browser_network_requests:  { type: 'object', properties: {} },
  browser_console_messages:  { type: 'object', properties: {} },
  browser_generate_playwright_test: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['name', 'description', 'steps'] },
  // ── Registry tools (handled locally, not via MCP) ──
  registry_get_page_components: {
    type: 'object',
    properties: {
      page: { type: 'string', description: 'Page path to look up, e.g. /v1/login or /member-hr/home' },
    },
    required: ['page'],
  },
  registry_search_components: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword to search in component labels and IDs' },
    },
    required: ['query'],
  },
};

const REGISTRY_TOOLS = new Set(['registry_get_page_components', 'registry_search_components']);

const SYSTEM_PROMPT = `You are a browser automation agent. Complete the user's task step by step using the available browser tools.

IMPORTANT: Always respond in Russian. All your messages, summaries, and explanations must be in Russian.

Перед каждым вызовом инструмента пиши 1–2 коротких предложения: что ты сейчас видишь на странице и что собираешься сделать. Это нужно для анализа логов — будь краток и конкретен.

## How to interact with page elements

Elements are identified via accessibility snapshots. The workflow is always:
1. Call browser_snapshot to get the current page structure
2. Find the element you need in the snapshot — it will have a ref like "e12", "e47", etc.
3. Pass that ref + a short human-readable description to the interaction tool

### Clicking a button or link
browser_click({ element: "Submit button", ref: "e12" })

### Typing into an input field
browser_type({ element: "Email input", ref: "e7", text: "user@example.com" })
- Add submit: true to press Enter after typing
- Add slowly: true if the page needs key-by-key input (e.g. autocomplete)

### Selecting a dropdown option
browser_select_option({ element: "Country dropdown", ref: "e19", values: ["US"] })

### Pressing a keyboard key
browser_press_key({ key: "Enter" })   // or "Tab", "Escape", "ArrowDown", etc.

### Waiting for page changes
browser_wait_for({ text: "Success" })        // wait for text to appear
browser_wait_for({ textGone: "Loading..." }) // wait for text to disappear
browser_wait_for({ time: 2 })                // wait N seconds

## Registry lookup tools

Use these tools to find stored component metadata (selectors, actions, assertions) without reading large files:

- **registry_get_page_components({ page: "/v1/login" })** — returns all known components for a page with selectors, expected actions, and assertions
- **registry_search_components({ query: "email" })** — search components by label or ID keyword across all pages

Use these when you need to write a test or verify a selector for a specific page.

## General rules
- ALWAYS call browser_snapshot before any click/type/select — refs change after navigation
- Never guess a ref — only use refs that appear in the latest snapshot
- After each action call browser_snapshot again to verify the result before proceeding
- When the task is fully complete, stop calling tools and write a concise summary
- If an action fails, take a new snapshot and try again with the correct ref`;

// Tools that can reveal hidden UI without changing the URL
const INTERACTION_TOOLS = new Set([
  'browser_click',
  'browser_hover',
  'browser_press_key',
  'browser_select_option',
]);

// Tools that represent a meaningful user action and should be recorded as steps
const ACTION_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_navigate',
  'browser_select_option',
  'browser_hover',
]);

const ACTION_TYPE_MAP: Record<string, ActionType> = {
  browser_click: 'click',
  browser_type: 'fill',
  browser_navigate: 'navigate',
  browser_select_option: 'select',
  browser_hover: 'hover',
  browser_press_key: 'press_key',
};

function extractStringArg(toolArgs: Record<string, unknown>, key: string): string | undefined {
  const value = toolArgs[key];
  return typeof value === 'string' ? value : undefined;
}

function extractValuesArg(toolArgs: Record<string, unknown>): string | undefined {
  const values = toolArgs.values;
  return Array.isArray(values) ? (values as string[]).join(', ') : undefined;
}

function buildActionElement(
  elementName: string | undefined,
  ref: string | undefined,
): ActionElement | undefined {
  if (!elementName && !ref) return undefined;
  return { ariaName: elementName ?? null, ref: ref ?? null };
}

function buildActionDescription(
  type: ActionType,
  elementName: string | undefined,
  url: string | undefined,
): string {
  if (elementName) return `${type} on "${elementName}"`;
  if (url) return `navigate to ${url}`;
  return `${type}`;
}

function buildActionData(toolName: string, toolArgs: Record<string, unknown>): ActionData {
  const type: ActionType = ACTION_TYPE_MAP[toolName] ?? 'other';
  const elementName = extractStringArg(toolArgs, 'element');
  const ref = extractStringArg(toolArgs, 'ref');
  const text = extractStringArg(toolArgs, 'text');
  const url = extractStringArg(toolArgs, 'url');
  const values = extractValuesArg(toolArgs);

  const element = buildActionElement(elementName, ref);
  const value = text ?? url ?? values;

  return {
    type,
    description: buildActionDescription(type, elementName, url),
    ...(element ? { element } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

// ─── Types used internally by the run loop ─────────────────────────────────────

interface RunFlags {
  screenshotsEnabled: boolean;
  snapshotsEnabled: boolean;
}

interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface CaptureContext {
  toolName: string;
  toolArgs: Record<string, unknown>;
  snapshotText: string;
  isInteraction: boolean;
  screenshotsEnabled: boolean;
  snapshotsEnabled: boolean;
}

interface McpExecResult {
  result: unknown;
  isToolError: boolean;
  toolDurationMs: number;
}

export class Agent {
  private client: OpenAI;
  private logger?: RunLogger | undefined;
  private mongoRunId?: ObjectId | undefined;
  private model: string | null = null;
  private mcp: MCPClient;
  private screenshotter: Screenshotter;
  private stepCount = 0;
  private mongoStepNumber = 0;
  private lastPageUrl: string | null = null;
  // Snapshot text at the moment of the last screenshot — used to detect UI state changes
  private lastCapturedSnapshot: string | null = null;
  private stopRequested = false;

  // Pipeline session collection
  private collector: SessionCollector | null = null;
  private lastAriaContent: string | null = null;
  private activeStepId: string | null = null;
  // Network requests seen before the current action (for delta tracking)
  private seenNetworkUrls = new Set<string>();
  private lastScreenshotPath: string | null = null;
  // Model advertised by the provider we built ourselves; empty when a client was injected.
  private providerModel = '';

  constructor(client?: OpenAI, logger?: RunLogger, mongoRunId?: ObjectId, modelOverride?: string) {
    if (client) {
      this.client = client;
    } else {
      const provider = createProvider('main');
      this.client = provider.client;
      this.providerModel = provider.model;
    }
    this.logger = logger;
    this.mongoRunId = mongoRunId;
    this.mcp = new MCPClient();
    this.screenshotter = new Screenshotter();
    if (modelOverride) this.model = modelOverride;
  }

  /** Returns the session directory path if a collector was initialized. */
  getSessionDirectory(): string | null {
    return this.collector?.sessionDirectory ?? null;
  }

  /** Returns the path of the last screenshot taken during this run. */
  getLastScreenshotPath(): string | null {
    return this.lastScreenshotPath;
  }

  /** Latest ARIA snapshot text seen this run — the text counterpart of getLastScreenshotPath(). */
  getLastAriaSnapshot(): string | null {
    return this.lastAriaContent ?? this.lastCapturedSnapshot;
  }

  /** Request graceful stop — agent will finish the current step and then halt. */
  requestStop(): void {
    this.stopRequested = true;
    console.log('\n[⏸] Stop requested — finishing current step, then halting...');
  }

  async run(prompt: string): Promise<void> {
    if (!this.model) this.model = this.providerModel || (await resolveModel(this.client));
    const model = this.model;

    const openaiTools = await this._connectAndPrepareTools(prompt, model);
    await this._initPipelineCollector(prompt);
    const flags = await this._initScreenshotter();
    const messages = await this._buildInitialMessages(prompt);

    await this._runIterations(messages, openaiTools, model, flags);

    this.mcp.disconnect();

    if (this.collector) {
      await this.collector.finishSession('completed');
    }
  }

  // ─── Run setup ────────────────────────────────────────────────────────────────

  private async _connectAndPrepareTools(
    prompt: string,
    model: string,
  ): Promise<OpenAI.Chat.ChatCompletionTool[]> {
    console.log(`\nTask: ${prompt}`);
    console.log('─'.repeat(50));
    console.log(`Model: ${model}`);
    console.log('Connecting to Playwright MCP server...');

    const tools = await this.mcp.connect();
    console.log(`Connected. ${tools.length} tools available.`);
    if (process.env.DEBUG) {
      console.log('Tools:', tools.map((t) => t.name).join(', '));
    }

    // Convert MCP tool schemas to OpenAI function format
    // Use hardcoded schemas since @playwright/mcp doesn't expose them via protocol
    const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: TOOL_SCHEMAS[tool.name] ?? { type: 'object', properties: {} },
      },
    }));
    return openaiTools;
  }

  private async _initPipelineCollector(prompt: string): Promise<void> {
    if (process.env.PIPELINE_ENABLED === 'false') return;

    const sessionId = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);
    const dataDir = resolve(process.cwd(), 'data');
    this.collector = new SessionCollector(dataDir, sessionId);
    await this.collector.init(prompt, '');
  }

  private async _initScreenshotter(): Promise<RunFlags> {
    const screenshotsEnabled = process.env.SCREENSHOTS_ENABLED !== 'false';
    const snapshotsEnabled = process.env.SNAPSHOTS_ENABLED !== 'false';
    if (screenshotsEnabled || snapshotsEnabled) {
      await this.screenshotter.init();
    }
    return { screenshotsEnabled, snapshotsEnabled };
  }

  private async _buildInitialMessages(prompt: string): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    const visitSummary = await getVisitSummary(20);
    const pageSummary = await getPageSummary(15);

    const extras = [visitSummary, pageSummary].filter(Boolean).join('\n\n');
    const systemContent = extras ? `${SYSTEM_PROMPT}\n\n${extras}` : SYSTEM_PROMPT;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt },
    ];
    return messages;
  }

  // ─── Iteration loop ─────────────────────────────────────────────────────────────

  private async _runIterations(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    openaiTools: OpenAI.Chat.ChatCompletionTool[],
    model: string,
    flags: RunFlags,
  ): Promise<void> {
    const maxIterations = parseInt(process.env.MAX_ITERATIONS || '60', 10);

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (this.stopRequested) {
        console.log('\n[⏸] Agent stopped by user request.');
        break;
      }
      console.log(`\n[Step ${iteration}] Thinking...`);

      const message = await this._requestNextMessage(messages, openaiTools, model);
      messages.push(message);
      if (message.content) {
        console.log(`  💭 ${message.content}`);
      }

      const toolCalls = this._getToolCalls(message);
      if (!toolCalls) {
        this._logCompletion(message);
        break;
      }

      await this._executeToolCalls(toolCalls, messages, flags);

      if (await this._checkAndLogLoop(iteration, messages)) break;

      if (iteration === maxIterations) {
        console.log('\nMax iterations reached. Stopping.');
      }
    }
  }

  private async _requestNextMessage(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    openaiTools: OpenAI.Chat.ChatCompletionTool[],
    model: string,
  ): Promise<OpenAI.Chat.ChatCompletionMessage> {
    const response = await this.client.chat.completions.create({
      model,
      messages,
      tools: openaiTools,
      tool_choice: 'auto',
      temperature: 0.2,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('OpenAI response contained no choices.');
    }
    return choice.message;
  }

  private _getToolCalls(
    message: OpenAI.Chat.ChatCompletionMessage,
  ): OpenAI.Chat.ChatCompletionMessageToolCall[] | null {
    const toolCalls = message.tool_calls;
    return toolCalls && toolCalls.length > 0 ? toolCalls : null;
  }

  private _logCompletion(message: OpenAI.Chat.ChatCompletionMessage): void {
    console.log('\n' + '─'.repeat(50));
    console.log('Done.\n');
    if (message.content) {
      console.log(message.content);
    }
  }

  private async _checkAndLogLoop(
    iteration: number,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): Promise<boolean> {
    const loopResult = checkForLoop(iteration, messages);
    if (!loopResult.isLoop) return false;

    console.log('\n⚠️  Loop detected! ' + loopResult.summary);
    console.log('Stopping execution to prevent infinite loop.');
    if (this.logger) {
      await this.logger.logResponse('LoopDetector', `LOOP DETECTED: ${loopResult.summary}`);
    }
    return true;
  }

  // ─── Tool-call dispatch ───────────────────────────────────────────────────────

  private async _executeToolCalls(
    toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    flags: RunFlags,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      await this._dispatchToolCall(toolCall, messages, flags);
    }
  }

  private async _dispatchToolCall(
    toolCall: OpenAI.Chat.ChatCompletionMessageToolCall,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    flags: RunFlags,
  ): Promise<void> {
    const call = this._parseToolCall(toolCall);
    console.log(`\n  → ${call.name}`, this._formatArgs(call.args));

    if (REGISTRY_TOOLS.has(call.name)) {
      await this._handleRegistryTool(call, messages);
      return;
    }

    await this._handleMcpToolCall(call, messages, flags);
  }

  private _parseToolCall(toolCall: OpenAI.Chat.ChatCompletionMessageToolCall): ParsedToolCall {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
    return { id: toolCall.id, name: toolCall.function.name, args };
  }

  private async _handleRegistryTool(
    call: ParsedToolCall,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): Promise<void> {
    let registryResult: string;
    try {
      if (call.name === 'registry_get_page_components') {
        const page = typeof call.args.page === 'string' ? call.args.page : '';
        registryResult = await toolGetPageComponents(page);
      } else {
        const query = typeof call.args.query === 'string' ? call.args.query : '';
        registryResult = await toolSearchComponents(query);
      }
    } catch (err) {
      registryResult = `Registry error: ${(err as Error).message}`;
    }
    console.log(`    Result: ${registryResult.slice(0, 300)}${registryResult.length > 300 ? '…' : ''}`);
    messages.push({ role: 'tool', tool_call_id: call.id, content: registryResult });
  }

  private async _handleMcpToolCall(
    call: ParsedToolCall,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    flags: RunFlags,
  ): Promise<void> {
    if (this._shouldTrackStep(call.name)) {
      await this._beginCollectorStep(call.name, call.args);
    }

    const exec = await this._executeMcpTool(call);
    const content = this._extractTextContent(exec.result);
    if (content) {
      console.log(`    Result: ${content.slice(0, 300)}${content.length > 300 ? '…' : ''}`);
    }

    if (this._shouldCacheAria(call.name, exec.isToolError, content)) {
      this.lastAriaContent = content;
    }

    if (this._shouldEndStep(call.name)) {
      await this._endCollectorStep(exec.isToolError);
    }

    const screenshotPath = await this._captureAfterToolCall(call, content, flags);
    await this._persistStep(call, content, screenshotPath, exec);

    messages.push({ role: 'tool', tool_call_id: call.id, content: content || 'OK' });

    await this._injectPostNavigationContext(call, exec.isToolError, messages);
  }

  private _shouldTrackStep(toolName: string): boolean {
    return this.collector !== null && ACTION_TOOLS.has(toolName);
  }

  private _shouldCacheAria(toolName: string, isToolError: boolean, content: string): boolean {
    return toolName === 'browser_snapshot' && !isToolError && content !== '';
  }

  private _shouldEndStep(toolName: string): boolean {
    return this.collector !== null && this.activeStepId !== null && ACTION_TOOLS.has(toolName);
  }

  private async _executeMcpTool(call: ParsedToolCall): Promise<McpExecResult> {
    const toolStartMs = Date.now();
    try {
      const result = await this.mcp.callTool(call.name, call.args);
      return { result, isToolError: false, toolDurationMs: Date.now() - toolStartMs };
    } catch (err) {
      const errorMsg = (err as Error).message;
      console.error(`    Error: ${errorMsg}`);
      if (this.logger) {
        await this.logger.logError(call.name, call.args, errorMsg);
      }
      return {
        result: { content: [{ type: 'text', text: `Error: ${errorMsg}` }] },
        isToolError: true,
        toolDurationMs: Date.now() - toolStartMs,
      };
    }
  }

  private async _recordNavigateVisitIfApplicable(call: ParsedToolCall): Promise<void> {
    if (call.name === 'browser_navigate' && typeof call.args.url === 'string') {
      await recordVisit(call.args.url);
    }
  }

  private async _recordVisitOnUrlChange(urlChanged: boolean): Promise<void> {
    if (urlChanged && this.lastPageUrl) {
      await recordVisit(this.lastPageUrl);
    }
  }

  private async _captureAfterToolCall(
    call: ParsedToolCall,
    content: string,
    flags: RunFlags,
  ): Promise<string | undefined> {
    if (!flags.screenshotsEnabled && !flags.snapshotsEnabled) {
      await this._recordNavigateVisitIfApplicable(call);
      return undefined;
    }

    const snapshotText = call.name === 'browser_snapshot'
      ? content
      : this._extractTextContent(await this.mcp.snapshot());
    if (!snapshotText) return undefined;

    const isInteraction = INTERACTION_TOOLS.has(call.name);
    const ctx: CaptureContext = {
      toolName: call.name,
      toolArgs: call.args,
      snapshotText,
      isInteraction,
      screenshotsEnabled: flags.screenshotsEnabled,
      snapshotsEnabled: flags.snapshotsEnabled,
    };
    const capture = await this._captureIfPageChanged(ctx);
    await this._recordVisitOnUrlChange(capture.urlChanged);
    return capture.screenshotPath ?? undefined;
  }

  private async _persistStep(
    call: ParsedToolCall,
    content: string,
    screenshotPath: string | undefined,
    exec: McpExecResult,
  ): Promise<void> {
    if (!this.mongoRunId) return;
    this.mongoStepNumber++;
    await saveStep({
      runId: this.mongoRunId,
      stepNumber: this.mongoStepNumber,
      action: call.name,
      args: call.args,
      url: this.lastPageUrl,
      screenshotPath: screenshotPath ?? null,
      result: content ? content.slice(0, 1000) : null,
      durationMs: exec.toolDurationMs,
      isError: exec.isToolError,
    });
  }

  // Signature on one line: crap4ts credits coverage only at >=0.8 span overlap.
  private async _injectPostNavigationContext(call: ParsedToolCall, isToolError: boolean, messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<void> {
    if (call.name !== 'browser_navigate' || isToolError) return;
    const navUrl = typeof call.args.url === 'string' ? call.args.url : this.lastPageUrl;
    if (!navUrl) return;

    const domDetail = await getComponentContextForUrl(navUrl);
    if (!domDetail) return;

    messages.push({
      role: 'user',
      content: `[Stored page context for ${navUrl}]\n${domDetail}`,
    });
  }

  private _extractTextContent(result: unknown): string {
    if (!result) return '';
    const r = result as { error?: string; content?: Array<{ type: string; text?: string }> };
    if (r.error) return `Error: ${r.error}`;
    if (Array.isArray(r.content)) {
      return r.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
    }
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
  }

  private _formatArgs(args: Record<string, unknown>): string {
    if (!args || Object.keys(args).length === 0) return '';
    const entries = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    return `{ ${entries} }`;
  }

  // ─── Pipeline helpers ────────────────────────────────────────────────────────

  private _lineMatchesRef(line: string, ref: string): boolean {
    return line.includes(`[ref=${ref}]`) || line.includes(`ref="${ref}"`);
  }

  private _extractAriaFromLine(line: string): { ariaRole: string | null; ariaName: string | null } | null {
    // Pattern: "  - button "Submit" [ref=e12]"
    const withName = line.match(/-\s+([a-z][\w-]*)\s+"([^"]+)"/i);
    if (withName?.[1] && withName[2] !== undefined) {
      return { ariaRole: withName[1].toLowerCase(), ariaName: withName[2] };
    }
    // Pattern: "  - button [ref=e12]" (no accessible name)
    const noName = line.match(/-\s+([a-z][\w-]*)\s+\[/i);
    if (noName?.[1]) return { ariaRole: noName[1].toLowerCase(), ariaName: null };
    return null;
  }

  /**
   * Parses the Playwright MCP ARIA snapshot text to find structured role/name for a given ref.
   * Snapshot lines look like:  "  - button \"Submit\" [ref=e12]"
   * Returns null fields if the ref is not found or has no accessible name.
   */
  private _parseElementFromSnapshot(
    content: string,
    ref: string,
  ): { ariaRole: string | null; ariaName: string | null } {
    for (const line of content.split('\n')) {
      if (!this._lineMatchesRef(line, ref)) continue;
      const parsed = this._extractAriaFromLine(line);
      if (parsed) return parsed;
    }
    return { ariaRole: null, ariaName: null };
  }

  // Enrich action.element with structured ariaRole/ariaName parsed from the ARIA snapshot.
  // buildActionData only captures the human-readable description; we need the real ARIA role
  // and name so that IdentityResolutionAgent can do STRONG matching.
  private _enrichElementFromAriaSnapshot(action: ActionData, ref: string): void {
    if (!this.lastAriaContent || !action.element) return;
    const parsed = this._parseElementFromSnapshot(this.lastAriaContent, ref);
    if (parsed.ariaRole) action.element.ariaRole = parsed.ariaRole;
    if (parsed.ariaName) action.element.ariaName = parsed.ariaName;
  }

  // Enrich action.element with real DOM attrs via browser_evaluate(ref).
  // This is the source of truth for selectors — no more guessing.
  private async _enrichElementFromDom(action: ActionData, ref: string): Promise<void> {
    if (!action.element) return;
    try {
      const attrs = await this.mcp.evaluateAttrsOnRef(ref);
      if (!attrs) return;
      action.element.attrs = attrs;
      if (attrs.testid) action.element.testid = attrs.testid;
      if (!action.element.tagName) action.element.tagName = attrs.tag;
      if (!action.element.text && attrs.text) action.element.text = attrs.text;
    } catch {
      // best-effort
    }
  }

  // Save structured DOM dump as the sole pre-action artifact.
  // Legacy aria YAML / dom HTML files are no longer written — the JSON
  // dump from browser_evaluate carries all the info downstream analyzers need.
  private async _captureDomDump(stepId: string, collector: SessionCollector): Promise<string> {
    try {
      const dump = await this.mcp.dumpInteractiveDom();
      if (dump && Array.isArray(dump)) {
        return await collector.saveDomDump(stepId, dump);
      }
      console.warn(`[Agent] dumpInteractiveDom returned null at ${stepId}`);
      return '';
    } catch (err) {
      console.warn(`[Agent] dumpInteractiveDom failed at ${stepId}: ${(err as Error).message}`);
      return '';
    }
  }

  private async _beginCollectorStep(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<void> {
    const collector = this.collector;
    if (!collector) return;

    const stepId = collector.nextStepId();
    this.activeStepId = stepId;

    const action = buildActionData(toolName, toolArgs);

    const ref = typeof toolArgs.ref === 'string' ? toolArgs.ref : null;
    if (ref) {
      this._enrichElementFromAriaSnapshot(action, ref);
      await this._enrichElementFromDom(action, ref);
    }

    const domFile = await this._captureDomDump(stepId, collector);
    const ariaFile = '';

    const storageFile = await collector.saveStorage(stepId, {
      localStorage: {},
      sessionStorage: {},
      cookies: [],
    });

    await collector.beginStep(stepId, this.lastPageUrl ?? '', action, {
      ariaSnapshotFile: ariaFile,
      domFile,
      storageFile,
      networkFile: `raw/network/${stepId}-network.json`,
      screenshotFile: `raw/screenshots/${stepId}-before.webp`,
    });
  }

  private async _endCollectorStep(isError: boolean): Promise<void> {
    if (!this.collector || !this.activeStepId) return;
    const stepId = this.activeStepId;
    this.activeStepId = null;

    if (isError) {
      // Mark step incomplete — don't save "after"
      return;
    }

    // Collect network events for this step
    let networkFile = '';
    try {
      const netResult = await this.mcp.callTool('browser_network_requests', {});
      const netContent = this._extractTextContent(netResult);
      networkFile = await this.collector.saveNetwork(stepId, { raw: netContent });
    } catch {
      // network collection is best-effort
    }

    // Refresh in-memory ARIA snapshot for the LLM's next turn (not persisted).
    try {
      const snapResult = await this.mcp.snapshot();
      const snapContent = snapResult ? this._extractTextContent(snapResult) : '';
      if (snapContent) this.lastAriaContent = snapContent;
    } catch {
      // best-effort
    }

    await this.collector.completeStep(stepId, {
      ariaSnapshotFile: '',
      networkFile,
    });
  }

  private _extractPageUrl(snapshotText: string): string | null {
    const match = snapshotText.match(/Page URL:\s*(https?:\/\/[^\s'"]+)/i);
    return match?.[1] ?? null;
  }

  private async _logSnapshotIfEnabled(ctx: CaptureContext): Promise<void> {
    if (!ctx.snapshotsEnabled) return;
    const snapshotPath = await this.screenshotter.saveSnapshot(
      this.stepCount, ctx.toolName, ctx.toolArgs, ctx.snapshotText,
    );
    const filename = this.screenshotter.buildFilename(
      this.stepCount, ctx.toolName, ctx.toolArgs,
      this.screenshotter.buildComparisonKey(ctx.toolName, ctx.toolArgs), '.txt',
    );
    console.log(`    Snapshot: ${snapshotPath ?? `./screenshots/snapshots-incoming/${filename}`}`);
  }

  private _decodeScreenshotData(data: string): string {
    if (!data.startsWith('data:image/')) return data;
    const [, payload] = data.split(',');
    return payload ?? '';
  }

  private async _getScreenshotBase64(): Promise<string | undefined> {
    const raw = await this.mcp.screenshot();
    if (!raw?.content) {
      console.log('    Screenshot: failed (null result)');
      return undefined;
    }

    const imageContent = raw.content.find((c) => c.type === 'image' || c.type === 'image_url');
    const data = imageContent?.data ?? imageContent?.url;
    if (!data) {
      console.log('    Screenshot: no image data');
      return undefined;
    }

    const base64 = this._decodeScreenshotData(data);
    if (!base64) {
      console.log('    Screenshot: empty base64 payload');
      return undefined;
    }
    return base64;
  }

  private async _fetchAndSaveScreenshot(
    ctx: CaptureContext,
    currentUrl: string | null,
  ): Promise<string | undefined> {
    const base64 = await this._getScreenshotBase64();
    if (!base64) return undefined;

    const saved = await this.screenshotter.saveBase64(this.stepCount, ctx.toolName, ctx.toolArgs, base64, currentUrl);
    if (!saved) {
      console.log('    Screenshot: failed to save');
      return undefined;
    }

    // Update baseline — this snapshot is now what the last screenshot represents
    this.lastCapturedSnapshot = ctx.snapshotText;
    this.lastScreenshotPath = saved.path;
    console.log(`    Screenshot saved: ${saved.path}`);
    return saved.path;
  }

  // Detect same-page UI state change: dropdown opened, hidden panel revealed, navbar updated, etc.
  private _computeChangeState(
    ctx: CaptureContext,
    currentUrl: string | null,
  ): { urlChanged: boolean; uiStateChanged: boolean } {
    const urlChanged = currentUrl !== null && currentUrl !== this.lastPageUrl;
    const uiStateChanged = ctx.isInteraction && ctx.snapshotText !== this.lastCapturedSnapshot;
    return { urlChanged, uiStateChanged };
  }

  private _logScreenshotSkipped(currentUrl: string | null): void {
    console.log(`    Screenshot skipped: page state unchanged (${currentUrl ?? 'URL unknown'})`);
  }

  private _logPageChange(urlChanged: boolean, currentUrl: string | null): void {
    if (urlChanged) {
      this.lastPageUrl = currentUrl;
      console.log(`    New page: ${currentUrl}`);
    } else {
      console.log(`    UI state changed on: ${currentUrl ?? 'current page'}`);
    }
  }

  // Returns urlChanged flag and optional screenshotPath.
  private async _captureIfPageChanged(
    ctx: CaptureContext,
  ): Promise<{ urlChanged: boolean; screenshotPath?: string }> {
    this.stepCount++;
    await this._logSnapshotIfEnabled(ctx);

    const currentUrl = this._extractPageUrl(ctx.snapshotText);
    const { urlChanged, uiStateChanged } = this._computeChangeState(ctx, currentUrl);

    if (!ctx.screenshotsEnabled) {
      if (urlChanged) this.lastPageUrl = currentUrl;
      return { urlChanged };
    }

    if (!urlChanged && !uiStateChanged) {
      this._logScreenshotSkipped(currentUrl);
      return { urlChanged: false };
    }

    this._logPageChange(urlChanged, currentUrl);

    this.stepCount++;
    const screenshotPath = await this._fetchAndSaveScreenshot(ctx, currentUrl);
    if (screenshotPath === undefined) return { urlChanged };
    return { urlChanged, screenshotPath };
  }
}
