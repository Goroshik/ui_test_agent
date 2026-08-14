import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';

const existsSync = vi.fn<(path: string) => boolean>();
const readFile = vi.fn<(path: string, encoding: string) => Promise<string>>();
const readdir = vi.fn<(path: string) => Promise<string[]>>();
const stat = vi.fn<(path: string) => Promise<{ mtimeMs: number }>>();

vi.mock('fs', () => ({ existsSync: (path: string): boolean => existsSync(path) }));
vi.mock('fs/promises', () => ({
  readFile: (path: string, encoding: string): Promise<string> => readFile(path, encoding),
  readdir: (path: string): Promise<string[]> => readdir(path),
  stat: (path: string): Promise<{ mtimeMs: number }> => stat(path),
}));

const { TaskVerificationAgent, truncateSnapshot } = await import('./task-verification-agent.js');

interface ChatRequest {
  model: string;
  temperature: number;
  messages: Array<{ role: string; content: unknown }>;
}

const create = vi.fn<(req: ChatRequest) => Promise<unknown>>();

function stubClient(): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function agent(): InstanceType<typeof TaskVerificationAgent> {
  return new TaskVerificationAgent(stubClient(), 'test-model');
}

/** Makes the LLM answer with `content`. */
function respondWith(content: string | null): void {
  create.mockResolvedValue({ choices: [{ message: { content } }] });
}

function lastRequest(): ChatRequest {
  const call = create.mock.calls[0];
  if (!call) throw new Error('the model was never called');
  return call[0];
}

/** The single user-message body sent to the model. */
function userContent(): string {
  const message = lastRequest().messages.find((m) => m.role === 'user');
  if (typeof message?.content !== 'string') throw new Error('user content is not plain text');
  return message.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // Default: nothing on disk, so only an explicitly passed snapshot is used.
  existsSync.mockReturnValue(false);
  respondWith('{"success": true, "reason": "done"}');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('truncateSnapshot', () => {
  it('leaves a snapshot shorter than the limit untouched', () => {
    expect(truncateSnapshot('short', 100)).toBe('short');
  });

  it('leaves a snapshot exactly at the limit untouched', () => {
    const text = 'x'.repeat(50);
    expect(truncateSnapshot(text, 50)).toBe(text);
  });

  it('keeps the head and the tail of an over-long snapshot', () => {
    const text = `${'a'.repeat(60)}${'b'.repeat(60)}`;
    const result = truncateSnapshot(text, 40);

    expect(result.startsWith('a'.repeat(20))).toBe(true);
    expect(result.endsWith('b'.repeat(20))).toBe(true);
  });

  it('reports how many characters it dropped', () => {
    expect(truncateSnapshot('x'.repeat(100), 40)).toContain('[60 chars omitted]');
  });

  it('never grows the payload beyond the limit plus the marker', () => {
    const result = truncateSnapshot('x'.repeat(10_000), 100);
    expect(result.length).toBeLessThan(200);
  });
});

describe('TaskVerificationAgent.verify — input', () => {
  it('sends the ARIA snapshot as plain text, never as an image', async () => {
    await agent().verify('log in', 'Page URL: /home\n- heading "Welcome"');

    expect(userContent()).toContain('Page URL: /home');
    expect(userContent()).toContain('log in');
    expect(JSON.stringify(lastRequest())).not.toContain('image_url');
  });

  it('uses the configured model', async () => {
    await agent().verify('task', 'snapshot');
    expect(lastRequest().model).toBe('test-model');
  });

  it('truncates an over-long snapshot before sending it', async () => {
    await agent().verify('task', 'y'.repeat(80_000));
    expect(userContent()).toContain('chars omitted');
    expect(userContent().length).toBeLessThan(30_000);
  });

  it('fails without calling the model when no snapshot exists anywhere', async () => {
    const result = await agent().verify('task', null);

    expect(result).toEqual({
      success: false,
      reason: 'ARIA snapshot not found — cannot verify the result',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only snapshot as absent', async () => {
    const result = await agent().verify('task', '   \n  ');

    expect(result.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('TaskVerificationAgent.verify — disk fallback', () => {
  beforeEach(() => {
    existsSync.mockReturnValue(true);
  });

  it('reads the newest saved snapshot when none is passed in', async () => {
    readdir.mockResolvedValue(['001-old.txt', '002-new.txt']);
    stat.mockImplementation((path: string) =>
      Promise.resolve({ mtimeMs: path.includes('002-new') ? 2000 : 1000 }),
    );
    readFile.mockResolvedValue('- heading "Saved page"');

    await agent().verify('task');

    expect(readFile.mock.calls[0]?.[0]).toContain('002-new.txt');
    expect(userContent()).toContain('Saved page');
  });

  it('ignores files that are not snapshots', async () => {
    readdir.mockResolvedValue(['shot.png', 'notes.json']);

    const result = await agent().verify('task');

    expect(result.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails gracefully when the snapshot directory is empty', async () => {
    readdir.mockResolvedValue([]);

    await expect(agent().verify('task')).resolves.toEqual({
      success: false,
      reason: 'ARIA snapshot not found — cannot verify the result',
    });
  });

  it('fails gracefully when the newest snapshot cannot be read', async () => {
    readdir.mockResolvedValue(['001.txt']);
    stat.mockResolvedValue({ mtimeMs: 1 });
    readFile.mockRejectedValue(new Error('EACCES'));

    const result = await agent().verify('task');

    expect(result.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('prefers an explicitly passed snapshot over anything on disk', async () => {
    readdir.mockResolvedValue(['001.txt']);
    stat.mockResolvedValue({ mtimeMs: 1 });
    readFile.mockResolvedValue('from disk');

    await agent().verify('task', 'from memory');

    expect(userContent()).toContain('from memory');
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('TaskVerificationAgent.verify — response parsing', () => {
  it('reports success straight from the JSON body', async () => {
    respondWith('{"success": true, "reason": "page loaded"}');

    await expect(agent().verify('task', 'snapshot')).resolves.toEqual({
      success: true,
      reason: 'page loaded',
    });
  });

  it('reports failure straight from the JSON body', async () => {
    respondWith('{"success": false, "reason": "form was not submitted"}');

    await expect(agent().verify('task', 'snapshot')).resolves.toEqual({
      success: false,
      reason: 'form was not submitted',
    });
  });

  it('strips markdown fences around the JSON', async () => {
    respondWith('```json\n{"success": true, "reason": "ok"}\n```');

    await expect(agent().verify('task', 'snapshot')).resolves.toEqual({
      success: true,
      reason: 'ok',
    });
  });

  it('coerces a non-boolean success field', async () => {
    respondWith('{"success": "yes", "reason": "ok"}');
    await expect(agent().verify('task', 'snapshot')).resolves.toHaveProperty('success', true);
  });

  it('defaults a missing reason to an empty string', async () => {
    respondWith('{"success": true}');

    await expect(agent().verify('task', 'snapshot')).resolves.toEqual({
      success: true,
      reason: '',
    });
  });

  it('treats an unparseable answer as a failure, quoting it back', async () => {
    respondWith('I think it worked?');

    const result = await agent().verify('task', 'snapshot');

    expect(result.success).toBe(false);
    expect(result.reason).toContain('I think it worked?');
  });

  it('treats an empty answer as a failure', async () => {
    respondWith(null);
    await expect(agent().verify('task', 'snapshot')).resolves.toHaveProperty('success', false);
  });
});
