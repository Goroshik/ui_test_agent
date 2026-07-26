import { describe, it, expect, vi, afterEach } from 'vitest';
import { Screenshotter } from './screenshotter.js';
import type { MCPClient } from './mcp-client.js';

type ScreenshotResult = Awaited<ReturnType<MCPClient['screenshot']>>;

/** Minimal MCPClient stub: capture() only ever calls screenshot(). */
function stubClient(impl: () => Promise<ScreenshotResult>): MCPClient {
  return { screenshot: impl } as unknown as MCPClient;
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

describe('Screenshotter.detectExt', () => {
  const detectExt = (buf: Buffer): string => new Screenshotter()['detectExt'](buf);

  it('detects a JPEG from its SOI magic bytes', () => {
    expect(detectExt(JPEG_MAGIC)).toBe('.jpg');
  });

  it('detects a PNG from its signature bytes', () => {
    expect(detectExt(PNG_MAGIC)).toBe('.png');
  });

  it('falls back to .png for an unrecognized buffer', () => {
    expect(detectExt(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe('.png');
  });

  it('falls back to .png for an empty buffer', () => {
    expect(detectExt(Buffer.alloc(0))).toBe('.png');
  });

  it('does not mistake a near-miss JPEG prefix for a JPEG', () => {
    // Third byte differs from 0xff, so the JPEG branch must not fire.
    expect(detectExt(Buffer.from([0xff, 0xd8, 0x00]))).toBe('.png');
  });

  it('does not mistake a near-miss PNG prefix for a detected PNG', () => {
    // Falls through to the default, which is also .png — assert it still returns it.
    expect(detectExt(Buffer.from([0x89, 0x50, 0x4e, 0x00]))).toBe('.png');
  });
});

describe('Screenshotter.buildComparisonKey (via pickStableArg)', () => {
  const key = (tool: string, args: Record<string, unknown>): string =>
    new Screenshotter().buildComparisonKey(tool, args);

  it('strips the browser_ prefix and dasherizes the action', () => {
    expect(key('browser_select_option', {})).toBe('select-option');
  });

  it('prefers url and strips the scheme', () => {
    expect(key('browser_navigate', { url: 'https://example.com/a' })).toBe(
      'navigate-example.com_a',
    );
  });

  it('lowercases and replaces unsafe characters', () => {
    expect(key('browser_click', { element: 'Submit Button!' })).toBe(
      'click-submit_button_',
    );
  });

  it('joins at most two stable values in priority order', () => {
    // url, selector, element, key are all present — only the first two are used.
    const result = key('browser_click', {
      url: 'https://a.com',
      selector: '#btn',
      element: 'Submit',
      key: 'k',
    });
    expect(result).toBe('click-a.com-_btn');
  });

  it('encodes a numeric index argument', () => {
    expect(key('browser_click', { index: 3 })).toBe('click-index-3');
  });

  it('encodes a numeric time argument', () => {
    expect(key('browser_wait', { time: 500 })).toBe('wait-time-500');
  });

  it('encodes a non-empty values array', () => {
    expect(key('browser_select_option', { values: ['a', 'b'] })).toBe(
      'select-option-values-a_b',
    );
  });

  it('ignores an empty values array', () => {
    expect(key('browser_select_option', { values: [] })).toBe('select-option');
  });

  it('deliberately ignores the volatile ref argument', () => {
    expect(key('browser_click', { ref: 'e123' })).toBe('click');
  });

  it('falls back to text only when no stable value exists', () => {
    expect(key('browser_type', { text: 'hello' })).toBe('type-hello');
  });

  it('does not use the text fallback when a stable value is present', () => {
    expect(key('browser_type', { element: 'Field', text: 'hello' })).toBe('type-field');
  });

  it('falls back to value when text is absent', () => {
    expect(key('browser_fill', { value: 'abc' })).toBe('fill-abc');
  });

  it('ignores whitespace-only and non-string candidates', () => {
    expect(key('browser_click', { element: '   ', selector: 42 })).toBe('click');
  });

  it('produces a stable key across differing refs for the same element', () => {
    const a = key('browser_click', { ref: 'e1', element: 'Submit' });
    const b = key('browser_click', { ref: 'e999', element: 'Submit' });
    expect(a).toBe(b);
  });
});

describe('Screenshotter.capture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the MCP result has no content', async () => {
    const shot = new Screenshotter();
    const result = await shot.capture(1, 'browser_click', {}, stubClient(() =>
      Promise.resolve({ content: undefined } as unknown as ScreenshotResult),
    ));
    expect(result).toBeNull();
  });

  it('returns null when the content carries no image part', async () => {
    const shot = new Screenshotter();
    const result = await shot.capture(1, 'browser_click', {}, stubClient(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'no picture here' }],
      } as unknown as ScreenshotResult),
    ));
    expect(result).toBeNull();
  });

  it('returns null when the image part has no data', async () => {
    const shot = new Screenshotter();
    const result = await shot.capture(1, 'browser_click', {}, stubClient(() =>
      Promise.resolve({
        content: [{ type: 'image' }],
      } as unknown as ScreenshotResult),
    ));
    expect(result).toBeNull();
  });

  it('swallows an MCP failure and returns null', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const shot = new Screenshotter();

    const result = await shot.capture(1, 'browser_click', {}, stubClient(() =>
      Promise.reject(new Error('mcp is down')),
    ));

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0]?.[0]).toContain('mcp is down');
  });
});
