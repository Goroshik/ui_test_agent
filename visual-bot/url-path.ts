/**
 * Page-path normalisation shared by every store that keys knowledge by URL.
 *
 * Without it a dynamic route fragments the knowledge base: `/users/123` and
 * `/users/456` become two pages, two sets of component IDs and two `seenCount:
 * 1` records that never reinforce each other — and a lookup for `/users/789`
 * misses both. Collapsing the record identifier to a placeholder makes all
 * three the same page, so the registry merges and context lookups hit.
 *
 * Detection is deliberately conservative: a false positive renames a real route
 * and silently merges unrelated pages, which is worse than missing one.
 */

/** Placeholder standing in for a record identifier. One name for all kinds → maximum merging. */
export const DYNAMIC_SEGMENT = ':id';

const DIGITS = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mongo ObjectId and friends. 24 is the floor so short hex-looking words ("cafe") survive. */
const LONG_HEX = /^[0-9a-f]{24,}$/i;

/** True when a path segment names a record rather than a route. */
export function isDynamicSegment(segment: string): boolean {
  return DIGITS.test(segment) || UUID.test(segment) || LONG_HEX.test(segment);
}

function toPathname(url: string): string {
  const absolute = url.startsWith('http') ? url : `http://x${url.startsWith('/') ? url : `/${url}`}`;
  try {
    return new URL(absolute).pathname;
  } catch {
    return url;
  }
}

/**
 * Turns any URL or path into a stable page key: no origin, no query, no hash,
 * no trailing slash, record identifiers replaced by `:id`.
 */
export function normalizePagePath(url: string): string {
  const segments = toPathname(url.trim()).split('/').filter((s) => s !== '');
  if (segments.length === 0) return '/';
  const normalized = segments.map((s) => (isDynamicSegment(s) ? DYNAMIC_SEGMENT : s));
  return `/${normalized.join('/')}`;
}
