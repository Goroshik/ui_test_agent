import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { normalizePagePath, isDynamicSegment, DYNAMIC_SEGMENT } from './url-path.js';

describe('isDynamicSegment', () => {
  it.each(['1', '58', '123456'])('treats the all-digit segment "%s" as an id', (segment) => {
    expect(isDynamicSegment(segment)).toBe(true);
  });

  it('treats a canonical uuid as an id', () => {
    expect(isDynamicSegment('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
  });

  it('treats a 24-char mongo object id as an id', () => {
    expect(isDynamicSegment('507f1f77bcf86cd799439011')).toBe(true);
  });

  it.each(['users', 'member-hr', 'step-1', 'v1', 'orgchart', 'cafe', 'e2e'])(
    'leaves the route name "%s" alone',
    (segment) => {
      expect(isDynamicSegment(segment)).toBe(false);
    },
  );

  it('does not treat short hex as an id — real routes look like that', () => {
    expect(isDynamicSegment('abcdef')).toBe(false);
  });

  it('does not treat an id-like segment with extra text as an id', () => {
    expect(isDynamicSegment('user-123-profile')).toBe(false);
  });
});

describe('normalizePagePath', () => {
  it('keeps a static path untouched', () => {
    expect(normalizePagePath('/member-hr/home')).toBe('/member-hr/home');
  });

  it('strips the origin from a full url', () => {
    expect(normalizePagePath('http://localhost:3000/v1/login')).toBe('/v1/login');
  });

  it('drops the query string', () => {
    expect(normalizePagePath('http://localhost:3000/member-hr/home?project=58')).toBe(
      '/member-hr/home',
    );
  });

  it('drops a long sort/paging query — the case that fragmented memory.json', () => {
    const url =
      'http://localhost:3000/member-hr/workflow-tasks/tasks?skip=0&take=25&page=0&sortModel=dueDate%3Basc';
    expect(normalizePagePath(url)).toBe('/member-hr/workflow-tasks/tasks');
  });

  it('drops the hash', () => {
    expect(normalizePagePath('http://x/settings#section')).toBe('/settings');
  });

  it('collapses a numeric id to the placeholder', () => {
    expect(normalizePagePath('/users/123')).toBe(`/users/${DYNAMIC_SEGMENT}`);
  });

  it('maps two different records of the same route to one key', () => {
    expect(normalizePagePath('/users/123')).toBe(normalizePagePath('/users/456'));
  });

  it('maps a uuid record to the same key as a numeric one', () => {
    expect(normalizePagePath('/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(
      normalizePagePath('/users/7'),
    );
  });

  it('collapses several dynamic segments independently', () => {
    expect(normalizePagePath('/org/12/users/34/edit')).toBe(
      `/org/${DYNAMIC_SEGMENT}/users/${DYNAMIC_SEGMENT}/edit`,
    );
  });

  it('adds a missing leading slash', () => {
    expect(normalizePagePath('member-hr/team')).toBe('/member-hr/team');
  });

  it('strips a trailing slash', () => {
    expect(normalizePagePath('/member-hr/team/')).toBe('/member-hr/team');
  });

  it('collapses repeated slashes', () => {
    expect(normalizePagePath('/member-hr//team')).toBe('/member-hr/team');
  });

  it('maps the site root to "/"', () => {
    expect(normalizePagePath('http://localhost:3000/')).toBe('/');
  });

  it('maps an empty input to "/"', () => {
    expect(normalizePagePath('')).toBe('/');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePagePath('  /member-hr/home  ')).toBe('/member-hr/home');
  });

  it('decodes nothing it should not — an encoded slash stays one segment', () => {
    expect(normalizePagePath('/search/a%2Fb')).toBe('/search/a%2Fb');
  });
});

describe('normalizePagePath (property)', () => {
  const segment = fc.stringMatching(/^[a-z][a-z-]{0,12}$/);

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 5 }), (segments) => {
        const path = `/${segments.join('/')}`;
        const once = normalizePagePath(path);
        expect(normalizePagePath(once)).toBe(once);
      }),
    );
  });

  it('always returns a path starting with a single slash', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = normalizePagePath(raw);
        expect(result.startsWith('/')).toBe(true);
        expect(result.startsWith('//')).toBe(false);
      }),
    );
  });

  it('never returns a trailing slash except for the root', () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segments) => {
        const result = normalizePagePath(`/${segments.join('/')}/`);
        expect(result.endsWith('/')).toBe(result === '/');
      }),
    );
  });

  it('ignores the query string entirely', () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), fc.string(), (segments, q) => {
        const path = `/${segments.join('/')}`;
        expect(normalizePagePath(`http://x${path}?q=${encodeURIComponent(q)}`)).toBe(
          normalizePagePath(`http://x${path}`),
        );
      }),
    );
  });

  it('maps any two numeric records of one route to the same key', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (a, b) => {
        expect(normalizePagePath(`/users/${a}`)).toBe(normalizePagePath(`/users/${b}`));
      }),
    );
  });
});
