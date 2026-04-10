import OpenAI from 'openai';
import { ObjectId } from 'mongodb';
import { resolve } from 'path';
import { MCPClient } from '../../mcp-client.js';
import { Screenshotter } from '../../screenshotter.js';
import { resolveModel } from '../../utils.js';
import { recordVisit, getVisitSummary } from '../../memory.js';
import { getPageSummary, getComponentContextForUrl, toolGetPageComponents, toolSearchComponents } from '../../registry-context.js';
import { RunLogger } from '../../run-logger.js';
import { checkForLoop } from '../../loop-detector.js';
import { saveStep } from '../../db.js';
import { SessionCollector } from '../../pipeline/session-collector.js';
import type { ActionData, ActionType } from '../../pipeline/types.js';

// ... (schemas and prompt omitted for brevity in thought, but included in actual replacement)

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

function buildActionData(toolName: string, toolArgs: Record<string, unknown>): ActionData {
  const typeMap: Record<string, ActionType> = {
    browser_click: 'click',
    browser_type: 'fill',
    browser_navigate: 'navigate',
    browser_select_option: 'select',
    browser_hover: 'hover',
    browser_press_key: 'press_key',
  };

  const type: ActionType = typeMap[toolName] ?? 'other';
  const elementName = typeof toolArgs.element === 'string' ? toolArgs.element : undefined;
  const ref = typeof toolArgs.ref === 'string' ? toolArgs.ref : undefined;
  const text = typeof toolArgs.text === 'string' ? toolArgs.text : undefined;
  const url = typeof toolArgs.url === 'string' ? toolArgs.url : undefined;
  const values = Array.isArray(toolArgs.values) ? (toolArgs.values as string[]).join(', ') : undefined;

  return {
    type,
    description: elementName
      ? `${type} on "${elementName}"`
      : url
        ? `navigate to ${url}`
        : `${type}`,
    element: elementName || ref
      ? {
          ariaName: elementName ?? null,
          ref: ref ?? null,
        }
      : undefined,
    value: text ?? url ?? values,
  };
}

export class Agent {
  private client: OpenAI;
  private logger?: RunLogger;
  private mongoRunId?: ObjectId;
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

  constructor(client?: OpenAI, logger?: RunLogger, mongoRunId?: ObjectId, modelOverride?: string) {
    this.client = client ?? new OpenAI({
      baseURL: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1',
      apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
    });
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

  /** Request graceful stop — agent will finish the current step and then halt. */
  requestStop(): void {
    this.stopRequested = true;
    console.log('\n[⏸] Stop requested — finishing current step, then halting...');
  }

  async run(prompt: string): Promise<void> {
    if (!this.model) this.model = await resolveModel(this.client);
    console.log(`\nTask: ${prompt}`);
    console.log('─'.repeat(50));
    console.log(`Model: ${this.model}`);
    console.log('Connecting to Playwright MCP server...');

    const tools = await this.mcp.connect();
    console.log(`Connected. ${tools.length} tools available.`);
    if (process.env.DEBUG) {
      console.log('Tools:', tools.map((t) => t.name).join(', '));
    }

    // Initialize pipeline session collector
    if (process.env.PIPELINE_ENABLED !== 'false') {
      const sessionId = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, 19);
      const dataDir = resolve(process.cwd(), 'data');
      this.collector = new SessionCollector(dataDir, sessionId);
      await this.collector.init(prompt, '');
    }

    const screenshotsEnabled = process.env.SCREENSHOTS_ENABLED !== 'false';
    const snapshotsEnabled = process.env.SNAPSHOTS_ENABLED !== 'false';
    if (screenshotsEnabled || snapshotsEnabled) {
      await this.screenshotter.init();
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

    const visitSummary = await getVisitSummary(20);
    const pageSummary = await getPageSummary(15);

    const extras = [visitSummary, pageSummary].filter(Boolean).join('\n\n');
    const systemContent = extras ? `${SYSTEM_PROMPT}\n\n${extras}` : SYSTEM_PROMPT;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt },
    ];

    const maxIterations = parseInt(process.env.MAX_ITERATIONS || '60', 10);

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (this.stopRequested) {
        console.log('\n[⏸] Agent stopped by user request.');
        break;
      }
      console.log(`\n[Step ${iteration}] Thinking...`);

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: openaiTools,
        tool_choice: 'auto',
        temperature: 0.2,
      });

      const message = response.choices[0].message;
      messages.push(message);

      if (message.content) {
        console.log(`  💭 ${message.content}`);
      }

      // No tool calls → agent is done
      if (!message.tool_calls || message.tool_calls.length === 0) {
        console.log('\n' + '─'.repeat(50));
        console.log('Done.\n');
        if (message.content) {
          console.log(message.content);
        }
        break;
      }

      // Execute tool calls sequentially
      for (const toolCall of message.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          toolArgs = {};
        }

        console.log(`\n  → ${toolName}`, this._formatArgs(toolArgs));

        // Registry tools are handled locally — skip MCP entirely
        if (REGISTRY_TOOLS.has(toolName)) {
          let registryResult: string;
          try {
            if (toolName === 'registry_get_page_components') {
              registryResult = await toolGetPageComponents(String(toolArgs.page ?? ''));
            } else {
              registryResult = await toolSearchComponents(String(toolArgs.query ?? ''));
            }
          } catch (err) {
            registryResult = `Registry error: ${(err as Error).message}`;
          }
          console.log(`    Result: ${registryResult.slice(0, 300)}${registryResult.length > 300 ? '…' : ''}`);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: registryResult });
          continue;
        }

        // Pipeline: start step collection BEFORE executing action tools
        if (this.collector && ACTION_TOOLS.has(toolName)) {
          await this._beginCollectorStep(toolName, toolArgs);
        }

        let result;
        let isToolError = false;
        const toolStartMs = Date.now();
        try {
          result = await this.mcp.callTool(toolName, toolArgs);
        } catch (err) {
          const errorMsg = (err as Error).message;
          result = { content: [{ type: 'text', text: `Error: ${errorMsg}` }] };
          isToolError = true;
          console.error(`    Error: ${errorMsg}`);
          if (this.logger) {
            await this.logger.logError(toolName, toolArgs, errorMsg);
          }
        }
        const toolDurationMs = Date.now() - toolStartMs;

        // Feed tool result back to LLM
        const content = this._extractTextContent(result);
        if (content) {
          console.log(`    Result: ${content.slice(0, 300)}${content.length > 300 ? '…' : ''}`);
        }

        // Pipeline: cache ARIA content for use as "before" on next action
        if (toolName === 'browser_snapshot' && !isToolError && content) {
          this.lastAriaContent = content;
        }

        // Pipeline: complete step AFTER action executes
        if (this.collector && this.activeStepId && ACTION_TOOLS.has(toolName)) {
          await this._endCollectorStep(isToolError);
        }

        // Capture screenshot/snapshot after each tool call if enabled
        let screenshotPath: string | undefined;
        if (screenshotsEnabled || snapshotsEnabled) {
          const snapshotText =
            toolName === 'browser_snapshot'
              ? content
              : this._extractTextContent(await this.mcp.snapshot());

          if (snapshotText) {
            const isInteraction = INTERACTION_TOOLS.has(toolName);
            const capture = await this._captureIfPageChanged(
              toolName, toolArgs, snapshotText, isInteraction,
              screenshotsEnabled, snapshotsEnabled,
            );
            screenshotPath = capture.screenshotPath ?? undefined;
            // Record visit on URL change
            if (capture.urlChanged && this.lastPageUrl) {
              await recordVisit(this.lastPageUrl);
            }
          }
        } else if (toolName === 'browser_navigate' && typeof toolArgs.url === 'string') {
          await recordVisit(toolArgs.url);
        }

        // Persist step to MongoDB
        if (this.mongoRunId) {
          this.mongoStepNumber++;
          await saveStep({
            runId: this.mongoRunId,
            stepNumber: this.mongoStepNumber,
            action: toolName,
            args: toolArgs,
            url: this.lastPageUrl,
            screenshotPath: screenshotPath ?? null,
            result: content ? content.slice(0, 1000) : null,
            durationMs: toolDurationMs,
            isError: isToolError,
          });
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: content || 'OK',
        });

        // After navigation: inject stored DOM context for the new URL (if any)
        if (toolName === 'browser_navigate' && !isToolError) {
          const navUrl = typeof toolArgs.url === 'string' ? toolArgs.url : this.lastPageUrl;
          if (navUrl) {
            const domDetail = await getComponentContextForUrl(navUrl);
            if (domDetail) {
              messages.push({
                role: 'user',
                content: `[Stored page context for ${navUrl}]\n${domDetail}`,
              });
            }
          }
        }
      }

      // Каждые 10 итераций проверяем на зависание агента
      const loopResult = checkForLoop(iteration, messages);
      if (loopResult.isLoop) {
        console.log('\n⚠️  Loop detected! ' + loopResult.summary);
        console.log('Stopping execution to prevent infinite loop.');
        if (this.logger) {
          await this.logger.logResponse('LoopDetector', `LOOP DETECTED: ${loopResult.summary}`);
        }
        break;
      }

      if (iteration === maxIterations) {
        console.log('\nMax iterations reached. Stopping.');
      }
    }

    this.mcp.disconnect();

    if (this.collector) {
      await this.collector.finishSession('completed');
    }
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
      if (!line.includes(`[ref=${ref}]`) && !line.includes(`ref="${ref}"`)) continue;
      // Pattern: "  - button "Submit" [ref=e12]"
      const withName = line.match(/-\s+([a-z][\w-]*)\s+"([^"]+)"/i);
      if (withName) return { ariaRole: withName[1].toLowerCase(), ariaName: withName[2] };
      // Pattern: "  - button [ref=e12]" (no accessible name)
      const noName = line.match(/-\s+([a-z][\w-]*)\s+\[/i);
      if (noName) return { ariaRole: noName[1].toLowerCase(), ariaName: null };
    }
    return { ariaRole: null, ariaName: null };
  }

  private async _beginCollectorStep(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<void> {
    if (!this.collector) return;

    const stepId = this.collector.nextStepId();
    this.activeStepId = stepId;

    const action = buildActionData(toolName, toolArgs);

    // Enrich action.element with structured ariaRole/ariaName parsed from the ARIA snapshot.
    // buildActionData only captures the human-readable description; we need the real ARIA role
    // and name so that IdentityResolutionAgent can do STRONG matching.
    const ref = typeof toolArgs.ref === 'string' ? toolArgs.ref : null;
    if (ref && this.lastAriaContent && action.element) {
      const parsed = this._parseElementFromSnapshot(this.lastAriaContent, ref);
      if (parsed.ariaRole) action.element.ariaRole = parsed.ariaRole;
      if (parsed.ariaName) action.element.ariaName = parsed.ariaName;
    }

    // Save "before" ARIA snapshot (last cached browser_snapshot result)
    let ariaFile = '';
    let domFile = '';
    if (this.lastAriaContent) {
      ariaFile = await this.collector.saveAriaSnapshot(stepId, this.lastAriaContent);
      domFile = await this.collector.saveDomSnapshot(stepId, this.lastAriaContent);
    }

    const storageFile = await this.collector.saveStorage(stepId, {
      localStorage: {},
      sessionStorage: {},
      cookies: [],
    });

    await this.collector.beginStep(stepId, this.lastPageUrl ?? '', action, {
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

    // Get "after" ARIA snapshot
    let afterAriaFile = '';
    try {
      const snapResult = await this.mcp.snapshot();
      const snapContent = snapResult ? this._extractTextContent(snapResult) : '';
      if (snapContent) {
        this.lastAriaContent = snapContent;
        afterAriaFile = await this.collector.saveAriaSnapshot(`${stepId}-after`, snapContent);
      }
    } catch {
      // best-effort
    }

    await this.collector.completeStep(stepId, {
      ariaSnapshotFile: afterAriaFile,
      networkFile,
    });
  }

  private _extractPageUrl(snapshotText: string): string | null {
    const match = snapshotText.match(/Page URL:\s*(https?:\/\/[^\s'"]+)/i);
    return match?.[1] ?? null;
  }

  // Returns urlChanged flag and optional screenshotPath.
  private async _captureIfPageChanged(
    sourceToolName: string,
    sourceToolArgs: Record<string, unknown>,
    snapshotText: string,
    isInteraction: boolean,
    screenshotsEnabled: boolean,
    snapshotsEnabled: boolean,
  ): Promise<{ urlChanged: boolean; screenshotPath?: string }> {
    this.stepCount++;

    if (snapshotsEnabled) {
      const snapshotPath = await this.screenshotter.saveSnapshot(
        this.stepCount,
        sourceToolName,
        sourceToolArgs,
        snapshotText
      );
      const filename = this.screenshotter.buildFilename(
        this.stepCount,
        sourceToolName,
        sourceToolArgs,
        this.screenshotter.buildComparisonKey(sourceToolName, sourceToolArgs),
        '.txt'
      );
      console.log(`    Snapshot: ${snapshotPath ?? `./screenshots/snapshots-incoming/${filename}`}`);
    }

    const currentUrl = this._extractPageUrl(snapshotText);
    const urlChanged = currentUrl !== null && currentUrl !== this.lastPageUrl;

    // Detect same-page UI state change: dropdown opened, hidden panel revealed, navbar updated, etc.
    const uiStateChanged =
      isInteraction && snapshotText !== this.lastCapturedSnapshot;

    if (!screenshotsEnabled) {
      if (urlChanged) this.lastPageUrl = currentUrl;
      return { urlChanged };
    }

    if (!urlChanged && !uiStateChanged) {
      console.log(`    Screenshot skipped: page state unchanged (${currentUrl ?? 'URL unknown'})`);
      return { urlChanged: false };
    }

    if (urlChanged) {
      this.lastPageUrl = currentUrl;
      console.log(`    New page: ${currentUrl}`);
    } else {
      console.log(`    UI state changed on: ${currentUrl ?? 'current page'}`);
    }

    this.stepCount++;
    const raw = await this.mcp.screenshot();
    if (!raw?.content) {
      console.log('    Screenshot: failed (null result)');
      return { urlChanged };
    }

    const imageContent = raw.content.find((c) => c.type === 'image' || c.type === 'image_url');
    const data = imageContent?.data ?? imageContent?.url;
    if (!data) {
      console.log('    Screenshot: no image data');
      return { urlChanged };
    }

    let base64: string;
    if (data.startsWith('data:image/')) {
      const [, payload] = data.split(',');
      base64 = payload ?? '';
    } else {
      base64 = data;
    }

    if (!base64) {
      console.log('    Screenshot: empty base64 payload');
      return { urlChanged };
    }

    const saved = await this.screenshotter.saveBase64(this.stepCount, sourceToolName, sourceToolArgs, base64, currentUrl);
    if (!saved) {
      console.log('    Screenshot: failed to save');
      return { urlChanged };
    }

    // Update baseline — this snapshot is now what the last screenshot represents
    this.lastCapturedSnapshot = snapshotText;

    this.lastScreenshotPath = saved.path;
    console.log(`    Screenshot saved: ${saved.path}`);
    return { urlChanged, screenshotPath: saved.path };
  }
}
