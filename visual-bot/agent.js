import OpenAI from 'openai';
import { MCPClient } from './mcp-client.js';
import { Screenshotter } from './screenshotter.js';

// Playwright MCP doesn't expose inputSchema via protocol — define them manually
const TOOL_SCHEMAS = {
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
};

const SYSTEM_PROMPT = `You are a browser automation agent. Complete the user's task step by step using the available browser tools.

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

## General rules
- ALWAYS call browser_snapshot before any click/type/select — refs change after navigation
- Never guess a ref — only use refs that appear in the latest snapshot
- After each action call browser_snapshot again to verify the result before proceeding
- When the task is fully complete, stop calling tools and write a concise summary
- If an action fails, take a new snapshot and try again with the correct ref`;

export class Agent {
  constructor() {
    this.client = new OpenAI({
      baseURL: process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1',
      apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
    });
    this.model = null; // resolved in run()
    this.mcp = new MCPClient();
    this.screenshotter = new Screenshotter();
    this.stepCount = 0;
  }

  async _resolveModel() {
    if (process.env.LM_STUDIO_MODEL) {
      return process.env.LM_STUDIO_MODEL;
    }
    const list = await this.client.models.list();
    const chat = list.data.find((m) => !m.id.includes('embedding'));
    if (!chat) throw new Error('No loaded models found in LM Studio');
    return chat.id;
  }

  async run(prompt) {
    this.model = await this._resolveModel();
    console.log(`\nTask: ${prompt}`);
    console.log('─'.repeat(50));
    console.log(`Model: ${this.model}`);
    console.log('Connecting to Playwright MCP server...');

    const tools = await this.mcp.connect();
    console.log(`Connected. ${tools.length} tools available.`);
    if (process.env.DEBUG) {
      console.log('Tools:', tools.map((t) => t.name).join(', '));
    }

    await this.screenshotter.init();

    // Convert MCP tool schemas to OpenAI function format
    // Use hardcoded schemas since @playwright/mcp doesn't expose them via protocol
    const openaiTools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: TOOL_SCHEMAS[tool.name] ?? { type: 'object', properties: {} },
      },
    }));

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ];

    const maxIterations = parseInt(process.env.MAX_ITERATIONS || '30', 10);

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
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
        let toolArgs;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          toolArgs = {};
        }

        console.log(`\n  → ${toolName}`, this._formatArgs(toolArgs));

        let result;
        try {
          result = await this.mcp.callTool(toolName, toolArgs);
        } catch (err) {
          result = { content: [{ type: 'text', text: `Error: ${err.message}` }] };
          console.error(`    Error: ${err.message}`);
        }

        // Feed tool result back to LLM
        const content = this._extractTextContent(result);
        if (content) {
          console.log(`    Result: ${content.slice(0, 300)}${content.length > 300 ? '…' : ''}`);
        }

        // Auto-screenshot after every tool call, attach image to next user message
        const NON_VISUAL_TOOLS = new Set([
          'browser_take_screenshot',
          'browser_generate_playwright_test',
          'browser_close',
          'browser_install',
          'browser_console_messages',
          'browser_network_requests',
          'browser_snapshot',
        ]);
        let screenshotBase64 = null;
        if (!NON_VISUAL_TOOLS.has(toolName)) {
          this.stepCount++;
          const screenshotResult = await this.mcp.screenshot();
          if (screenshotResult?.content) {
            const imageContent = screenshotResult.content.find(
              (c) => c.type === 'image' || c.type === 'image_url'
            );
            const data = imageContent?.data ?? imageContent?.url;
            if (data) {
              screenshotBase64 = data;
              await this.screenshotter.saveBase64(this.stepCount, toolName, toolArgs, screenshotBase64);
              const filename = this.screenshotter.buildFilename(this.stepCount, toolName, toolArgs);
              console.log(`    Screenshot: ./screenshots/${filename}`);
            } else {
              console.log(`    Screenshot: no image data`, JSON.stringify(screenshotResult).slice(0, 200));
            }
          } else {
            console.log(`    Screenshot: failed (null result)`);
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: content || 'OK',
        });

        // Send screenshot as follow-up user message so the model can see the page
        if (screenshotBase64) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${screenshotBase64}` },
              },
            ],
          });
        }
      }

      if (iteration === maxIterations) {
        console.log('\nMax iterations reached. Stopping.');
      }
    }

    this.mcp.disconnect();
  }

  _extractTextContent(result) {
    if (!result) return '';
    if (result.error) return `Error: ${result.error}`;
    if (Array.isArray(result.content)) {
      return result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
  }

  _formatArgs(args) {
    if (!args || Object.keys(args).length === 0) return '';
    const entries = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    return `{ ${entries} }`;
  }
}
