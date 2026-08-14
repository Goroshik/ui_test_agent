import { describe, it, expect } from 'vitest';
import {
  checkActionEffect,
  withEffectWarning,
  snapshotUrl,
  urlChangedBetween,
  type ActionEffect,
} from './action-effect.js';

function effect(overrides: Partial<ActionEffect> = {}): ActionEffect {
  return {
    toolName: 'browser_click',
    toolArgs: {},
    snapshotBefore: '- button "Save"',
    snapshotAfter: '- button "Save"\n- alert "Saved"',
    ...overrides,
  };
}

/** Two snapshots whose only difference is the page URL — i.e. a navigation. */
const AT_LOGIN = 'Page URL: https://app.test/login\n- button "Save"';
const AT_HOME = 'Page URL: https://app.test/home\n- button "Save"';

describe('checkActionEffect — tools it ignores', () => {
  it.each(['browser_snapshot', 'browser_navigate', 'browser_wait_for'])(
    'says nothing about %s',
    (toolName) => {
      expect(checkActionEffect(effect({ toolName, snapshotAfter: '- button "Save"' }))).toBe('');
    },
  );

  it('says nothing when there is no snapshot to compare against', () => {
    expect(checkActionEffect(effect({ snapshotAfter: '' }))).toBe('');
  });

  it('says nothing on the first action, with no before-snapshot', () => {
    expect(
      checkActionEffect(effect({ snapshotBefore: null, snapshotAfter: '- button "Save"' })),
    ).toBe('');
  });
});

describe('checkActionEffect — clicks and key presses', () => {
  it('is quiet when the page changed', () => {
    expect(checkActionEffect(effect())).toBe('');
  });

  it('is quiet when the URL changed even though the rest of the snapshot did not', () => {
    expect(
      checkActionEffect(effect({ snapshotBefore: AT_LOGIN, snapshotAfter: AT_HOME })),
    ).toBe('');
  });

  it('warns when nothing at all changed', () => {
    const warning = checkActionEffect(effect({ snapshotAfter: '- button "Save"' }));

    expect(warning).toContain('had no visible effect');
    expect(warning).toContain('browser_click');
  });

  it('tells the model what to do next rather than only that it failed', () => {
    const warning = checkActionEffect(effect({ snapshotAfter: '- button "Save"' }));

    expect(warning).toContain('browser_snapshot');
    expect(warning).toContain('do not assume this step succeeded');
  });

  it.each(['browser_click', 'browser_select_option', 'browser_press_key'])(
    'checks %s for an effect',
    (toolName) => {
      expect(checkActionEffect(effect({ toolName, snapshotAfter: '- button "Save"' }))).toContain(
        'no visible effect',
      );
    },
  );
});

describe('checkActionEffect — typing', () => {
  function typing(text: unknown, snapshotAfter: string): ActionEffect {
    return effect({ toolName: 'browser_type', toolArgs: { text }, snapshotAfter });
  }

  it('is quiet when the typed text shows up in the snapshot', () => {
    expect(typingWarning('user@example.com', '- textbox "Email": user@example.com')).toBe('');
  });

  it('warns when the typed text is nowhere to be found', () => {
    const warning = typingWarning('user@example.com', '- textbox "Email"');

    expect(warning).toContain('does not appear in the page snapshot');
    expect(warning).toContain('user@example.com');
  });

  it('tells the model to re-snapshot and retype', () => {
    expect(typingWarning('abc', '- textbox "Email"')).toContain('type again with a fresh ref');
  });

  it('is quiet when typing navigated away — the field is gone for a good reason', () => {
    const result = checkActionEffect(
      effect({
        toolName: 'browser_type',
        toolArgs: { text: 'abc' },
        snapshotBefore: AT_LOGIN,
        snapshotAfter: 'Page URL: https://app.test/home\n- heading "Home"',
      }),
    );
    expect(result).toBe('');
  });

  it('ignores surrounding whitespace in the typed value', () => {
    expect(typingWarning('  abc  ', '- textbox "Name": abc')).toBe('');
  });

  it.each([['empty text', ''], ['whitespace only', '   '], ['a non-string', 42]])(
    'says nothing for %s',
    (_label, text) => {
      expect(checkActionEffect(typing(text, '- textbox "Email"'))).toBe('');
    },
  );

  it('does not fall back to the generic page-changed check for typing', () => {
    // Snapshot identical AND text absent: the typing-specific message must win.
    const warning = checkActionEffect(
      effect({ toolName: 'browser_type', toolArgs: { text: 'abc' }, snapshotBefore: 'same', snapshotAfter: 'same' }),
    );
    expect(warning).toContain('does not appear');
    expect(warning).not.toContain('no visible effect');
  });

  function typingWarning(text: string, snapshotAfter: string): string {
    return checkActionEffect(typing(text, snapshotAfter));
  }
});

describe('checkActionEffect — hover', () => {
  function hover(snapshotAfter: string, snapshotBefore = '- button "Menu"'): string {
    return checkActionEffect(effect({ toolName: 'browser_hover', snapshotBefore, snapshotAfter }));
  }

  it('is quiet when the hover revealed something', () => {
    expect(hover('- button "Menu"\n- menu "Settings"')).toBe('');
  });

  it('notes an unchanged snapshot rather than warning — hover styling is CSS-only', () => {
    const note = hover('- button "Menu"');

    expect(note).toContain('NOTE:');
    expect(note).not.toContain('WARNING:');
  });

  it('says the no-op is often fine, so the model does not retry pointlessly', () => {
    expect(hover('- button "Menu"')).toContain('often fine');
  });

  it('blocks the dangerous inference: clicking a menu item never seen in a snapshot', () => {
    expect(hover('- button "Menu"')).toContain('Do not click an item you have not seen in a snapshot');
  });

  it('is quiet when the hover navigated', () => {
    expect(hover(AT_HOME, AT_LOGIN)).toBe('');
  });

  it('says nothing on the first action, with no before-snapshot', () => {
    expect(checkActionEffect(effect({ toolName: 'browser_hover', snapshotBefore: null, snapshotAfter: '- x' }))).toBe('');
  });
});

describe('snapshotUrl', () => {
  it('reads the page url a snapshot reports', () => {
    expect(snapshotUrl(AT_LOGIN)).toBe('https://app.test/login');
  });

  it('is null when the snapshot reports none', () => {
    expect(snapshotUrl('- button "Save"')).toBeNull();
  });

  it('is null for an empty snapshot', () => {
    expect(snapshotUrl('')).toBeNull();
  });
});

describe('urlChangedBetween', () => {
  it('is true when the two snapshots report different urls', () => {
    expect(urlChangedBetween(AT_LOGIN, AT_HOME)).toBe(true);
  });

  it('is false when they report the same url', () => {
    expect(urlChangedBetween(AT_LOGIN, AT_LOGIN)).toBe(false);
  });

  it('is false — not a guess — when either snapshot reports no url', () => {
    expect(urlChangedBetween('- button "Save"', AT_HOME)).toBe(false);
    expect(urlChangedBetween(AT_LOGIN, '- button "Save"')).toBe(false);
  });

  it('is false when there is no before-snapshot at all', () => {
    expect(urlChangedBetween(null, AT_HOME)).toBe(false);
  });
});

describe('withEffectWarning', () => {
  it('returns the content unchanged when there is no warning', () => {
    expect(withEffectWarning('Clicked.', '')).toBe('Clicked.');
  });

  it('appends the warning below the content', () => {
    expect(withEffectWarning('Clicked.', 'WARNING: nope')).toBe('Clicked.\n\nWARNING: nope');
  });

  it('returns the warning alone when there is no content', () => {
    expect(withEffectWarning('', 'WARNING: nope')).toBe('WARNING: nope');
  });

  it('never loses the original tool output', () => {
    expect(withEffectWarning('important detail', 'WARNING: nope')).toContain('important detail');
  });
});
