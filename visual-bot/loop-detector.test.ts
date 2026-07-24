import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { checkForLoop } from './loop-detector.js';

type Message = OpenAI.Chat.ChatCompletionMessageParam;

/** Builds an assistant message carrying the given tool calls. */
function assistantCall(...calls: Array<{ name: string; args: string }>): Message {
  return {
    role: 'assistant',
    tool_calls: calls.map((c, i) => ({
      id: `call_${i}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args },
    })),
  };
}

/** Repeats one identical tool call n times, each in its own message. */
function repeat(n: number, name: string, args: string): Message[] {
  return Array.from({ length: n }, () => assistantCall({ name, args }));
}

describe('checkForLoop', () => {
  it('skips the check when the iteration is not a multiple of 10', () => {
    const messages = repeat(5, 'browser_click', '{"element":"Submit"}');
    // Iterations 1..9 must not even look at the history.
    for (const iteration of [1, 3, 7, 9, 11]) {
      expect(checkForLoop(iteration, messages)).toEqual({ isLoop: false });
    }
  });

  it('flags a loop when the same tool repeats 3 times in a row', () => {
    const messages = repeat(3, 'browser_click', '{"element":"Submit"}');
    const result = checkForLoop(10, messages);

    expect(result.isLoop).toBe(true);
    expect(result.repeatedTool).toBe('browser_click');
    expect(result.repeatCount).toBe(3);
    expect(result.summary).toContain('browser_click');
    expect(result.summary).toContain('3');
  });

  it('does not flag a loop at only 2 repeats', () => {
    const messages = repeat(2, 'browser_click', '{"element":"Submit"}');
    expect(checkForLoop(10, messages)).toEqual({ isLoop: false });
  });

  it('reports the full streak length, not just the minimum', () => {
    const messages = repeat(5, 'browser_hover', '{"element":"Menu"}');
    expect(checkForLoop(10, messages).repeatCount).toBe(5);
  });

  it('counts only the trailing streak, ignoring earlier identical calls', () => {
    const messages = [
      ...repeat(4, 'browser_click', '{"element":"Old"}'),
      ...repeat(3, 'browser_type', '{"text":"hi"}'),
    ];
    const result = checkForLoop(10, messages);

    expect(result.repeatedTool).toBe('browser_type');
    expect(result.repeatCount).toBe(3);
  });

  it('breaks the streak when a different tool is interleaved', () => {
    const messages = [
      ...repeat(2, 'browser_click', '{"element":"Submit"}'),
      assistantCall({ name: 'browser_snapshot', args: '{}' }),
      ...repeat(2, 'browser_click', '{"element":"Submit"}'),
    ];
    expect(checkForLoop(10, messages)).toEqual({ isLoop: false });
  });

  it('ignores the volatile "ref" argument for interaction tools', () => {
    // Same element, different ref each snapshot — this IS a loop.
    const messages: Message[] = [
      assistantCall({ name: 'browser_click', args: '{"ref":"e11","element":"Submit"}' }),
      assistantCall({ name: 'browser_click', args: '{"ref":"e42","element":"Submit"}' }),
      assistantCall({ name: 'browser_click', args: '{"ref":"e77","element":"Submit"}' }),
    ];
    const result = checkForLoop(10, messages);

    expect(result.isLoop).toBe(true);
    expect(result.repeatCount).toBe(3);
  });

  it('still distinguishes interaction calls that differ beyond "ref"', () => {
    const messages: Message[] = [
      assistantCall({ name: 'browser_click', args: '{"ref":"e1","element":"A"}' }),
      assistantCall({ name: 'browser_click', args: '{"ref":"e2","element":"B"}' }),
      assistantCall({ name: 'browser_click', args: '{"ref":"e3","element":"C"}' }),
    ];
    expect(checkForLoop(10, messages)).toEqual({ isLoop: false });
  });

  it('keeps "ref" significant for non-interaction tools', () => {
    // browser_snapshot is not in INTERACTION_TOOLS, so differing refs break the streak.
    const messages: Message[] = [
      assistantCall({ name: 'browser_snapshot', args: '{"ref":"e1"}' }),
      assistantCall({ name: 'browser_snapshot', args: '{"ref":"e2"}' }),
      assistantCall({ name: 'browser_snapshot', args: '{"ref":"e3"}' }),
    ];
    expect(checkForLoop(10, messages)).toEqual({ isLoop: false });
  });

  it('treats unparsable tool arguments as empty rather than throwing', () => {
    const messages = repeat(3, 'browser_click', 'not-json-at-all');
    const result = checkForLoop(10, messages);

    // All three normalize to the same empty-args key, so it is still a loop.
    expect(result.isLoop).toBe(true);
    expect(result.repeatCount).toBe(3);
  });

  it('ignores non-assistant messages and assistant messages without tool calls', () => {
    const messages: Message[] = [
      { role: 'system', content: 'you are a bot' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'thinking...' },
      ...repeat(3, 'browser_click', '{"element":"Submit"}'),
    ];
    expect(checkForLoop(10, messages).isLoop).toBe(true);
  });

  it('returns no loop for an empty history', () => {
    expect(checkForLoop(10, [])).toEqual({ isLoop: false });
  });

  it('collects several tool calls carried in a single assistant message', () => {
    const messages: Message[] = [
      assistantCall(
        { name: 'browser_click', args: '{"element":"Submit"}' },
        { name: 'browser_click', args: '{"element":"Submit"}' },
        { name: 'browser_click', args: '{"element":"Submit"}' },
      ),
    ];
    expect(checkForLoop(10, messages).repeatCount).toBe(3);
  });
});
