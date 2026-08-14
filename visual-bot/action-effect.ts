/**
 * Did the action the model just took actually do anything?
 *
 * The run loop used to hand the raw MCP result back and move on. Playwright MCP
 * reports success as long as the *call* succeeded, so a click on a disabled
 * button or a type into a field that rejected the input came back clean, the
 * model believed it, and the run continued as if the form were filled. From the
 * outside that looks like the model "forgetting" to fill a field or press a
 * button — it thought it had.
 *
 * Comparing the accessibility snapshot before and after gives a cheap, honest
 * answer, which we append to the tool result so the model can retry instead of
 * building on a step that never landed.
 */

/** Tools whose whole point is to change the page — a no-op here is a real problem. */
const MUTATING_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_select_option',
  'browser_press_key',
]);

/**
 * Tools meant to *reveal* something. A no-op is often legitimate (hover styling
 * lives in CSS, which never reaches the accessibility tree), so these get a
 * neutral note rather than a warning — the danger is not the hover itself but the
 * model then clicking a menu item it never actually saw.
 */
const REVEALING_TOOLS = new Set(['browser_hover']);

const PAGE_URL = /Page URL:\s*(\S+)/i;

export interface ActionEffect {
  toolName: string;
  toolArgs: Record<string, unknown>;
  snapshotBefore: string | null;
  snapshotAfter: string;
}

/** Text appended to the tool result, or empty when the action clearly landed. */
export type EffectWarning = string;

/** The page URL an ARIA snapshot reports, when it reports one. */
export function snapshotUrl(snapshot: string): string | null {
  return snapshot.match(PAGE_URL)?.[1] ?? null;
}

/**
 * Whether the page navigated between the two snapshots. Derived here rather than
 * taken as a parameter: the caller tracks URLs only when artifact capture is on,
 * so passing it in was both redundant and easy to get wrong.
 */
export function urlChangedBetween(before: string | null, after: string): boolean {
  const from = before === null ? null : snapshotUrl(before);
  const to = snapshotUrl(after);
  if (from === null || to === null) return false;
  return from !== to;
}

function typedText(toolArgs: Record<string, unknown>): string {
  const text = toolArgs.text;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Typing is checkable directly: the accessibility tree reports input values, so
 * text that landed shows up in the snapshot.
 */
function checkTyping(effect: ActionEffect, navigated: boolean): EffectWarning {
  const text = typedText(effect.toolArgs);
  if (text === '' || navigated) return '';
  if (effect.snapshotAfter.includes(text)) return '';
  return `WARNING: the text you typed ("${text}") does not appear in the page snapshot taken right after. The field probably did not receive it. Call browser_snapshot, check the field's current value, and type again with a fresh ref before continuing.`;
}

/** True when nothing observable moved: same snapshot, same URL. */
function isNoOp(effect: ActionEffect, navigated: boolean): boolean {
  if (navigated) return false;
  if (effect.snapshotBefore === null) return false;
  return effect.snapshotAfter === effect.snapshotBefore;
}

/** For clicks and key presses all we can ask is whether anything moved. */
function checkPageChanged(effect: ActionEffect, navigated: boolean): EffectWarning {
  if (!isNoOp(effect, navigated)) return '';
  return `WARNING: the page is byte-for-byte identical after ${effect.toolName} and the URL did not change, so the action had no visible effect. The element may be disabled, covered, or the ref may be stale. Call browser_snapshot and verify before continuing — do not assume this step succeeded.`;
}

/** For hover: state the fact, let the model judge, but block the dangerous inference. */
function noteRevealUnchanged(effect: ActionEffect, navigated: boolean): EffectWarning {
  if (!isNoOp(effect, navigated)) return '';
  return `NOTE: the snapshot is unchanged after ${effect.toolName}. That is often fine — hover styling lives in CSS and never reaches the accessibility tree. But nothing new was revealed, so if you were expecting a menu, tooltip or dropdown, it did not open. Do not click an item you have not seen in a snapshot.`;
}

/** Empty string when the action visibly landed, otherwise something to tell the model. */
export function checkActionEffect(effect: ActionEffect): EffectWarning {
  const isMutating = MUTATING_TOOLS.has(effect.toolName);
  if (!isMutating && !REVEALING_TOOLS.has(effect.toolName)) return '';
  if (effect.snapshotAfter === '') return '';

  const navigated = urlChangedBetween(effect.snapshotBefore, effect.snapshotAfter);
  if (effect.toolName === 'browser_type') return checkTyping(effect, navigated);
  if (!isMutating) return noteRevealUnchanged(effect, navigated);
  return checkPageChanged(effect, navigated);
}

/** Appends a warning to a tool result, keeping the original content intact. */
export function withEffectWarning(content: string, warning: EffectWarning): string {
  if (warning === '') return content;
  return content === '' ? warning : `${content}\n\n${warning}`;
}
