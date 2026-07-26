import OpenAI from 'openai';
import { resolveModel } from '../../utils.js';
import { getVisitSummary } from '../../memory.js';
import { getPageSummary } from '../../registry-context.js';

const PLANNER_SYSTEM_PROMPT = `You are a browser task planner. Your job is to analyze the user's goal and produce a precise, step-by-step execution plan for a browser automation agent.

IMPORTANT: Always respond in Russian. All step descriptions and comments must be in Russian.

## Available browser tools
- browser_navigate(url) — navigate to a URL
- browser_snapshot() — get the current page accessibility tree (ALWAYS call before any interaction)
- browser_click(element, ref) — click an element by ref from snapshot
- browser_type(element, ref, text, submit?, slowly?) — type text into an input
- browser_select_option(element, ref, values) — pick a dropdown option
- browser_press_key(key) — press a keyboard key
- browser_hover(element, ref) — hover over an element
- browser_wait_for(text?, textGone?, time?) — wait for condition
- browser_take_screenshot() — capture a screenshot
- browser_navigate_back() / browser_navigate_forward() — browser history
- browser_tab_new(url?) / browser_tab_select(index) / browser_tab_close() — tab management

## Output format
Return ONLY the execution plan as plain text — no JSON, no markdown fences.
Structure it as numbered steps. Each step must be one concrete action, for example:

1. Navigate to https://example.com
2. Call browser_snapshot to inspect the page
3. Find the "Login" button in the snapshot and click it
4. Type "user@example.com" into the email field
5. Take a screenshot to confirm the login form is visible

Rules:
- Be specific about URLs (include full https:// URL)
- After every navigation or interaction, remind the agent to call browser_snapshot
- If the task involves multiple pages, list them in order
- If credentials or data are needed and not provided, note them as [PLACEHOLDER]
- Keep steps granular — one action per step
- End with a step to take a final screenshot and summarize what was verified`;

export class PlannerAgent {
  private client: OpenAI;
  private model: string | null = null;
  private modelOverride: string | undefined;

  constructor(client: OpenAI, modelOverride?: string) {
    this.client = client;
    this.modelOverride = modelOverride;
  }

  private async _resolveContext(memoryContext?: string): Promise<string> {
    // Priority: rich analysis → known pages summary → basic URL list
    return memoryContext || await getPageSummary() || await getVisitSummary();
  }

  private _buildUserMessage(userTask: string, context: string): string {
    if (!context) return `Task: ${userTask}`;
    return `Task: ${userTask}\n\n## Site knowledge from previous runs\n${context}`;
  }

  private _extractPlanText(response: OpenAI.Chat.Completions.ChatCompletion): string {
    const choice = response.choices[0];
    return choice?.message.content?.trim() ?? '';
  }

  async plan(userTask: string, memoryContext?: string): Promise<string> {
    if (!this.model) {
      this.model = await resolveModel(this.client, this.modelOverride);
    }

    const context = await this._resolveContext(memoryContext);
    const userMessage = this._buildUserMessage(userTask, context);

    console.log('\n[Planner] Generating execution plan...');

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
    });

    const plan = this._extractPlanText(response);

    if (!plan) {
      throw new Error('Planner returned an empty plan');
    }

    console.log('\n[Planner] Execution plan:');
    console.log('─'.repeat(50));
    console.log(plan);
    console.log('─'.repeat(50));

    return plan;
  }
}
