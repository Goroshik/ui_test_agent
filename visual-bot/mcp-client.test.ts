import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { MCPClient } from './mcp-client.js';

/**
 * Builds a client whose transport is replaced by a canned browser_evaluate
 * response, so evaluate() exercises the real parse chain:
 * extractEvaluateText -> extractResultCandidate -> stripCodeFence ->
 * JSON.parse -> parseUnfencedScalar.
 */
function clientReturning(resultText: string): MCPClient {
  const client = new MCPClient();
  client['_request'] = (): Promise<unknown> =>
    Promise.resolve({ content: [{ type: 'text', text: resultText }] });
  return client;
}

/** Wraps a raw value the way MCP 0.0.75 formats browser_evaluate output. */
function mcpResult(value: string): string {
  return `### Result\n${value}\n### Ran Playwright code\n\`\`\`js\nawait page.evaluate(...)\n\`\`\``;
}

const evaluate = (resultText: string): Promise<unknown> =>
  clientReturning(resultText).evaluate('() => 1');

describe('MCPClient.evaluate — JSON results', () => {
  it('parses a JSON object', async () => {
    await expect(evaluate(mcpResult('{"a":1,"b":"x"}'))).resolves.toEqual({ a: 1, b: 'x' });
  });

  it('parses a JSON array', async () => {
    await expect(evaluate(mcpResult('[1,2,3]'))).resolves.toEqual([1, 2, 3]);
  });

  it('parses a quoted string', async () => {
    await expect(evaluate(mcpResult('"hello"'))).resolves.toBe('hello');
  });

  it('parses a plain number', async () => {
    await expect(evaluate(mcpResult('42'))).resolves.toBe(42);
  });

  it('parses booleans', async () => {
    await expect(evaluate(mcpResult('true'))).resolves.toBe(true);
    await expect(evaluate(mcpResult('false'))).resolves.toBe(false);
  });

  it('strips a json code fence around the result', async () => {
    await expect(evaluate(mcpResult('```json\n{"a":1}\n```'))).resolves.toEqual({ a: 1 });
  });

  it('strips a bare code fence around the result', async () => {
    await expect(evaluate(mcpResult('```\n{"a":2}\n```'))).resolves.toEqual({ a: 2 });
  });

  it('falls back to the whole text when there is no Result header', async () => {
    await expect(evaluate('{"a":3}')).resolves.toEqual({ a: 3 });
  });

  it('joins several text parts before parsing', async () => {
    const client = new MCPClient();
    client['_request'] = (): Promise<unknown> =>
      Promise.resolve({
        content: [
          { type: 'text', text: '### Result' },
          { type: 'text', text: '{"joined":true}' },
        ],
      });
    await expect(client.evaluate('() => 1')).resolves.toEqual({ joined: true });
  });
});

describe('MCPClient.evaluate — non-JSON scalars (parseUnfencedScalar)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps the literal "undefined" to null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(evaluate(mcpResult('undefined'))).resolves.toBeNull();
  });

  it('parses a bare unquoted string', async () => {
    await expect(evaluate(mcpResult('hello world'))).resolves.toBe('hello world');
  });

  it('parses Infinity through the numeric branch', async () => {
    // JSON.parse('Infinity') throws, so this reaches parseUnfencedScalar,
    // where Number('Infinity') is a non-NaN number.
    await expect(evaluate(mcpResult('Infinity'))).resolves.toBe(Infinity);
  });

  it('parses a bare string containing a quote', async () => {
    await expect(evaluate(mcpResult('say "hi"'))).resolves.toBe('say "hi"');
  });

  it('returns null for a trailing backslash that cannot be re-wrapped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Re-wrapping yields "...\" — an unterminated escape, so JSON.parse throws.
    await expect(evaluate(mcpResult('bad\\'))).resolves.toBeNull();
  });

  it('returns null when the text content is empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new MCPClient();
    client['_request'] = (): Promise<unknown> =>
      Promise.resolve({ content: [{ type: 'text', text: '' }] });
    await expect(client.evaluate('() => 1')).resolves.toBeNull();
  });

  it('lets a blank line after the Result header swallow the block', async () => {
    // Documents current behaviour rather than asserting it is desirable: the
    // `\s*` before the newline in the Result regex is greedy, so a blank line
    // makes the capture start at the *next* header instead of an empty value.
    await expect(evaluate('### Result\n\n### Ran Playwright code')).resolves.toBe(
      '### Ran Playwright code',
    );
  });

  it('returns null when there is no text content at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new MCPClient();
    client['_request'] = (): Promise<unknown> => Promise.resolve({ content: [] });
    await expect(client.evaluate('() => 1')).resolves.toBeNull();
  });

  it('returns null when the transport rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new MCPClient();
    client['_request'] = (): Promise<unknown> => Promise.reject(new Error('transport down'));
    await expect(client.evaluate('() => 1')).resolves.toBeNull();
  });
});

describe('MCPClient._resolveCLI', () => {
  it('resolves the installed @playwright/mcp CLI to an existing file', () => {
    const cliPath = new MCPClient()['_resolveCLI']();

    expect(cliPath).toMatch(/[\\/]@playwright[\\/]mcp[\\/]/);
    expect(existsSync(cliPath)).toBe(true);
  });

  it('returns an absolute path', () => {
    const cliPath = new MCPClient()['_resolveCLI']();
    // Absolute on POSIX (leading /) or Windows (drive letter).
    expect(/^([a-zA-Z]:[\\/]|\/)/.test(cliPath)).toBe(true);
  });
});

describe('MCPClient._handleIncomingLine', () => {
  interface Captured {
    resolved: unknown[];
    rejected: Error[];
  }

  /** Registers a pending request under `id` and returns what it settles with. */
  function withPending(id: number): { client: MCPClient; captured: Captured } {
    const client = new MCPClient();
    const captured: Captured = { resolved: [], rejected: [] };
    client['pendingRequests'].set(id, {
      resolve: (value) => captured.resolved.push(value),
      reject: (reason) => captured.rejected.push(reason),
    });
    return { client, captured };
  }

  const feed = (client: MCPClient, line: string): void => client['_handleIncomingLine'](line);

  it('resolves the matching pending request with the result', () => {
    const { client, captured } = withPending(7);
    feed(client, JSON.stringify({ id: 7, result: { ok: true } }));

    expect(captured.resolved).toEqual([{ ok: true }]);
    expect(captured.rejected).toEqual([]);
  });

  it('removes the request from the pending map once settled', () => {
    const { client } = withPending(7);
    feed(client, JSON.stringify({ id: 7, result: 1 }));

    expect(client['pendingRequests'].has(7)).toBe(false);
  });

  it('rejects with the code and message when the message carries an error', () => {
    const { client, captured } = withPending(7);
    feed(client, JSON.stringify({ id: 7, error: { code: -32601, message: 'Method not found' } }));

    expect(captured.resolved).toEqual([]);
    expect(captured.rejected[0]?.message).toBe('MCP error -32601: Method not found');
  });

  it('trims surrounding whitespace before parsing', () => {
    const { client, captured } = withPending(7);
    feed(client, `   ${JSON.stringify({ id: 7, result: 'ok' })}   `);

    expect(captured.resolved).toEqual(['ok']);
  });

  it('ignores a blank line', () => {
    const { client, captured } = withPending(7);
    feed(client, '   ');

    expect(captured.resolved).toEqual([]);
    expect(client['pendingRequests'].has(7)).toBe(true);
  });

  it('ignores a non-JSON line', () => {
    const { client, captured } = withPending(7);
    feed(client, 'MCP server listening on stdio');

    expect(captured.resolved).toEqual([]);
    expect(client['pendingRequests'].has(7)).toBe(true);
  });

  it('ignores a notification with no id', () => {
    const { client, captured } = withPending(7);
    feed(client, JSON.stringify({ method: 'notifications/message', params: {} }));

    expect(captured.resolved).toEqual([]);
    expect(client['pendingRequests'].has(7)).toBe(true);
  });

  it('ignores a response whose id matches no pending request', () => {
    const { client, captured } = withPending(7);
    feed(client, JSON.stringify({ id: 99, result: 'stray' }));

    expect(captured.resolved).toEqual([]);
    expect(client['pendingRequests'].has(7)).toBe(true);
  });

  it('resolves an undefined result rather than treating it as an error', () => {
    const { client, captured } = withPending(7);
    feed(client, JSON.stringify({ id: 7 }));

    expect(captured.resolved).toEqual([undefined]);
    expect(captured.rejected).toEqual([]);
  });

  it('settles only the addressed request when several are pending', () => {
    const client = new MCPClient();
    const hits: number[] = [];
    for (const id of [1, 2, 3]) {
      client['pendingRequests'].set(id, {
        resolve: () => hits.push(id),
        reject: () => hits.push(-id),
      });
    }

    feed(client, JSON.stringify({ id: 2, result: 'ok' }));

    expect(hits).toEqual([2]);
    expect(client['pendingRequests'].has(1)).toBe(true);
    expect(client['pendingRequests'].has(3)).toBe(true);
  });
});
