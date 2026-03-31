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
    return this._request('tools/call', { name, arguments: args }) as Promise<MCPToolResult>;
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
