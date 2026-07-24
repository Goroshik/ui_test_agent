import { describe, it, expect, vi, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { VisualDiff } from './visual-diff.js';
import type { DiffResult } from './utils.js';

/** VisualDiff only calls chat.completions.create on the client. */
function makeDiff(create: (body: unknown) => Promise<unknown>): VisualDiff {
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return new VisualDiff(client, 'test-model');
}

function replying(content: string | null): VisualDiff {
  return makeDiff(() => Promise.resolve({ choices: [{ message: { content } }] }));
}

const compare = (
  diff: VisualDiff,
  oldDesc = 'old page',
  newDesc = 'new page',
): Promise<DiffResult> => diff['_compareDescriptions'](oldDesc, newDesc, 'navigate-home', '');

describe('VisualDiff._compareDescriptions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a change when the model says so', async () => {
    const result = await compare(replying('{"changed": true, "summary": "header moved"}'));
    expect(result).toEqual({ changed: true, summary: 'header moved' });
  });

  it('reports no change when the model says so', async () => {
    const result = await compare(replying('{"changed": false, "summary": "identical"}'));
    expect(result).toEqual({ changed: false, summary: 'identical' });
  });

  it('extracts JSON embedded in prose', async () => {
    const result = await compare(replying('Sure:\n{"changed": true, "summary": "moved"}\nDone.'));
    expect(result).toEqual({ changed: true, summary: 'moved' });
  });

  it('treats a non-JSON reply as changed, keeping the text as the summary', async () => {
    const result = await compare(replying('The pages look quite different to me'));
    expect(result).toEqual({
      changed: true,
      summary: 'The pages look quite different to me',
    });
  });

  it('treats an empty reply as changed with a placeholder summary', async () => {
    const result = await compare(replying(''));
    expect(result).toEqual({ changed: true, summary: 'Non-JSON response; treated as changed.' });
  });

  it('treats a null reply content as changed', async () => {
    const result = await compare(replying(null));
    expect(result.changed).toBe(true);
  });

  it('short-circuits to changed when the old description is empty', async () => {
    const create = vi.fn(() => Promise.resolve({ choices: [] }));
    const result = await compare(makeDiff(create), '', 'new page');

    expect(result).toEqual({
      changed: true,
      summary: 'Could not describe one or both screenshots; treated as changed.',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('short-circuits to changed when the new description is empty', async () => {
    const create = vi.fn(() => Promise.resolve({ choices: [] }));
    const result = await compare(makeDiff(create), 'old page', '');

    expect(result.changed).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('short-circuits when both descriptions are empty', async () => {
    const create = vi.fn(() => Promise.resolve({ choices: [] }));
    await compare(makeDiff(create), '', '');
    expect(create).not.toHaveBeenCalled();
  });

  it('treats an LLM failure as changed and names the cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await compare(makeDiff(() => Promise.reject(new Error('model offline'))));

    expect(result).toEqual({ changed: true, summary: 'Compare unavailable: model offline' });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('passes the key and both descriptions to the model', async () => {
    const create = vi.fn((_body: unknown) =>
      Promise.resolve({ choices: [{ message: { content: '{"changed":false,"summary":"s"}' } }] }),
    );
    const diff = makeDiff(create);
    await diff['_compareDescriptions']('OLD TEXT', 'NEW TEXT', 'my-key', 'watch the header');

    const body = create.mock.calls[0]?.[0] as
      | { messages: Array<{ role: string; content: string }> }
      | undefined;
    const userMessage = body?.messages.find((m) => m.role === 'user');

    expect(userMessage?.content).toContain('my-key');
    expect(userMessage?.content).toContain('OLD TEXT');
    expect(userMessage?.content).toContain('NEW TEXT');
  });

  it('includes the attention guidance in the system prompt', async () => {
    const create = vi.fn((_body: unknown) =>
      Promise.resolve({ choices: [{ message: { content: '{"changed":false,"summary":"s"}' } }] }),
    );
    const diff = makeDiff(create);
    await diff['_compareDescriptions']('a', 'b', 'k', 'IGNORE THE CLOCK');

    const body = create.mock.calls[0]?.[0] as
      | { messages: Array<{ role: string; content: string }> }
      | undefined;
    const systemMessage = body?.messages.find((m) => m.role === 'system');

    expect(systemMessage?.content).toContain('IGNORE THE CLOCK');
  });

  it('trims whitespace around the model reply before parsing', async () => {
    const result = await compare(replying('   {"changed": true, "summary": "x"}   '));
    expect(result).toEqual({ changed: true, summary: 'x' });
  });
});
