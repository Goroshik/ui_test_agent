import type { ComponentSelectors } from './pipeline/types.js';

/**
 * Selector quality rules, shared by whoever writes or upgrades a selector.
 *
 * The rules exist because two bugs quietly destroyed good selectors:
 *
 * 1. A Playwright accessibility ref (`e7`, `e12`) is a per-snapshot handle, not
 *    an attribute in the page. Emitting `[data-ref="e7"]` produced a Cypress
 *    selector that can never match anything, in a shape that *looks* stable.
 *
 * 2. The registry merge kept `preferred` from the first sighting forever, so a
 *    component first seen without a data-testid stayed pinned to its weak
 *    fallback even after a later run found the testid.
 */

/** `[data-ref="e7"]` — a Playwright snapshot handle, never present in the DOM. */
const EPHEMERAL_REF = /^\[data-ref=/;

/** Attributes a test can rely on run to run. */
const STABLE_SELECTOR = /^(\[data-(testid|cy|qa)=|#)/;

/** True for a selector that cannot match anything in a real browser. */
export function isEphemeralRef(selector: string): boolean {
  return EPHEMERAL_REF.test(selector.trim());
}

/** True for a selector a generated test can depend on. */
export function isStableSelector(selector: string): boolean {
  return STABLE_SELECTOR.test(selector.trim());
}

/** A selector worth writing down: present, and not an ephemeral ref. */
export function isUsableSelector(selector: string | null | undefined): boolean {
  return typeof selector === 'string' && selector.trim() !== '' && !isEphemeralRef(selector);
}

/**
 * The `preferred` selector after a merge.
 *
 * Conservative on purpose — it only fixes the two ways `preferred` went wrong,
 * and can never downgrade a selector that was already good:
 *   - a data-testid found on a later run wins, whatever came first
 *   - an ephemeral ref (or nothing) is replaced by any real selector
 *   - anything else is left exactly as it was
 */
export function upgradePreferred(current: string, merged: ComponentSelectors): string {
  if (isUsableSelector(merged.testid)) return merged.testid ?? '';
  if (isUsableSelector(current)) return current;
  return [merged.css, merged.aria].find((s) => isUsableSelector(s)) ?? '';
}
