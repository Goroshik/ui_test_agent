import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { Agent } from './agent.js';
import type { ActionData, ArtifactRefs } from '../../pipeline/types.js';

interface BegunStep {
  stepId: string;
  url: string;
  action: ActionData;
  refs: ArtifactRefs;
}

interface CompletedStep {
  stepId: string;
  refs: { ariaSnapshotFile: string; networkFile?: string };
}

/** Records everything the agent asks the collector to persist. */
function makeCollector(): {
  stub: unknown;
  begun: BegunStep[];
  completed: CompletedStep[];
  networks: Array<{ stepId: string; payload: { raw: string } }>;
} {
  const begun: BegunStep[] = [];
  const completed: CompletedStep[] = [];
  const networks: Array<{ stepId: string; payload: { raw: string } }> = [];

  const stub = {
    nextStepId: () => 'step-001',
    saveDomDump: () => Promise.resolve('raw/dom/step-001.json'),
    saveStorage: () => Promise.resolve('raw/storage/step-001.json'),
    saveNetwork: (stepId: string, payload: { raw: string }) => {
      networks.push({ stepId, payload });
      return Promise.resolve(`raw/network/${stepId}-network.json`);
    },
    beginStep: (stepId: string, url: string, action: ActionData, refs: ArtifactRefs) => {
      begun.push({ stepId, url, action, refs });
      return Promise.resolve();
    },
    completeStep: (stepId: string, refs: { ariaSnapshotFile: string; networkFile?: string }) => {
      completed.push({ stepId, refs });
      return Promise.resolve();
    },
  };

  return { stub, begun, completed, networks };
}

function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Agent._beginCollectorStep (buildActionData)', () => {
  function setup(): { agent: Agent; collector: ReturnType<typeof makeCollector> } {
    const agent = new Agent({} as unknown as OpenAI);
    const collector = makeCollector();
    agent['collector'] = collector.stub as never;
    agent['mcp'] = {
      dumpInteractiveDom: () => Promise.resolve([{ tag: 'button' }]),
      evaluateAttrsOnRef: () => Promise.resolve(null),
    } as never;
    return { agent, collector };
  }

  async function actionFor(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<ActionData> {
    const { agent, collector } = setup();
    await agent['_beginCollectorStep'](toolName, toolArgs);
    const step = collector.begun[0];
    if (!step) throw new Error('collector.beginStep was never called');
    return step.action;
  }

  it('does nothing when there is no collector', async () => {
    const agent = new Agent({} as unknown as OpenAI);
    await expect(agent['_beginCollectorStep']('browser_click', {})).resolves.toBeUndefined();
  });

  // ACTION_TYPE_MAP coverage.
  const typeCases: Array<[string, string]> = [
    ['browser_click', 'click'],
    ['browser_type', 'fill'],
    ['browser_navigate', 'navigate'],
    ['browser_select_option', 'select'],
    ['browser_hover', 'hover'],
    ['browser_press_key', 'press_key'],
  ];

  for (const [tool, expected] of typeCases) {
    it(`maps ${tool} to the "${expected}" action type`, async () => {
      expect((await actionFor(tool, {})).type).toBe(expected);
    });
  }

  it('maps an unknown tool to "other"', async () => {
    expect((await actionFor('browser_mystery', {})).type).toBe('other');
  });

  it('describes an action using the element name', async () => {
    const action = await actionFor('browser_click', { element: 'Submit' });
    expect(action.description).toBe('click on "Submit"');
  });

  it('describes a navigation using the url when there is no element', async () => {
    const action = await actionFor('browser_navigate', { url: 'https://app.test/home' });
    expect(action.description).toBe('navigate to https://app.test/home');
  });

  it('falls back to the bare type when neither element nor url is given', async () => {
    expect((await actionFor('browser_hover', {})).description).toBe('hover');
  });

  it('builds an element from the element name and ref', async () => {
    const action = await actionFor('browser_click', { element: 'Submit', ref: 'e12' });
    expect(action.element).toEqual({ ariaName: 'Submit', ref: 'e12' });
  });

  it('builds an element from a ref alone', async () => {
    const action = await actionFor('browser_click', { ref: 'e12' });
    expect(action.element).toEqual({ ariaName: null, ref: 'e12' });
  });

  it('omits the element entirely when neither name nor ref is present', async () => {
    expect(await actionFor('browser_click', {})).not.toHaveProperty('element');
  });

  it('uses the text argument as the action value', async () => {
    expect((await actionFor('browser_type', { text: 'hello' })).value).toBe('hello');
  });

  it('prefers text over url for the value', async () => {
    const action = await actionFor('browser_type', { text: 'hello', url: 'https://x.test' });
    expect(action.value).toBe('hello');
  });

  it('falls back to the url for the value', async () => {
    expect((await actionFor('browser_navigate', { url: 'https://x.test' })).value).toBe(
      'https://x.test',
    );
  });

  it('joins a values array for the value', async () => {
    expect((await actionFor('browser_select_option', { values: ['a', 'b'] })).value).toBe('a, b');
  });

  it('omits the value when no source argument is present', async () => {
    expect(await actionFor('browser_click', {})).not.toHaveProperty('value');
  });

  it('ignores non-string argument types', async () => {
    const action = await actionFor('browser_click', { element: 42, ref: null });
    expect(action).not.toHaveProperty('element');
  });

  it('records the current page url on the begun step', async () => {
    const { agent, collector } = setup();
    agent['lastPageUrl'] = 'https://app.test/login';
    await agent['_beginCollectorStep']('browser_click', {});

    expect(collector.begun[0]?.url).toBe('https://app.test/login');
  });

  it('falls back to an empty url when none is known', async () => {
    const { agent, collector } = setup();
    await agent['_beginCollectorStep']('browser_click', {});
    expect(collector.begun[0]?.url).toBe('');
  });

  it('enriches the element from the aria snapshot when a ref is given', async () => {
    const { agent, collector } = setup();
    agent['lastAriaContent'] = '  - button "Submit" [ref=e12]';
    await agent['_beginCollectorStep']('browser_click', { element: 'Submit', ref: 'e12' });

    expect(collector.begun[0]?.action.element?.ariaRole).toBe('button');
    expect(collector.begun[0]?.action.element?.ariaName).toBe('Submit');
  });
});

describe('Agent._endCollectorStep', () => {
  function setup(options: { networkThrows?: boolean; snapshotThrows?: boolean } = {}): {
    agent: Agent;
    collector: ReturnType<typeof makeCollector>;
  } {
    const agent = new Agent({} as unknown as OpenAI);
    const collector = makeCollector();
    agent['collector'] = collector.stub as never;
    agent['mcp'] = {
      callTool: () =>
        options.networkThrows
          ? Promise.reject(new Error('network tool down'))
          : Promise.resolve(textResult('[GET] https://api.test/a')),
      snapshot: () =>
        options.snapshotThrows
          ? Promise.reject(new Error('snapshot down'))
          : Promise.resolve(textResult('  - button "Submit" [ref=e1]')),
    } as never;
    agent['activeStepId'] = 'step-001';
    return { agent, collector };
  }

  it('does nothing when there is no collector', async () => {
    const agent = new Agent({} as unknown as OpenAI);
    agent['activeStepId'] = 'step-001';
    await expect(agent['_endCollectorStep'](false)).resolves.toBeUndefined();
  });

  it('does nothing when no step is active', async () => {
    const { agent, collector } = setup();
    agent['activeStepId'] = null;
    await agent['_endCollectorStep'](false);
    expect(collector.completed).toEqual([]);
  });

  it('clears the active step id', async () => {
    const { agent } = setup();
    await agent['_endCollectorStep'](false);
    expect(agent['activeStepId']).toBeNull();
  });

  it('leaves the step incomplete when the tool errored', async () => {
    const { agent, collector } = setup();
    await agent['_endCollectorStep'](true);

    expect(collector.completed).toEqual([]);
    expect(collector.networks).toEqual([]);
  });

  it('saves the network log and completes the step', async () => {
    const { agent, collector } = setup();
    await agent['_endCollectorStep'](false);

    expect(collector.networks[0]?.payload.raw).toContain('[GET] https://api.test/a');
    expect(collector.completed[0]?.stepId).toBe('step-001');
    expect(collector.completed[0]?.refs.networkFile).toContain('step-001-network.json');
  });

  it('refreshes the in-memory aria snapshot for the next turn', async () => {
    const { agent } = setup();
    await agent['_endCollectorStep'](false);
    expect(agent['lastAriaContent']).toContain('- button "Submit"');
  });

  it('still completes the step when network collection fails', async () => {
    const { agent, collector } = setup({ networkThrows: true });
    await agent['_endCollectorStep'](false);

    expect(collector.completed).toHaveLength(1);
    expect(collector.completed[0]?.refs.networkFile).toBe('');
  });

  it('still completes the step when the snapshot refresh fails', async () => {
    const { agent, collector } = setup({ snapshotThrows: true });
    await agent['_endCollectorStep'](false);
    expect(collector.completed).toHaveLength(1);
  });

  it('leaves the previous aria snapshot in place when the refresh returns nothing', async () => {
    const { agent } = setup();
    agent['lastAriaContent'] = 'previous';
    agent['mcp'] = {
      callTool: () => Promise.resolve(textResult('')),
      snapshot: () => Promise.resolve(null),
    } as never;

    await agent['_endCollectorStep'](false);
    expect(agent['lastAriaContent']).toBe('previous');
  });
});

describe('Agent snapshot + artifact capture', () => {
  const savedEffectFlag = process.env.ACTION_EFFECT_CHECK_ENABLED;

  afterEach(() => {
    if (savedEffectFlag === undefined) delete process.env.ACTION_EFFECT_CHECK_ENABLED;
    else process.env.ACTION_EFFECT_CHECK_ENABLED = savedEffectFlag;
  });

  function setup(screenshotPath?: string): { agent: Agent; visits: string[] } {
    const agent = new Agent({} as unknown as OpenAI);
    const visits: string[] = [];

    agent['mcp'] = {
      snapshot: () => Promise.resolve(textResult('Page URL: https://app.test/home')),
    } as never;
    agent['_recordNavigateVisitIfApplicable'] = (): Promise<void> => {
      visits.push('navigate');
      return Promise.resolve();
    };
    agent['_recordVisitOnUrlChange'] = (): Promise<void> => {
      visits.push('url-change');
      return Promise.resolve();
    };
    agent['_captureIfPageChanged'] = (): Promise<{ urlChanged: boolean; screenshotPath?: string }> =>
      Promise.resolve(screenshotPath === undefined ? { urlChanged: true } : { urlChanged: true, screenshotPath });

    return { agent, visits };
  }

  const call = { id: 'c1', name: 'browser_click', args: {} };
  const BOTH_OFF = { screenshotsEnabled: false, snapshotsEnabled: false };
  const SHOTS_ON = { screenshotsEnabled: true, snapshotsEnabled: false };

  describe('_readPostActionSnapshot', () => {
    it('still fetches a snapshot with both artifact flags off, so effect checking works', async () => {
      const { agent } = setup();
      const snapshot = vi.fn(() => Promise.resolve(textResult('Page URL: https://app.test/y')));
      agent['mcp'] = { snapshot } as never;

      const result = await agent['_readPostActionSnapshot'](call, 'ignored', BOTH_OFF);

      expect(result).toBe('Page URL: https://app.test/y');
      expect(snapshot).toHaveBeenCalledOnce();
    });

    it('skips the extra fetch when effect checking is switched off', async () => {
      process.env.ACTION_EFFECT_CHECK_ENABLED = 'false';
      const { agent } = setup();
      const snapshot = vi.fn(() => Promise.resolve(textResult('x')));
      agent['mcp'] = { snapshot } as never;

      expect(await agent['_readPostActionSnapshot'](call, 'ignored', BOTH_OFF)).toBe('');
      expect(snapshot).not.toHaveBeenCalled();
    });

    it('still fetches for artifact capture even when effect checking is off', async () => {
      process.env.ACTION_EFFECT_CHECK_ENABLED = 'false';
      const { agent } = setup();
      const snapshot = vi.fn(() => Promise.resolve(textResult('Page URL: https://app.test/y')));
      agent['mcp'] = { snapshot } as never;

      expect(await agent['_readPostActionSnapshot'](call, 'ignored', SHOTS_ON)).not.toBe('');
      expect(snapshot).toHaveBeenCalledOnce();
    });

    it('uses the tool content directly for a browser_snapshot call', async () => {
      const { agent } = setup();
      const snapshot = vi.fn(() => Promise.resolve(textResult('should not be used')));
      agent['mcp'] = { snapshot } as never;

      const result = await agent['_readPostActionSnapshot'](
        { id: 'c1', name: 'browser_snapshot', args: {} },
        'Page URL: https://app.test/x',
        SHOTS_ON,
      );

      expect(result).toBe('Page URL: https://app.test/x');
      expect(snapshot).not.toHaveBeenCalled();
    });

    it('returns the browser_snapshot content even with effect checking off', async () => {
      process.env.ACTION_EFFECT_CHECK_ENABLED = 'false';
      const { agent } = setup();

      const result = await agent['_readPostActionSnapshot'](
        { id: 'c1', name: 'browser_snapshot', args: {} },
        'Page URL: https://app.test/x',
        BOTH_OFF,
      );

      expect(result).toBe('Page URL: https://app.test/x');
    });
  });

  describe('_captureArtifacts', () => {
    it('records a navigate visit and skips capture when both flags are off', async () => {
      const { agent, visits } = setup('/tmp/shot.webp');
      const result = await agent['_captureArtifacts'](call, 'Page URL: https://app.test/home', BOTH_OFF);

      expect(result).toBeUndefined();
      expect(visits).toEqual(['navigate']);
    });

    it('returns the screenshot path when capture succeeds', async () => {
      const { agent, visits } = setup('/tmp/shot.webp');
      const result = await agent['_captureArtifacts'](call, 'Page URL: https://app.test/home', SHOTS_ON);

      expect(result).toBe('/tmp/shot.webp');
      expect(visits).toEqual(['url-change']);
    });

    it('returns undefined when capture produced no screenshot', async () => {
      const { agent } = setup(undefined);
      const result = await agent['_captureArtifacts'](call, 'Page URL: https://app.test/home', SHOTS_ON);
      expect(result).toBeUndefined();
    });

    it('bails out when the snapshot text is empty', async () => {
      const { agent, visits } = setup('/tmp/shot.webp');

      const result = await agent['_captureArtifacts'](call, '', SHOTS_ON);

      expect(result).toBeUndefined();
      expect(visits).toEqual([]);
    });

    it('runs capture when only snapshots are enabled', async () => {
      const { agent, visits } = setup(undefined);
      await agent['_captureArtifacts'](call, 'Page URL: https://app.test/home', {
        screenshotsEnabled: false,
        snapshotsEnabled: true,
      });
      expect(visits).toEqual(['url-change']);
    });
  });
});
