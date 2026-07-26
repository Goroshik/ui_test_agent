import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { Agent } from './agent.js';

type Message = OpenAI.Chat.ChatCompletionMessageParam;
type AssistantMessage = OpenAI.Chat.ChatCompletionMessage;

const savedMaxIterations = process.env.MAX_ITERATIONS;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedMaxIterations === undefined) delete process.env.MAX_ITERATIONS;
  else process.env.MAX_ITERATIONS = savedMaxIterations;
});

/** An assistant message carrying one tool call. */
function withToolCall(name = 'browser_click'): AssistantMessage {
  return {
    role: 'assistant',
    content: null,
    refusal: null,
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name, arguments: '{}' } },
    ],
  };
}

/** An assistant message with prose and no tool calls — ends the loop. */
function finalMessage(content = 'all done'): AssistantMessage {
  return { role: 'assistant', content, refusal: null };
}

describe('Agent._runIterations', () => {
  interface Harness {
    agent: Agent;
    executed: number;
    requested: number;
  }

  /**
   * Drives the loop with a scripted sequence of assistant messages. Everything
   * below the loop (LLM call, tool execution, loop detection) is stubbed so the
   * test observes only the loop's own control flow.
   */
  function harness(script: AssistantMessage[], loopDetectedAt?: number): Harness {
    const agent = new Agent({} as unknown as OpenAI);
    const state = { executed: 0, requested: 0 };

    agent['_requestNextMessage'] = (): Promise<AssistantMessage> => {
      const next = script[state.requested] ?? finalMessage();
      state.requested++;
      return Promise.resolve(next);
    };
    agent['_executeToolCalls'] = (): Promise<void> => {
      state.executed++;
      return Promise.resolve();
    };
    agent['_checkAndLogLoop'] = (iteration: number): Promise<boolean> =>
      Promise.resolve(loopDetectedAt !== undefined && iteration >= loopDetectedAt);

    return {
      agent,
      get executed(): number {
        return state.executed;
      },
      get requested(): number {
        return state.requested;
      },
    };
  }

  const run = (agent: Agent, messages: Message[] = []): Promise<void> =>
    agent['_runIterations'](messages, [], 'test-model', {
      screenshotsEnabled: false,
      snapshotsEnabled: false,
    });

  /** Text of the pushback the loop injected, or '' when it injected none. */
  function pushbackText(messages: Message[]): string {
    const pushback = messages.find((m) => m.role === 'user')?.content;
    return typeof pushback === 'string' ? pushback : '';
  }

  /** Makes the loop believe the plan asked for `planned` clicks. */
  function expectPlan(agent: Agent, planned: number): void {
    agent['plannedToolCalls'] = { browser_click: planned };
  }

  it('pushes back instead of accepting a stop that left the plan unfinished', async () => {
    const h = harness([finalMessage('all done'), finalMessage('really done')]);
    expectPlan(h.agent, 1);
    const messages: Message[] = [];

    await run(h.agent, messages);

    // Asked twice: the first stop was rejected, the second accepted.
    expect(h.requested).toBe(2);
    expect(pushbackText(messages)).toContain('you have not finished the plan');
  });

  it('names the shortfall in the pushback', async () => {
    const h = harness([finalMessage(), finalMessage()]);
    expectPlan(h.agent, 3);
    const messages: Message[] = [];

    await run(h.agent, messages);

    expect(pushbackText(messages)).toContain('you performed 0');
  });

  it('pushes back at most once, so a stubborn model cannot loop forever', async () => {
    const h = harness(Array.from({ length: 6 }, () => finalMessage()));
    expectPlan(h.agent, 1);
    const messages: Message[] = [];

    await run(h.agent, messages);

    expect(h.requested).toBe(2);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('accepts the stop when the plan asked for nothing trackable', async () => {
    const h = harness([finalMessage()]);
    const messages: Message[] = [];

    await run(h.agent, messages);

    expect(h.requested).toBe(1);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('accepts the stop once the planned actions were performed', async () => {
    const h = harness([finalMessage()]);
    expectPlan(h.agent, 1);
    h.agent['performedToolCalls'] = { browser_click: 1 };
    const messages: Message[] = [];

    await run(h.agent, messages);

    expect(h.requested).toBe(1);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('stops as soon as the model returns no tool calls', async () => {
    const h = harness([finalMessage()]);
    await run(h.agent);

    expect(h.requested).toBe(1);
    expect(h.executed).toBe(0);
  });

  it('appends each assistant message to the transcript', async () => {
    const h = harness([finalMessage('done')]);
    const messages: Message[] = [];
    await run(h.agent, messages);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('assistant');
  });

  it('executes tool calls then continues to the next iteration', async () => {
    const h = harness([withToolCall(), withToolCall(), finalMessage()]);
    await run(h.agent);

    expect(h.executed).toBe(2);
    expect(h.requested).toBe(3);
  });

  it('honours MAX_ITERATIONS', async () => {
    process.env.MAX_ITERATIONS = '3';
    const h = harness([withToolCall(), withToolCall(), withToolCall(), withToolCall()]);
    await run(h.agent);

    expect(h.requested).toBe(3);
    expect(h.executed).toBe(3);
  });

  it('logs when the iteration cap is reached', async () => {
    process.env.MAX_ITERATIONS = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = harness([withToolCall()]);
    await run(h.agent);

    expect(log.mock.calls.flat().join(' ')).toContain('Max iterations reached');
  });

  it('breaks out when a loop is detected', async () => {
    const h = harness([withToolCall(), withToolCall(), withToolCall()], 1);
    await run(h.agent);

    expect(h.executed).toBe(1);
    expect(h.requested).toBe(1);
  });

  it('stops before the first request when a stop was already requested', async () => {
    const h = harness([withToolCall()]);
    h.agent['stopRequested'] = true;
    await run(h.agent);

    expect(h.requested).toBe(0);
  });

  it('reports the user-requested stop', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = harness([withToolCall()]);
    h.agent['stopRequested'] = true;
    await run(h.agent);

    expect(log.mock.calls.flat().join(' ')).toContain('stopped by user request');
  });

  it('stops mid-run once the stop flag is set', async () => {
    const h = harness([withToolCall(), withToolCall(), finalMessage()]);
    h.agent['_executeToolCalls'] = (): Promise<void> => {
      h.agent['stopRequested'] = true;
      return Promise.resolve();
    };
    await run(h.agent);

    expect(h.requested).toBe(1);
  });

  it('echoes assistant prose when the message has content', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = harness([finalMessage('here is my plan')]);
    await run(h.agent);

    expect(log.mock.calls.flat().join(' ')).toContain('here is my plan');
  });

  it('handles a tool-calling message that also carries content', async () => {
    const message = { ...withToolCall(), content: 'calling a tool now' } as AssistantMessage;
    const h = harness([message, finalMessage()]);
    await run(h.agent);

    expect(h.executed).toBe(1);
  });
});

describe('Agent._handleMcpToolCall', () => {
  interface Trace {
    began: number;
    ended: Array<boolean>;
    captured: number;
    persisted: number;
    injected: number;
  }

  function harness(options: {
    content?: string;
    isToolError?: boolean;
    hasCollector?: boolean;
    activeStep?: string | null;
  } = {}): { agent: Agent; trace: Trace } {
    const {
      content = 'tool output',
      isToolError = false,
      hasCollector = true,
      activeStep = 'step-001',
    } = options;

    const agent = new Agent({} as unknown as OpenAI);
    const trace: Trace = { began: 0, ended: [], captured: 0, persisted: 0, injected: 0 };

    if (hasCollector) agent['collector'] = {} as never;
    agent['activeStepId'] = activeStep;

    agent['_executeMcpTool'] = (): Promise<{
      result: unknown;
      isToolError: boolean;
      toolDurationMs: number;
    }> =>
      Promise.resolve({
        result: { content: [{ type: 'text', text: content }] },
        isToolError,
        toolDurationMs: 5,
      });
    agent['_beginCollectorStep'] = (): Promise<void> => {
      trace.began++;
      return Promise.resolve();
    };
    agent['_endCollectorStep'] = (isError: boolean): Promise<void> => {
      trace.ended.push(isError);
      return Promise.resolve();
    };
    agent['_readPostActionSnapshot'] = (): Promise<string> =>
      Promise.resolve('Page URL: https://app.test/home\n- button "Save"');
    agent['_captureArtifacts'] = (): Promise<string | undefined> => {
      trace.captured++;
      return Promise.resolve('/tmp/shot.webp');
    };
    agent['_persistStep'] = (): Promise<void> => {
      trace.persisted++;
      return Promise.resolve();
    };
    agent['_injectPostNavigationContext'] = (): Promise<void> => {
      trace.injected++;
      return Promise.resolve();
    };

    return { agent, trace };
  }

  const handle = (agent: Agent, name: string, messages: Message[]): Promise<void> =>
    agent['_handleMcpToolCall']({ id: 'c1', name, args: {} }, messages, {
      screenshotsEnabled: false,
      snapshotsEnabled: false,
    });

  it('pushes the tool result back into the transcript', async () => {
    const { agent } = harness({ content: 'clicked ok' });
    const messages: Message[] = [];
    await handle(agent, 'browser_click', messages);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'clicked ok' });
  });

  it('substitutes OK for empty tool output', async () => {
    const { agent } = harness({ content: '' });
    const messages: Message[] = [];
    await handle(agent, 'browser_click', messages);

    expect(messages[0]?.content).toBe('OK');
  });

  it('opens a collector step for an action tool', async () => {
    const { agent, trace } = harness();
    await handle(agent, 'browser_click', []);
    expect(trace.began).toBe(1);
  });

  it('does not open a collector step without a collector', async () => {
    const { agent, trace } = harness({ hasCollector: false });
    await handle(agent, 'browser_click', []);
    expect(trace.began).toBe(0);
  });

  it('does not open a collector step for a non-action tool', async () => {
    const { agent, trace } = harness();
    await handle(agent, 'browser_snapshot', []);
    expect(trace.began).toBe(0);
  });

  it('closes the step, forwarding the error flag', async () => {
    const { agent, trace } = harness({ isToolError: true });
    await handle(agent, 'browser_click', []);
    expect(trace.ended).toEqual([true]);
  });

  it('closes the step cleanly on success', async () => {
    const { agent, trace } = harness();
    await handle(agent, 'browser_click', []);
    expect(trace.ended).toEqual([false]);
  });

  it('does not close a step when none is active', async () => {
    const { agent, trace } = harness({ activeStep: null });
    await handle(agent, 'browser_click', []);
    expect(trace.ended).toEqual([]);
  });

  it('caches the aria snapshot from a successful browser_snapshot', async () => {
    const { agent } = harness({ content: '  - button "Submit" [ref=e1]' });
    await handle(agent, 'browser_snapshot', []);

    expect(agent['lastAriaContent']).toContain('- button "Submit"');
  });

  it('does not cache aria from a failed snapshot', async () => {
    const { agent } = harness({ content: 'partial', isToolError: true });
    await handle(agent, 'browser_snapshot', []);
    expect(agent['lastAriaContent']).toBeNull();
  });

  it('does not cache aria from a non-snapshot tool', async () => {
    const { agent } = harness({ content: 'clicked' });
    await handle(agent, 'browser_click', []);
    expect(agent['lastAriaContent']).toBeNull();
  });

  it('does not cache an empty snapshot', async () => {
    const { agent } = harness({ content: '' });
    await handle(agent, 'browser_snapshot', []);
    expect(agent['lastAriaContent']).toBeNull();
  });

  it('always captures, persists and injects afterwards', async () => {
    const { agent, trace } = harness();
    await handle(agent, 'browser_click', []);

    expect(trace.captured).toBe(1);
    expect(trace.persisted).toBe(1);
    expect(trace.injected).toBe(1);
  });
});
