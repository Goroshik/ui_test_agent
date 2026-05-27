import { createProvider } from '../../llm-provider.js';

const MAX_TOKENS = parseInt(process.env.CODING_MAX_TOKENS || '16000', 10);

export async function runLlm(prompt: string, modelOverride?: string): Promise<string> {
  const { client, model, kind } = createProvider('coding');
  const effectiveModel = modelOverride || model;
  if (!effectiveModel) {
    throw new Error(
      'No model configured for role="coding". Set CODING_MODEL or OPENROUTER_MODEL in .env',
    );
  }

  const resp = await client.chat.completions.create({
    model: effectiveModel,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: MAX_TOKENS,
    temperature: 0,
  });

  const text = resp.choices[0]?.message?.content;
  if (!text) {
    throw new Error(`Empty response from ${kind} (model=${effectiveModel})`);
  }
  return stripReasoning(text).trim();
}

/**
 * Reasoning models (qwen3, deepseek-r1, …) prefix output with <think>…</think>.
 * Strip it so downstream parsers see clean code/JSON.
 */
function stripReasoning(text: string): string {
  let out = text;
  // Closed think blocks.
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Unclosed block (model ran out of tokens mid-thought) — drop everything up to
  // the last </think>, or if none, up to the first real content marker.
  if (/<think>/i.test(out)) {
    const lastClose = out.toLowerCase().lastIndexOf('</think>');
    if (lastClose >= 0) out = out.slice(lastClose + '</think>'.length);
    else out = out.replace(/<think>[\s\S]*$/i, '');
  }
  return out;
}
