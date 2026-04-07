/**
 * Loop Detector — анализирует переписку с агентом на повторяющиеся шаги.
 *
 * Каждые CHECK_EVERY итераций берёт всю историю сообщений и проверяет,
 * не застрял ли агент в петле (одно и то же действие 3+ раз подряд).
 */

import type OpenAI from 'openai';

export interface LoopDetectionResult {
  isLoop: boolean;
  /** Название инструмента, который повторяется */
  repeatedTool?: string;
  /** Сколько раз подряд он повторился */
  repeatCount?: number;
  /** Краткое описание петли для логирования */
  summary?: string;
}

/** Проверять каждые N итераций */
const CHECK_EVERY = 10;

/** Минимум повторений подряд для считать петлёй */
const MIN_REPEATS = 3;

/**
 * Вытаскивает все tool-call записи из истории сообщений по порядку.
 */
function extractToolCalls(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Array<{ tool: string; argsKey: string }> {
  const calls: Array<{ tool: string; argsKey: string }> = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const m = msg as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    if (!m.tool_calls) continue;

    for (const tc of m.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        // ignore parse errors
      }

      // Нормализуем аргументы в ключ для сравнения.
      // Для кликов/ховеров — убираем ref (он меняется каждый snapshot),
      // но оставляем element-описание.
      const normalizedArgs = normalizeArgs(tc.function.name, args);
      calls.push({ tool: tc.function.name, argsKey: normalizedArgs });
    }
  }

  return calls;
}

/**
 * Нормализует аргументы для сравнения — убирает нестабильные поля (ref).
 */
function normalizeArgs(tool: string, args: Record<string, unknown>): string {
  const INTERACTION_TOOLS = new Set([
    'browser_click',
    'browser_hover',
    'browser_type',
    'browser_select_option',
  ]);

  if (INTERACTION_TOOLS.has(tool)) {
    // ref меняется между snapshot-ами, не сравниваем его
    const { ref: _ref, ...rest } = args as { ref?: unknown; [k: string]: unknown };
    return JSON.stringify(rest);
  }

  return JSON.stringify(args);
}

/**
 * Проверяет последние MIN_REPEATS+ tool-call на идентичность.
 * Возвращает результат анализа.
 */
function detectLoop(
  calls: Array<{ tool: string; argsKey: string }>,
): LoopDetectionResult {
  if (calls.length < MIN_REPEATS) {
    return { isLoop: false };
  }

  const last = calls[calls.length - 1];
  let count = 0;

  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].tool === last.tool && calls[i].argsKey === last.argsKey) {
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
      summary: `Агент повторяет "${last.tool}" ${count} раз подряд с одинаковыми аргументами.`,
    };
  }

  return { isLoop: false };
}

/**
 * Вызывать после каждой итерации.
 * Возвращает результат проверки (isLoop=false если ещё рано проверять).
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
