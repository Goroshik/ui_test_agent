import { describe, it, expect } from 'vitest';
import { checkActionEffect, withEffectWarning, type ActionEffect } from './action-effect.js';

function effect(overrides: Partial<ActionEffect> = {}): ActionEffect {
  return {
    toolName: 'browser_click',
    toolArgs: {},
    snapshotBefore: '- button "Save"',
    snapshotAfter: '- button "Save"\n- alert "Saved"',
    urlChanged: false,
    ...overrides,
  };
}

describe('checkActionEffect — tools it ignores', () => {
  it.each(['browser_snapshot', 'browser_navigate', 'browser_wait_for', 'browser_hover'])(
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

  it('is quiet when the URL changed even though the snapshot did not', () => {
    expect(
      checkActionEffect(effect({ snapshotAfter: '- button "Save"', urlChanged: true })),
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
      effect({ toolName: 'browser_type', toolArgs: { text: 'abc' }, snapshotAfter: '- heading "Home"', urlChanged: true }),
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
