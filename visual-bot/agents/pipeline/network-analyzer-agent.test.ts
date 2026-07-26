import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { NetworkAnalyzerAgent } from './network-analyzer-agent.js';

/** _filterRequests is pure and never touches the client. */
function filter(raw: string): string[] {
  const agent = new NetworkAnalyzerAgent({} as unknown as OpenAI, 'test-model');
  return agent['_filterRequests'](raw);
}

describe('NetworkAnalyzerAgent._filterRequests', () => {
  it('keeps a plain API GET request', () => {
    expect(filter('[GET] https://api.example.com/users')).toEqual([
      '[GET] https://api.example.com/users',
    ]);
  });

  // Every method the entry regex accepts.
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    it(`recognizes a ${method} request line`, () => {
      const line = `[${method}] https://api.example.com/thing`;
      expect(filter(line)).toEqual([line]);
    });
  }

  it('ignores an unsupported method', () => {
    expect(filter('[OPTIONS] https://api.example.com/users')).toEqual([]);
  });

  it('ignores lines that are not request entries', () => {
    expect(filter('console: hello\nsome random text')).toEqual([]);
  });

  it('requires the method marker at the start of the line', () => {
    expect(filter('prefix [GET] https://api.example.com/users')).toEqual([]);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(filter('    [GET] https://api.example.com/users   ')).toEqual([
      '[GET] https://api.example.com/users',
    ]);
  });

  it('skips an entry with no URL', () => {
    expect(filter('[GET] not-a-url')).toEqual([]);
  });

  it('skips a non-http scheme', () => {
    expect(filter('[GET] ws://api.example.com/socket')).toEqual([]);
  });

  it('accepts a plain http URL', () => {
    expect(filter('[GET] http://api.example.com/users')).toEqual([
      '[GET] http://api.example.com/users',
    ]);
  });

  // A representative slice of NOISE_DOMAINS.
  for (const domain of [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'analytics.google.com',
    'googletagmanager.com',
    'doubleclick.net',
    'google-analytics.com',
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
  ]) {
    it(`drops requests to the noise domain ${domain}`, () => {
      expect(filter(`[GET] https://${domain}/thing`)).toEqual([]);
    });
  }

  // A representative slice of NOISE_EXTENSIONS.
  for (const ext of ['js', 'css', 'woff', 'woff2', 'ttf', 'png', 'jpg', 'svg', 'ico', 'map']) {
    it(`drops a static .${ext} asset`, () => {
      expect(filter(`[GET] https://api.example.com/assets/app.${ext}`)).toEqual([]);
    });
  }

  it('drops a static asset even when a query string follows the extension', () => {
    expect(filter('[GET] https://api.example.com/app.js?v=3')).toEqual([]);
  });

  it('keeps an API path that merely contains an extension-like substring', () => {
    const line = '[GET] https://api.example.com/jsonapi/users';
    expect(filter(line)).toEqual([line]);
  });

  it('truncates a very long query string', () => {
    const longQuery = 'x'.repeat(120);
    const result = filter(`[GET] https://api.example.com/search?${longQuery}`);
    expect(result).toEqual(['[GET] https://api.example.com/search?...']);
  });

  it('leaves a short query string intact', () => {
    const line = '[GET] https://api.example.com/search?q=hi';
    expect(filter(line)).toEqual([line]);
  });

  it('filters a multi-line log, keeping only real API calls', () => {
    const raw = [
      '[GET] https://fonts.googleapis.com/css?family=Roboto',
      '[GET] https://api.example.com/users',
      'random log noise',
      '[POST] https://api.example.com/login',
      '[GET] https://api.example.com/static/main.css',
    ].join('\n');

    expect(filter(raw)).toEqual([
      '[GET] https://api.example.com/users',
      '[POST] https://api.example.com/login',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(filter('')).toEqual([]);
  });

  it('preserves the order of kept requests', () => {
    const raw = [
      '[GET] https://api.example.com/a',
      '[POST] https://api.example.com/b',
      '[PUT] https://api.example.com/c',
    ].join('\n');

    expect(filter(raw)).toEqual([
      '[GET] https://api.example.com/a',
      '[POST] https://api.example.com/b',
      '[PUT] https://api.example.com/c',
    ]);
  });
});
