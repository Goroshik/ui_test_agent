import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs, buildCommands, STEP_NAMES, USAGE, type Invocation } from './steps.js';

const ENV_KEYS = ['SNAPSHOT_ANALYSIS_ENABLED', 'SCREENSHOT_ANALYSIS_ENABLED'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** parseArgs, asserting it succeeded. */
function parse(...argv: string[]): Invocation {
  const result = parseArgs(argv);
  if ('error' in result) throw new Error(`expected a parse, got: ${result.error}`);
  return result;
}

/** parseArgs, asserting it failed. */
function parseError(...argv: string[]): string {
  const result = parseArgs(argv);
  if (!('error' in result)) throw new Error('expected a parse error');
  return result.error;
}

function scripts(invocation: Invocation): string[] {
  return buildCommands(invocation).map((c) => c.script);
}

describe('parseArgs — steps', () => {
  it.each(STEP_NAMES)('accepts "%s" on its own', (step) => {
    const argv = step === 'crawl' ? [step, 'do a thing'] : [step];
    expect(parse(...argv).steps).toEqual([step]);
  });

  it('expands "all" to every step in pipeline order', () => {
    expect(parse('all', 'do a thing').steps).toEqual(['crawl', 'analyze', 'generate']);
  });

  it('rejects an unknown step by name', () => {
    expect(parseError('crowl')).toContain('Unknown step "crowl"');
  });

  it('rejects no arguments at all', () => {
    expect(parseError()).toContain('No step given');
  });

  it('does not treat a flag as a step', () => {
    expect(parseError('--session', 'abc')).toContain('No step given');
  });
});

describe('parseArgs — task prompt', () => {
  it('joins the rest of the argv into the task', () => {
    expect(parse('crawl', 'log', 'in', 'and', 'open', 'the', 'team', 'page').task).toBe(
      'log in and open the team page',
    );
  });

  it('keeps a quoted task intact', () => {
    expect(parse('crawl', 'log in and open the team page').task).toBe(
      'log in and open the team page',
    );
  });

  it('requires a task for crawl', () => {
    expect(parseError('crawl')).toContain('needs a task prompt');
  });

  it('requires a task for all, since all includes crawl', () => {
    expect(parseError('all')).toContain('needs a task prompt');
  });

  it('rejects a whitespace-only task', () => {
    expect(parseError('crawl', '   ')).toContain('needs a task prompt');
  });

  it('needs no task for analyze or generate', () => {
    expect(parse('analyze').task).toBe('');
    expect(parse('generate').task).toBe('');
  });
});

describe('parseArgs — session selection', () => {
  it('defaults to the most recent session', () => {
    expect(parse('analyze').sessionId).toBe('');
  });

  it('takes a session id positionally for analyze', () => {
    expect(parse('analyze', 'session-42').sessionId).toBe('session-42');
  });

  it('takes a session id from --session', () => {
    expect(parse('analyze', '--session', 'session-42').sessionId).toBe('session-42');
  });

  it('lets --session work with all, without eating the task', () => {
    const invocation = parse('all', '--session', 'session-42', 'do a thing');

    expect(invocation.sessionId).toBe('session-42');
    expect(invocation.task).toBe('do a thing');
  });

  it('prefers --session over the positional id', () => {
    expect(parse('analyze', 'positional', '--session', 'flagged').sessionId).toBe('flagged');
  });

  it('ignores a dangling --session with no value', () => {
    expect(parse('analyze', '--session').sessionId).toBe('');
  });

  it('does not read a session id from a crawl task', () => {
    expect(parse('crawl', 'session-42').sessionId).toBe('');
  });
});

describe('buildCommands — crawl', () => {
  it('runs the agent entry point with the task', () => {
    const [command] = buildCommands(parse('crawl', 'do a thing'));

    expect(command?.script).toBe('visual-bot/index.ts');
    expect(command?.args).toEqual(['do a thing']);
  });

  it('switches every analysis phase off, so crawling only crawls', () => {
    const [command] = buildCommands(parse('crawl', 'do a thing'));

    expect(command?.env).toEqual({
      PIPELINE_ENABLED: 'false',
      SCREENSHOT_ANALYSIS_ENABLED: 'false',
      SNAPSHOT_ANALYSIS_ENABLED: 'false',
    });
  });

  it('is a single command', () => {
    expect(scripts(parse('crawl', 'do a thing'))).toHaveLength(1);
  });
});

describe('buildCommands — analyze', () => {
  it('builds the registry first', () => {
    expect(scripts(parse('analyze'))[0]).toBe('visual-bot/run-pipeline.ts');
  });

  it('passes the session id through when one was given', () => {
    const [registry] = buildCommands(parse('analyze', 'session-42'));
    expect(registry?.args).toEqual(['session-42']);
  });

  it('passes no argument when defaulting to the latest session', () => {
    const [registry] = buildCommands(parse('analyze'));
    expect(registry?.args).toEqual([]);
  });

  it('includes the ARIA snapshot diff by default', () => {
    expect(scripts(parse('analyze'))).toContain('visual-bot/snapshot-text-compare.ts');
  });

  it('drops the ARIA diff when it is switched off', () => {
    process.env.SNAPSHOT_ANALYSIS_ENABLED = 'false';
    expect(scripts(parse('analyze'))).not.toContain('visual-bot/snapshot-text-compare.ts');
  });

  it('leaves the screenshot diff out by default — it needs a vision model', () => {
    expect(scripts(parse('analyze'))).not.toContain('visual-bot/snapshot-compare.ts');
  });

  it('includes the screenshot diff only on an explicit opt-in', () => {
    process.env.SCREENSHOT_ANALYSIS_ENABLED = 'true';
    expect(scripts(parse('analyze'))).toContain('visual-bot/snapshot-compare.ts');
  });

  it('labels every command as part of the analyze step', () => {
    for (const command of buildCommands(parse('analyze'))) {
      expect(command.step).toBe('analyze');
    }
  });
});

describe('buildCommands — generate', () => {
  it('runs the chain in dependency order', () => {
    expect(scripts(parse('generate'))).toEqual([
      'visual-bot/generators/test-planner.ts',
      'visual-bot/generators/selectors-generator.ts',
      'visual-bot/generators/fixtures-generator.ts',
      'visual-bot/generators/test-generator.ts',
      'visual-bot/validators/test-validator.ts',
    ]);
  });

  it('ends with validation', () => {
    expect(scripts(parse('generate')).at(-1)).toBe('visual-bot/validators/test-validator.ts');
  });

  it('adds no extra environment', () => {
    for (const command of buildCommands(parse('generate'))) {
      expect(command.env).toEqual({});
    }
  });
});

describe('buildCommands — all', () => {
  it('is exactly the three steps concatenated in order', () => {
    const all = scripts(parse('all', 'do a thing'));

    expect(all).toEqual([
      ...scripts(parse('crawl', 'do a thing')),
      ...scripts(parse('analyze')),
      ...scripts(parse('generate')),
    ]);
  });

  it('crawls before it analyzes before it generates', () => {
    const steps = buildCommands(parse('all', 'do a thing')).map((c) => c.step);

    expect(steps.indexOf('crawl')).toBeLessThan(steps.indexOf('analyze'));
    expect(steps.indexOf('analyze')).toBeLessThan(steps.indexOf('generate'));
  });

  it('keeps each step contiguous — no interleaving', () => {
    const steps = buildCommands(parse('all', 'do a thing')).map((c) => c.step);

    for (const step of STEP_NAMES) {
      const span = steps.lastIndexOf(step) - steps.indexOf(step) + 1;
      expect(span).toBe(steps.filter((s) => s === step).length);
    }
  });

  it('gives every command a non-empty label', () => {
    for (const command of buildCommands(parse('all', 'do a thing'))) {
      expect(command.label.length).toBeGreaterThan(0);
    }
  });
});

describe('USAGE', () => {
  it('documents every step', () => {
    for (const step of STEP_NAMES) {
      expect(USAGE).toContain(step);
    }
  });

  it('documents the all shorthand', () => {
    expect(USAGE).toContain('all');
  });
});
