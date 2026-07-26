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

export interface ActionEffect {
  toolName: string;
  toolArgs: Record<string, unknown>;
  snapshotBefore: string | null;
  snapshotAfter: string;
  urlChanged: boolean;
}

/** Warning to append to the tool result, or empty when the action clearly landed. */
export type EffectWarning = string;

function typedText(toolArgs: Record<string, unknown>): string {
  const text = toolArgs.text;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Typing is checkable directly: the accessibility tree reports input values, so
 * text that landed shows up in the snapshot.
 */
function checkTyping(effect: ActionEffect): EffectWarning {
  const text = typedText(effect.toolArgs);
  if (text === '' || effect.urlChanged) return '';
  if (effect.snapshotAfter.includes(text)) return '';
  return `WARNING: the text you typed ("${text}") does not appear in the page snapshot taken right after. The field probably did not receive it. Call browser_snapshot, check the field's current value, and type again with a fresh ref before continuing.`;
}

/** For clicks and key presses all we can ask is whether anything moved. */
function checkPageChanged(effect: ActionEffect): EffectWarning {
  if (effect.urlChanged) return '';
  if (effect.snapshotBefore === null) return '';
  if (effect.snapshotAfter !== effect.snapshotBefore) return '';
  return `WARNING: the page is byte-for-byte identical after ${effect.toolName} and the URL did not change, so the action had no visible effect. The element may be disabled, covered, or the ref may be stale. Call browser_snapshot and verify before continuing — do not assume this step succeeded.`;
}

/** Empty string when the action visibly landed, otherwise a warning for the model. */
export function checkActionEffect(effect: ActionEffect): EffectWarning {
  if (!MUTATING_TOOLS.has(effect.toolName)) return '';
  if (effect.snapshotAfter === '') return '';
  if (effect.toolName === 'browser_type') return checkTyping(effect);
  return checkPageChanged(effect);
}

/** Appends a warning to a tool result, keeping the original content intact. */
export function withEffectWarning(content: string, warning: EffectWarning): string {
  if (warning === '') return content;
  return content === '' ? warning : `${content}\n\n${warning}`;
}
