import { describe, it, expect } from 'vitest';
import {
  countPlannedToolCalls,
  findShortfalls,
  buildPushbackMessage,
  type ToolCounts,
} from './plan-progress.js';

const SAMPLE_PLAN = `1. Navigate to http://localhost:3000/v1/login
2. Call browser_snapshot to inspect the page
3. Enter the email via browser_type
4. Enter the password via browser_type
5. Press the login button via browser_click
6. Call browser_snapshot to verify`;

describe('countPlannedToolCalls', () => {
  it('counts repeated calls to the same tool', () => {
    expect(countPlannedToolCalls(SAMPLE_PLAN).browser_type).toBe(2);
  });

  it('keys off literal tool names, not sentence structure', () => {
    const counts = countPlannedToolCalls(SAMPLE_PLAN);

    expect(counts.browser_click).toBe(1);
    expect(counts.browser_type).toBe(2);
  });

  it('ignores browser_snapshot — the agent legitimately snapshots more than planned', () => {
    expect(countPlannedToolCalls(SAMPLE_PLAN)).not.toHaveProperty('browser_snapshot');
  });

  it('omits a tool the plan never mentions', () => {
    expect(countPlannedToolCalls('1. browser_click the thing')).not.toHaveProperty('browser_type');
  });

  it('counts navigation', () => {
    expect(countPlannedToolCalls('1. browser_navigate to /a\n2. browser_navigate to /b').browser_navigate).toBe(2);
  });

  it('finds nothing in a plan that names no tools', () => {
    expect(countPlannedToolCalls('Just log in somehow')).toEqual({});
  });

  it('finds nothing in an empty plan', () => {
    expect(countPlannedToolCalls('')).toEqual({});
  });
});

describe('findShortfalls', () => {
  it('reports a tool the agent under-delivered', () => {
    const shortfalls = findShortfalls({ browser_type: 2 }, { browser_type: 1 });

    expect(shortfalls).toEqual([{ tool: 'browser_type', planned: 2, performed: 1 }]);
  });

  it('reports a tool the agent never called at all', () => {
    expect(findShortfalls({ browser_click: 1 }, {})).toEqual([
      { tool: 'browser_click', planned: 1, performed: 0 },
    ]);
  });

  it('is empty when the plan was met exactly', () => {
    expect(findShortfalls({ browser_type: 2 }, { browser_type: 2 })).toEqual([]);
  });

  it('is empty when the agent did more than planned', () => {
    expect(findShortfalls({ browser_type: 1 }, { browser_type: 5 })).toEqual([]);
  });

  it('is empty when the plan asked for nothing trackable', () => {
    expect(findShortfalls({}, { browser_click: 3 })).toEqual([]);
  });

  it('reports every shortfall, not just the first', () => {
    const shortfalls = findShortfalls({ browser_type: 2, browser_click: 1 }, {});
    expect(shortfalls.map((s) => s.tool).sort()).toEqual(['browser_click', 'browser_type']);
  });

  it('leaves met tools out of a mixed result', () => {
    const shortfalls = findShortfalls(
      { browser_type: 2, browser_click: 1 },
      { browser_type: 2, browser_click: 0 },
    );
    expect(shortfalls.map((s) => s.tool)).toEqual(['browser_click']);
  });
});

describe('buildPushbackMessage', () => {
  it('is empty when there is nothing to push back on', () => {
    expect(buildPushbackMessage([])).toBe('');
  });

  it('names the tool with both counts, so the gap is concrete', () => {
    const message = buildPushbackMessage([{ tool: 'browser_type', planned: 2, performed: 1 }]);

    expect(message).toContain('browser_type');
    expect(message).toContain('asks for 2');
    expect(message).toContain('you performed 1');
  });

  it('tells the model not to summarise yet', () => {
    const message = buildPushbackMessage([{ tool: 'browser_click', planned: 1, performed: 0 }]);
    expect(message).toContain('Do not summarise yet');
  });

  it('leaves an escape hatch for a genuinely impossible step', () => {
    const message = buildPushbackMessage([{ tool: 'browser_click', planned: 1, performed: 0 }]);

    expect(message).toContain('genuinely impossible');
    expect(message).toContain('do not silently drop it');
  });

  it('lists one line per shortfall', () => {
    const message = buildPushbackMessage([
      { tool: 'browser_type', planned: 2, performed: 0 },
      { tool: 'browser_click', planned: 1, performed: 0 },
    ]);

    expect(message.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
  });
});

describe('end to end', () => {
  it('catches the reported failure: agent summarised after skipping the form', () => {
    const planned = countPlannedToolCalls(SAMPLE_PLAN);
    const performed: ToolCounts = { browser_navigate: 1 };

    const message = buildPushbackMessage(findShortfalls(planned, performed));

    expect(message).toContain('browser_type');
    expect(message).toContain('browser_click');
  });

  it('stays silent when the agent did carry the plan out', () => {
    const planned = countPlannedToolCalls(SAMPLE_PLAN);
    const performed: ToolCounts = { browser_navigate: 1, browser_type: 2, browser_click: 1 };

    expect(buildPushbackMessage(findShortfalls(planned, performed))).toBe('');
  });
});
