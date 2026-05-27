import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface MCPMessage {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface MCPTool {
  name: string;
  description: string;
}

interface MCPToolResult {
  content?: Array<{ type: string; text?: string; data?: string; url?: string }>;
  error?: string;
}

export class MCPClient {
  private process: ChildProcess | null = null;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private nextId = 1;
  public tools: MCPTool[] = [];
  private rl: Interface | null = null;

  async connect(): Promise<MCPTool[]> {
    const cliPath = this._resolveCLI();

    this.process = spawn('node', [cliPath, '--no-sandbox', '--isolated'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (err: Error) => {
      console.error('MCP process error:', err.message);
    });

    this.process.on('exit', (code: number | null) => {
      if (code !== null && code !== 0) {
        console.error(`MCP process exited with code ${code}`);
      }
    });

    // Log MCP stderr only in debug mode
    this.process.stderr!.on('data', (data: Buffer) => {
      if (process.env.DEBUG) {
        process.stderr.write(`[MCP] ${data}`);
      }
    });

    this.rl = createInterface({ input: this.process.stdout!, crlfDelay: Infinity });

    this.rl.on('line', (line: string) => {
      line = line.trim();
      if (!line) return;
      let msg: MCPMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not JSON, ignore
      }
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const { resolve, reject } = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      }
    });

    // MCP handshake
    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'visual-bot', version: '1.0.0' },
    });

    this._notify('notifications/initialized', {});

    const { tools } = await this._request('tools/list', {}) as { tools: MCPTool[] };
    this.tools = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    return this._request('tools/call', {
      name,
      arguments: this._adaptArgs(args),
    }) as Promise<MCPToolResult>;
  }

  /**
   * MCP 0.0.75 renamed `ref` → `target` on every interaction tool. We keep the
   * internal contract on `ref` (so the LLM and agent code don't need to change)
   * and rename here before sending to the server.
   */
  private _adaptArgs(args: Record<string, unknown>): Record<string, unknown> {
    if (!args || typeof args !== 'object') return args;
    if ('ref' in args && !('target' in args)) {
      const { ref, ...rest } = args;
      return { ...rest, target: ref };
    }
    return args;
  }

  async screenshot(): Promise<MCPToolResult | null> {
    try {
      return await this._request('tools/call', {
        name: 'browser_take_screenshot',
        arguments: {},
      }) as MCPToolResult;
    } catch {
      return null;
    }
  }

  async snapshot(): Promise<MCPToolResult | null> {
    try {
      return await this._request('tools/call', {
        name: 'browser_snapshot',
        arguments: {},
      }) as MCPToolResult;
    } catch {
      return null;
    }
  }

  /**
   * Run a JS function on the page. If `ref` is provided, the function receives that element as `el`.
   * Returns the parsed JSON value the function returned, or null on any failure.
   */
  async evaluate<T = unknown>(
    fnSource: string,
    opts: { ref?: string; element?: string } = {},
  ): Promise<T | null> {
    const args: Record<string, unknown> = { function: fnSource };
    if (opts.ref) args.target = opts.ref;
    if (opts.element) args.element = opts.element;
    try {
      const result = await this._request('tools/call', {
        name: 'browser_evaluate',
        arguments: args,
      }) as MCPToolResult;
      const parsed = parseEvaluateResult<T>(result);
      if (parsed === null && process.env.DEBUG_EVAL) {
        const raw = Array.isArray(result?.content)
          ? result.content.map((c) => c.text ?? '').join('\n').slice(0, 500)
          : JSON.stringify(result).slice(0, 500);
        console.warn(`[MCP eval] parse failed. raw: ${raw}`);
      }
      return parsed;
    } catch (err) {
      console.warn(`[MCP eval] call failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Extracts stable attributes for the element referenced by aria-ref `eN`. */
  async evaluateAttrsOnRef(ref: string): Promise<import('./pipeline/types.js').DomElementAttrs | null> {
    return this.evaluate<import('./pipeline/types.js').DomElementAttrs>(EXTRACT_ATTRS_FN, {
      ref,
      element: `element ref=${ref}`,
    });
  }

  /** Dumps all visible interactive elements on the current page as DomElementDump[]. */
  async dumpInteractiveDom(): Promise<import('./pipeline/types.js').DomElementDump[] | null> {
    return this.evaluate<import('./pipeline/types.js').DomElementDump[]>(DUMP_INTERACTIVE_FN);
  }

  disconnect(): void {
    if (this.rl) this.rl.close();
    if (this.process) {
      this.process.stdin!.end();
      setTimeout(() => this.process!.kill(), 500);
    }
  }

  private _request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;

      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Timeout waiting for MCP response to "${method}"`));
        }
      }, 60_000);

      this.pendingRequests.set(id, {
        resolve: (val) => { clearTimeout(timeout); resolve(val); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.process!.stdin!.write(msg + '\n');
    });
  }

  private _notify(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.process!.stdin!.write(msg + '\n');
  }

  private _resolveCLI(): string {
    const require = createRequire(import.meta.url);
    let pkgJsonPath: string;
    try {
      pkgJsonPath = require.resolve('@playwright/mcp/package.json');
    } catch {
      throw new Error('Cannot find @playwright/mcp. Run: npm install');
    }
    const pkgDir = dirname(pkgJsonPath);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
      bin?: string | Record<string, string>;
      main?: string;
    };

    const bin = pkg.bin;
    let cliRel: string;
    if (typeof bin === 'string') {
      cliRel = bin;
    } else if (bin && typeof bin === 'object') {
      cliRel = Object.values(bin)[0];
    } else {
      cliRel = pkg.main || 'cli.js';
    }

    return resolve(pkgDir, cliRel);
  }
}

// ─── browser_evaluate helpers ───────────────────────────────────────────────

function parseEvaluateResult<T>(result: MCPToolResult): T | null {
  if (!result || !Array.isArray(result.content)) return null;
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
  if (!text) return null;

  // MCP 0.0.75 wraps eval output as:
  //   ### Result
  //   <json or scalar>
  //   ### Ran Playwright code
  //   ```js ... ```
  // Extract the block between "### Result" and the next "###" header (or EOF).
  const resultMatch = text.match(/###\s*Result\s*\n([\s\S]*?)(?:\n###\s|$)/i);
  const candidate = (resultMatch ? resultMatch[1] : text).trim();
  if (!candidate) return null;

  // Strip a leading code fence if present.
  const unfenced = candidate
    .replace(/^```(?:json|javascript|js)?\s*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();

  try {
    return JSON.parse(unfenced) as T;
  } catch {
    // Some scalars come back without quotes (numbers, booleans, "undefined").
    if (unfenced === 'undefined' || unfenced === 'null') return null;
    if (unfenced === 'true' || unfenced === 'false') return (unfenced === 'true') as unknown as T;
    const num = Number(unfenced);
    if (!Number.isNaN(num) && unfenced !== '') return num as unknown as T;
    // Bare string (no quotes) — wrap and retry.
    try {
      return JSON.parse(`"${unfenced.replace(/"/g, '\\"')}"`) as T;
    } catch {
      return null;
    }
  }
}

// Shared JS expression (string) that reads validation constraints from an element.
const CONSTRAINTS_EXPR = `(function(el){
  var t = el.tagName ? el.tagName.toLowerCase() : '';
  if (t !== 'input' && t !== 'textarea' && t !== 'select') return null;
  var num = function(v){ var n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
  return {
    required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    disabled: el.disabled === true || el.hasAttribute('disabled'),
    readonly: el.readOnly === true || el.hasAttribute('readonly'),
    inputType: el.getAttribute('type'),
    minLength: num(el.getAttribute('minlength')),
    maxLength: num(el.getAttribute('maxlength')),
    min: el.getAttribute('min'),
    max: el.getAttribute('max'),
    step: el.getAttribute('step'),
    pattern: el.getAttribute('pattern'),
  };
})`;

const EXTRACT_ATTRS_FN = `(el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  return {
    tag: el.tagName ? el.tagName.toLowerCase() : 'unknown',
    testid: el.getAttribute('data-testid'),
    id: el.id || null,
    name: el.getAttribute('name'),
    type: el.getAttribute('type'),
    role: el.getAttribute('role'),
    ariaLabel: el.getAttribute('aria-label'),
    classes: (typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '').slice(0, 200) || null,
    text: (el.innerText || el.textContent || '').trim().slice(0, 120) || null,
    href: el.getAttribute('href'),
    bbox: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    constraints: (${CONSTRAINTS_EXPR})(el),
  };
}`;

const DUMP_INTERACTIVE_FN = `() => {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.01;
  };
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1'));
  const interactiveSel = 'button,a,input,textarea,select,[role],[contenteditable="true"],[data-testid],[data-test],[data-cy],[data-qa],[tabindex]';
  const els = Array.from(document.querySelectorAll(interactiveSel)).filter(isVisible);
  return els.map((el) => {
    const r = el.getBoundingClientRect();
    const testid = el.getAttribute('data-testid');
    const id = el.id || null;
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    const name = el.getAttribute('name');
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.textContent || '').trim().slice(0, 120) || null;
    const classes = (typeof el.className === 'string' ? el.className : '').slice(0, 200) || null;

    let preferredSelector = '';
    let selectorKind = 'none';
    if (testid) { preferredSelector = '[data-testid="' + cssEscape(testid) + '"]'; selectorKind = 'testid'; }
    else if (id && !/^[0-9]/.test(id) && !/^(ember|react|mui|radix|headlessui)-?\\d/i.test(id)) {
      preferredSelector = '#' + cssEscape(id); selectorKind = 'id';
    } else if (ariaLabel) { preferredSelector = tag + '[aria-label="' + cssEscape(ariaLabel) + '"]'; selectorKind = 'aria'; }
    else if (name) { preferredSelector = tag + '[name="' + cssEscape(name) + '"]'; selectorKind = 'css'; }
    else if (text && text.length <= 30 && (tag === 'a' || tag === 'button')) {
      preferredSelector = tag + ':has-text("' + text.replace(/"/g, '\\\\"') + '")'; selectorKind = 'text';
    }

    const tn = tag;
    const constraints = (tn === 'input' || tn === 'textarea' || tn === 'select') ? {
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      disabled: el.disabled === true || el.hasAttribute('disabled'),
      readonly: el.readOnly === true || el.hasAttribute('readonly'),
      inputType: el.getAttribute('type'),
      minLength: (function(v){ var n = parseInt(v,10); return Number.isNaN(n)?null:n; })(el.getAttribute('minlength')),
      maxLength: (function(v){ var n = parseInt(v,10); return Number.isNaN(n)?null:n; })(el.getAttribute('maxlength')),
      min: el.getAttribute('min'),
      max: el.getAttribute('max'),
      step: el.getAttribute('step'),
      pattern: el.getAttribute('pattern'),
    } : null;

    return {
      tag, testid, id, name,
      type: el.getAttribute('type'),
      role, ariaLabel, classes, text,
      href: el.getAttribute('href'),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      preferredSelector, selectorKind, constraints,
    };
  });
}`;
