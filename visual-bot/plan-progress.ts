/**
 * Did the agent actually carry out the plan before declaring itself done?
 *
 * The run loop ended the moment the model stopped calling tools, with nothing
 * checking the plan against what happened. A model that wrote a confident
 * summary after three of eight steps ended the run "successfully" — the other
 * reading of "it forgot to fill the field": it never tried.
 *
 * The plan names the tools to call (the planner prompt requires it), so counting
 * planned versus performed calls per tool gives a specific, explainable gap
 * instead of a vague "are you sure?". Language-independent, because it keys off
 * tool names rather than prose.
 */

/** Only tools that change the page — the agent legitimately snapshots more than planned. */
const TRACKED_TOOLS = [
  'browser_click',
  'browser_type',
  'browser_select_option',
  'browser_navigate',
  'browser_hover',
] as const;

export type TrackedTool = (typeof TRACKED_TOOLS)[number];

export interface Shortfall {
  tool: TrackedTool;
  planned: number;
  performed: number;
}

export type ToolCounts = Partial<Record<TrackedTool, number>>;

/** How many times the plan asks for each tracked tool. */
export function countPlannedToolCalls(plan: string): ToolCounts {
  const counts: ToolCounts = {};
  for (const tool of TRACKED_TOOLS) {
    const matches = plan.match(new RegExp(tool, 'g'));
    if (matches) counts[tool] = matches.length;
  }
  return counts;
}

/** Tools the plan asked for more often than the agent delivered. */
export function findShortfalls(planned: ToolCounts, performed: ToolCounts): Shortfall[] {
  return TRACKED_TOOLS.map((tool) => ({
    tool,
    planned: planned[tool] ?? 0,
    performed: performed[tool] ?? 0,
  })).filter((s) => s.performed < s.planned);
}

function describe(shortfall: Shortfall): string {
  return `- ${shortfall.tool}: the plan asks for ${shortfall.planned}, you performed ${shortfall.performed}`;
}

/** Message pushed back at the model when it stopped short. Empty when it did not. */
export function buildPushbackMessage(shortfalls: Shortfall[]): string {
  if (shortfalls.length === 0) return '';
  return [
    'STOP — you have not finished the plan. Comparing the plan against what you actually did:',
    ...shortfalls.map(describe),
    '',
    'Do not summarise yet. Call browser_snapshot, find the steps you skipped, and carry them out.',
    'If a step is genuinely impossible (the control is absent or disabled), say which step and why — do not silently drop it.',
  ].join('\n');
}
