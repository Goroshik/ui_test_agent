import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

export class MCPClient {
  constructor() {
    this.process = null;
    this.pendingRequests = new Map();
    this.nextId = 1;
    this.tools = [];
    this.rl = null;
  }

  async connect() {
    const cliPath = this._resolveCLI();

    this.process = spawn('node', [cliPath, '--no-sandbox'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (err) => {
      console.error('MCP process error:', err.message);
    });

    this.process.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`MCP process exited with code ${code}`);
      }
    });

    // Log MCP stderr only in debug mode
    this.process.stderr.on('data', (data) => {
      if (process.env.DEBUG) {
        process.stderr.write(`[MCP] ${data}`);
      }
    });

    this.rl = createInterface({ input: this.process.stdout, crlfDelay: Infinity });

    this.rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not JSON, ignore
      }
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const { resolve, reject } = this.pendingRequests.get(msg.id);
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

    const { tools } = await this._request('tools/list', {});
    this.tools = tools;
    return tools;
  }

  async callTool(name, args) {
    return this._request('tools/call', { name, arguments: args });
  }

  async screenshot() {
    try {
      return await this._request('tools/call', {
        name: 'browser_take_screenshot',
        arguments: {},
      });
    } catch {
      return null;
    }
  }

  disconnect() {
    if (this.rl) this.rl.close();
    if (this.process) {
      this.process.stdin.end();
      setTimeout(() => this.process.kill(), 500);
    }
  }

  _request(method, params) {
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
      this.process.stdin.write(msg + '\n');
    });
  }

  _notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.process.stdin.write(msg + '\n');
  }

  _resolveCLI() {
    const require = createRequire(import.meta.url);
    let pkgJsonPath;
    try {
      pkgJsonPath = require.resolve('@playwright/mcp/package.json');
    } catch {
      throw new Error(
        'Cannot find @playwright/mcp. Run: npm install'
      );
    }
    const pkgDir = dirname(pkgJsonPath);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

    const bin = pkg.bin;
    let cliRel;
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
