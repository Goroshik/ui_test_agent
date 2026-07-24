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
