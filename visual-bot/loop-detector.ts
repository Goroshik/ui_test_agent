/**
 * Loop Detector — scans the agent transcript for repeated steps.
 *
 * Every CHECK_EVERY iterations it takes the whole message history and checks
 * whether the agent is stuck in a loop (the same action 3+ times in a row).
 */

import type OpenAI from 'openai';

export interface LoopDetectionResult {
  isLoop: boolean;
  /** Name of the tool being repeated */
  repeatedTool?: string;
  /** How many times in a row it repeated */
  repeatCount?: number;
  /** Short description of the loop, for logging */
  summary?: string;
}

/** Run the check every N iterations */
const CHECK_EVERY = 10;

/** Minimum consecutive repeats to count as a loop */
const MIN_REPEATS = 3;

/**
 * Pulls every tool-call record out of the message history, in order.
 */
function extractToolCalls(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Array<{ tool: string; argsKey: string }> {
  const calls: Array<{ tool: string; argsKey: string }> = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (!msg.tool_calls) continue;

    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        // ignore parse errors
      }

      // Normalize the arguments into a comparison key. For clicks/hovers the
      // ref is dropped (it changes with every snapshot) but the element
      // description is kept.
      const normalizedArgs = normalizeArgs(tc.function.name, args);
      calls.push({ tool: tc.function.name, argsKey: normalizedArgs });
    }
  }

  return calls;
}

/**
 * Normalizes arguments for comparison — strips unstable fields (ref).
 */
function normalizeArgs(tool: string, args: Record<string, unknown>): string {
  const INTERACTION_TOOLS = new Set([
    'browser_click',
    'browser_hover',
    'browser_type',
    'browser_select_option',
  ]);

  if (INTERACTION_TOOLS.has(tool)) {
    // ref changes between snapshots, so it is excluded from the comparison
    const rest = { ...args };
    delete rest.ref;
    return JSON.stringify(rest);
  }

  return JSON.stringify(args);
}

/**
 * Checks whether the last MIN_REPEATS+ tool calls are identical.
 * Returns the analysis result.
 */
function detectLoop(
  calls: Array<{ tool: string; argsKey: string }>,
): LoopDetectionResult {
  if (calls.length < MIN_REPEATS) {
    return { isLoop: false };
  }

  const last = calls[calls.length - 1];
  if (!last) {
    return { isLoop: false };
  }
  let count = 0;

  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call && call.tool === last.tool && call.argsKey === last.argsKey) {
      count++;
    } else {
      break;
    }
  }

  if (count >= MIN_REPEATS) {
    return {
      isLoop: true,
      repeatedTool: last.tool,
      repeatCount: count,
      summary: `Agent repeated "${last.tool}" ${count} times in a row with identical arguments.`,
    };
  }

  return { isLoop: false };
}

/**
 * Call after each iteration.
 * Returns the check result (isLoop=false when it is not yet time to check).
 */
export function checkForLoop(
  iteration: number,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): LoopDetectionResult {
  if (iteration % CHECK_EVERY !== 0) {
    return { isLoop: false };
  }

  const calls = extractToolCalls(messages);
  return detectLoop(calls);
}
