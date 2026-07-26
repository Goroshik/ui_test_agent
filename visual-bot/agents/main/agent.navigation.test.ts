import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';

/**
 * _injectPostNavigationContext pulls stored page context out of registry-context;
 * that lookup is mocked so the test controls whether context exists.
 */
let storedContext: string | null = null;

vi.mock('../../registry-context.js', () => ({
  getComponentContextForUrl: (): Promise<string | null> => Promise.resolve(storedContext),
  getPageSummary: (): Promise<string> => Promise.resolve(''),
  getRegistryPages: (): Promise<unknown[]> => Promise.resolve([]),
  invalidateRegistryCache: (): void => undefined,
  toolGetPageComponents: (): Promise<string> => Promise.resolve(''),
  toolSearchComponents: (): Promise<string> => Promise.resolve(''),
}));

const { Agent } = await import('./agent.js');

type Message = OpenAI.Chat.ChatCompletionMessageParam;

beforeEach(() => {
  storedContext = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Agent._injectPostNavigationContext', () => {
  function makeAgent(): InstanceType<typeof Agent> {
    return new Agent({} as unknown as OpenAI);
  }

  async function inject(
    name: string,
    args: Record<string, unknown>,
    isToolError = false,
    lastPageUrl: string | null = null,
  ): Promise<Message[]> {
    const agent = makeAgent();
    if (lastPageUrl !== null) agent['lastPageUrl'] = lastPageUrl;
    const messages: Message[] = [];
    await agent['_injectPostNavigationContext']({ id: 'c1', name, args }, isToolError, messages);
    return messages;
  }

  it('injects stored context after a successful navigation', async () => {
    storedContext = 'login form: email, password, submit';
    const messages = await inject('browser_navigate', { url: 'https://app.test/login' });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toContain('[Stored page context for https://app.test/login]');
    expect(messages[0]?.content).toContain('login form: email, password, submit');
  });

  it('does nothing for a tool other than browser_navigate', async () => {
    storedContext = 'some context';
    expect(await inject('browser_click', { url: 'https://app.test/login' })).toEqual([]);
  });

  it('does nothing when the navigation errored', async () => {
    storedContext = 'some context';
    expect(await inject('browser_navigate', { url: 'https://app.test/login' }, true)).toEqual([]);
  });

  it('falls back to the last known page url when the call has none', async () => {
    storedContext = 'ctx';
    const messages = await inject('browser_navigate', {}, false, 'https://app.test/fallback');

    expect(messages[0]?.content).toContain('https://app.test/fallback');
  });

  it('does nothing when neither the args nor the agent know a url', async () => {
    storedContext = 'ctx';
    expect(await inject('browser_navigate', {})).toEqual([]);
  });

  it('ignores a non-string url argument and falls back', async () => {
    storedContext = 'ctx';
    const messages = await inject('browser_navigate', { url: 42 }, false, 'https://app.test/fb');

    expect(messages[0]?.content).toContain('https://app.test/fb');
  });

  it('does nothing when there is no stored context for the url', async () => {
    storedContext = null;
    expect(await inject('browser_navigate', { url: 'https://app.test/unknown' })).toEqual([]);
  });

  it('treats empty stored context as nothing to inject', async () => {
    storedContext = '';
    expect(await inject('browser_navigate', { url: 'https://app.test/login' })).toEqual([]);
  });
});
