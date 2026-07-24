import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { Agent } from './agent.js';
import type { ActionData, DomElementAttrs } from '../../pipeline/types.js';

/** Agent builds its own MCPClient/Screenshotter; tests swap them per case. */
function makeAgent(): Agent {
  return new Agent({} as unknown as OpenAI);
}

function attrs(overrides: Partial<DomElementAttrs> = {}): DomElementAttrs {
  return {
    tag: 'button',
    testid: null,
    id: null,
    name: null,
    type: null,
    role: null,
    ariaLabel: null,
    classes: null,
    text: null,
    ...overrides,
  };
}

interface CaptureCtx {
  toolName: string;
  toolArgs: Record<string, unknown>;
  snapshotText: string;
  isInteraction: boolean;
  screenshotsEnabled: boolean;
  snapshotsEnabled: boolean;
}

function ctx(overrides: Partial<CaptureCtx> = {}): CaptureCtx {
  return {
    toolName: 'browser_click',
    toolArgs: {},
    snapshotText: '',
    isInteraction: false,
    screenshotsEnabled: false,
    snapshotsEnabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Agent._extractAriaFromLine', () => {
  const extract = (
    line: string,
  ): { ariaRole: string | null; ariaName: string | null } | null =>
    makeAgent()['_extractAriaFromLine'](line);

  it('parses a role and quoted accessible name', () => {
    expect(extract('  - button "Submit" [ref=e12]')).toEqual({
      ariaRole: 'button',
      ariaName: 'Submit',
    });
  });

  it('lowercases the role', () => {
    expect(extract('  - Button "Submit" [ref=e1]')?.ariaRole).toBe('button');
  });

  it('preserves the case of the accessible name', () => {
    expect(extract('  - button "Sign In Now" [ref=e1]')?.ariaName).toBe('Sign In Now');
  });

  it('parses a hyphenated role', () => {
    expect(extract('  - menu-item "Open" [ref=e1]')?.ariaRole).toBe('menu-item');
  });

  it('parses a role with no accessible name', () => {
    expect(extract('  - textbox [ref=e7]')).toEqual({ ariaRole: 'textbox', ariaName: null });
  });

  it('prefers the named pattern when both could match', () => {
    expect(extract('  - link "Home" [ref=e2]')).toEqual({ ariaRole: 'link', ariaName: 'Home' });
  });

  it('returns null for a line with no role', () => {
    expect(extract('  - [ref=e1]')).toBeNull();
  });

  it('returns null for an unrelated line', () => {
    expect(extract('Page URL: https://app.test/login')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(extract('')).toBeNull();
  });

  it('returns null for an empty quoted name', () => {
    // The named pattern needs at least one character inside the quotes, and the
    // no-name pattern needs whitespace immediately before "[" — the empty ""
    // sits in between, so neither matches and the role is lost entirely.
    expect(extract('  - button "" [ref=e1]')).toBeNull();
  });

  it('ignores a role that does not start with a letter', () => {
    expect(extract('  - 123 "Nope" [ref=e1]')).toBeNull();
  });
});

describe('Agent._getScreenshotBase64', () => {
  function agentWithScreenshot(result: unknown): Agent {
    const agent = makeAgent();
    agent['mcp'] = { screenshot: () => Promise.resolve(result) } as never;
    return agent;
  }

  const get = (result: unknown): Promise<string | undefined> =>
    agentWithScreenshot(result)['_getScreenshotBase64']();

  it('returns the base64 payload from an image part', async () => {
    await expect(get({ content: [{ type: 'image', data: 'AAAB' }] })).resolves.toBe('AAAB');
  });

  it('accepts an image_url part carrying a url field', async () => {
    await expect(get({ content: [{ type: 'image_url', url: 'BBBB' }] })).resolves.toBe('BBBB');
  });

  it('strips a data-url prefix', async () => {
    const dataUrl = 'data:image/png;base64,PAYLOAD';
    await expect(get({ content: [{ type: 'image', data: dataUrl }] })).resolves.toBe('PAYLOAD');
  });

  it('returns undefined when the result is null', async () => {
    await expect(get(null)).resolves.toBeUndefined();
  });

  it('returns undefined when the result has no content', async () => {
    await expect(get({})).resolves.toBeUndefined();
  });

  it('returns undefined when no part is an image', async () => {
    await expect(get({ content: [{ type: 'text', text: 'nope' }] })).resolves.toBeUndefined();
  });

  it('returns undefined when the image part carries no data or url', async () => {
    await expect(get({ content: [{ type: 'image' }] })).resolves.toBeUndefined();
  });

  it('returns undefined for an empty base64 payload', async () => {
    await expect(get({ content: [{ type: 'image', data: '' }] })).resolves.toBeUndefined();
  });

  it('returns undefined when a data url has an empty payload', async () => {
    await expect(
      get({ content: [{ type: 'image', data: 'data:image/png;base64,' }] }),
    ).resolves.toBeUndefined();
  });

  it('picks the first image among mixed parts', async () => {
    const result = {
      content: [
        { type: 'text', text: 'preamble' },
        { type: 'image', data: 'FIRST' },
        { type: 'image', data: 'SECOND' },
      ],
    };
    await expect(get(result)).resolves.toBe('FIRST');
  });
});

describe('Agent._enrichElementFromDom', () => {
  function agentReturning(result: unknown, rejects = false): Agent {
    const agent = makeAgent();
    agent['mcp'] = {
      evaluateAttrsOnRef: () =>
        rejects ? Promise.reject(new Error('eval failed')) : Promise.resolve(result),
    } as never;
    return agent;
  }

  const enrich = (
    agent: Agent,
    action: ActionData,
    ref = 'e1',
  ): Promise<void> => agent['_enrichElementFromDom'](action, ref);

  function action(overrides: Partial<ActionData> = {}): ActionData {
    return {
      type: 'click',
      description: 'click Submit',
      element: { ariaName: 'Submit', ref: 'e1' },
      ...overrides,
    };
  }

  it('does nothing when the action has no element', async () => {
    const withoutElement: ActionData = { type: 'click', description: 'd' };
    await enrich(agentReturning(attrs()), withoutElement);
    expect(withoutElement.element).toBeUndefined();
  });

  it('attaches the full attrs payload', async () => {
    const a = action();
    const payload = attrs({ tag: 'button', text: 'Submit' });
    await enrich(agentReturning(payload), a);

    expect(a.element?.attrs).toEqual(payload);
  });

  it('copies a testid onto the element', async () => {
    const a = action();
    await enrich(agentReturning(attrs({ testid: 'submit-btn' })), a);
    expect(a.element?.testid).toBe('submit-btn');
  });

  it('does not set a testid when the DOM has none', async () => {
    const a = action();
    await enrich(agentReturning(attrs({ testid: null })), a);
    expect(a.element?.testid).toBeUndefined();
  });

  it('fills a missing tagName from the DOM tag', async () => {
    const a = action();
    await enrich(agentReturning(attrs({ tag: 'input' })), a);
    expect(a.element?.tagName).toBe('input');
  });

  it('does not overwrite an existing tagName', async () => {
    const a = action({ element: { ariaName: 'Submit', ref: 'e1', tagName: 'button' } });
    await enrich(agentReturning(attrs({ tag: 'input' })), a);
    expect(a.element?.tagName).toBe('button');
  });

  it('fills missing text from the DOM', async () => {
    const a = action();
    await enrich(agentReturning(attrs({ text: 'Send it' })), a);
    expect(a.element?.text).toBe('Send it');
  });

  it('does not overwrite existing text', async () => {
    const a = action({ element: { ariaName: 'Submit', ref: 'e1', text: 'kept' } });
    await enrich(agentReturning(attrs({ text: 'from dom' })), a);
    expect(a.element?.text).toBe('kept');
  });

  it('leaves text alone when the DOM text is empty', async () => {
    const a = action();
    await enrich(agentReturning(attrs({ text: '' })), a);
    expect(a.element?.text).toBeUndefined();
  });

  it('leaves the element untouched when evaluate returns null', async () => {
    const a = action();
    await enrich(agentReturning(null), a);
    expect(a.element?.attrs).toBeUndefined();
  });

  it('swallows an evaluate failure', async () => {
    const a = action();
    await expect(enrich(agentReturning(null, true), a)).resolves.toBeUndefined();
    expect(a.element?.attrs).toBeUndefined();
  });
});

describe('Agent._captureIfPageChanged', () => {
  /** Replaces screenshot fetching so no MCP call is made. */
  function agentForCapture(screenshotPath?: string): Agent {
    const agent = makeAgent();
    agent['screenshotter'] = {
      saveSnapshot: () => Promise.resolve('/tmp/snap.txt'),
      buildFilename: () => 'file.txt',
      buildComparisonKey: () => 'key',
    } as never;
    agent['_fetchAndSaveScreenshot'] = (): Promise<string | undefined> =>
      Promise.resolve(screenshotPath);
    return agent;
  }

  const capture = (
    agent: Agent,
    context: CaptureCtx,
  ): Promise<{ urlChanged: boolean; screenshotPath?: string }> =>
    agent['_captureIfPageChanged'](context);

  it('reports no url change when the snapshot carries no page url', async () => {
    const result = await capture(agentForCapture(), ctx());
    expect(result).toEqual({ urlChanged: false });
  });

  it('detects a url change from the snapshot text', async () => {
    const agent = agentForCapture();
    const result = await capture(
      agent,
      ctx({ snapshotText: 'Page URL: https://app.test/home' }),
    );
    expect(result.urlChanged).toBe(true);
  });

  it('records the new url when screenshots are disabled', async () => {
    const agent = agentForCapture();
    await capture(agent, ctx({ snapshotText: 'Page URL: https://app.test/home' }));
    expect(agent['lastPageUrl']).toBe('https://app.test/home');
  });

  it('does not take a screenshot when screenshots are disabled', async () => {
    const agent = agentForCapture('/tmp/shot.webp');
    const result = await capture(
      agent,
      ctx({ snapshotText: 'Page URL: https://app.test/home', screenshotsEnabled: false }),
    );
    expect(result.screenshotPath).toBeUndefined();
  });

  it('skips the screenshot when neither the url nor the ui state changed', async () => {
    const agent = agentForCapture('/tmp/shot.webp');
    const result = await capture(agent, ctx({ screenshotsEnabled: true }));
    expect(result).toEqual({ urlChanged: false });
  });

  it('takes a screenshot when the url changed', async () => {
    const agent = agentForCapture('/tmp/shot.webp');
    const result = await capture(
      agent,
      ctx({ snapshotText: 'Page URL: https://app.test/home', screenshotsEnabled: true }),
    );
    expect(result).toEqual({ urlChanged: true, screenshotPath: '/tmp/shot.webp' });
  });

  it('takes a screenshot when an interaction changed the ui state', async () => {
    const agent = agentForCapture('/tmp/shot.webp');
    const result = await capture(
      agent,
      ctx({ snapshotText: 'some new ui', isInteraction: true, screenshotsEnabled: true }),
    );
    expect(result.screenshotPath).toBe('/tmp/shot.webp');
  });

  it('does not treat an unchanged snapshot as a ui state change', async () => {
    const agent = agentForCapture('/tmp/shot.webp');
    agent['lastCapturedSnapshot'] = 'same';
    const result = await capture(
      agent,
      ctx({ snapshotText: 'same', isInteraction: true, screenshotsEnabled: true }),
    );
    expect(result.screenshotPath).toBeUndefined();
  });

  it('omits the screenshot path when saving fails', async () => {
    const agent = agentForCapture(undefined);
    const result = await capture(
      agent,
      ctx({ snapshotText: 'Page URL: https://app.test/home', screenshotsEnabled: true }),
    );
    expect(result).toEqual({ urlChanged: true });
  });

  it('writes a snapshot file when snapshots are enabled', async () => {
    const agent = agentForCapture();
    const saveSnapshot = vi.fn(() => Promise.resolve('/tmp/snap.txt'));
    agent['screenshotter'] = {
      saveSnapshot,
      buildFilename: () => 'f.txt',
      buildComparisonKey: () => 'k',
    } as never;

    await capture(agent, ctx({ snapshotsEnabled: true, snapshotText: 'text' }));
    expect(saveSnapshot).toHaveBeenCalledOnce();
  });

  it('advances the step counter', async () => {
    const agent = agentForCapture();
    const before = agent['stepCount'];
    await capture(agent, ctx());
    expect(agent['stepCount']).toBe(before + 1);
  });
});

describe('Agent._handleRegistryTool', () => {
  type Message = OpenAI.Chat.ChatCompletionMessageParam;

  async function handle(name: string, args: Record<string, unknown>): Promise<Message[]> {
    const messages: Message[] = [];
    await makeAgent()['_handleRegistryTool']({ id: 'call_1', name, args }, messages);
    return messages;
  }

  it('answers registry_get_page_components with a tool message', async () => {
    const messages = await handle('registry_get_page_components', { page: '/login' });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('tool');
    expect(typeof messages[0]?.content).toBe('string');
  });

  it('tags the reply with the originating tool call id', async () => {
    const messages = await handle('registry_get_page_components', { page: '/login' });
    expect(messages[0]).toMatchObject({ tool_call_id: 'call_1' });
  });

  it('tolerates a non-string page argument', async () => {
    const messages = await handle('registry_get_page_components', { page: 42 });
    expect(messages).toHaveLength(1);
  });

  it('routes anything else to the component search', async () => {
    const messages = await handle('registry_search_components', { query: 'submit' });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('tool');
  });

  it('tolerates a missing query argument', async () => {
    const messages = await handle('registry_search_components', {});
    expect(messages).toHaveLength(1);
  });

  it('reports a registry failure as the tool result instead of throwing', async () => {
    const agent = makeAgent();
    const messages: Message[] = [];
    // Force the lookup to throw by handing it a page value whose getter explodes.
    const args = {
      get page(): string {
        throw new Error('registry exploded');
      },
    };

    await agent['_handleRegistryTool']({ id: 'call_9', name: 'registry_get_page_components', args }, messages);

    const content = messages[0]?.content;
    expect(typeof content).toBe('string');
    expect(content as string).toContain('Registry error: registry exploded');
  });
});
