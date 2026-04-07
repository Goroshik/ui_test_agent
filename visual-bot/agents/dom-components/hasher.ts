import { createHash } from 'crypto';

/** MD5 hash of block content — used to detect changes and enable cross-URL reuse. */
export function hashContent(content: string): string {
  return createHash('md5').update(content).digest('hex');
}
