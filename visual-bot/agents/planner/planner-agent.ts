import OpenAI from 'openai';
import { resolveModel } from '../../utils.js';
import { getVisitSummary } from '../../memory.js';
import { getPageSummary } from '../../registry-context.js';
import { formatToolCatalogForPlanner } from '../../tool-catalog.js';

const PLANNER_SYSTEM_PROMPT = `You are a browser task planner. Your job is to analyze the user's goal and produce a precise, step-by-step execution plan for a browser automation agent.

IMPORTANT: Always respond in Russian. All step descriptions and comments must be in Russian.

## Tools the agent can call
${formatToolCatalogForPlanner()}

## Use what previous runs already learned
When the site knowledge below names a page relevant to the task, plan a
registry_get_page_components step for it before interacting — it returns the
selectors and assertions already recorded, so the agent does not rediscover the
page. When you know the control but not its page, plan registry_search_components.
Site knowledge paths are normalised: ":id" stands for any record identifier, so
/users/:id means "any user page" and the agent must substitute a real id.

## Output format
Return ONLY the execution plan as plain text — no JSON, no markdown fences.
Structure it as numbered steps. Each step must be one concrete action, for example:

1. Navigate to https://example.com
2. Call browser_snapshot to inspect the page
3. Call registry_get_page_components("/v1/login") to reuse known selectors
4. Find the "Login" button in the snapshot and click it
5. Type "user@example.com" into the email field
6. Call browser_snapshot to confirm the login form submitted

Rules:
- Be specific about URLs (include full https:// URL)
- After every navigation or interaction, remind the agent to call browser_snapshot
- If the task involves multiple pages, list them in order
- If credentials or data are needed and not provided, note them as [PLACEHOLDER]
- Keep steps granular — one action per step
- End with a step to call browser_snapshot and summarize what was verified. Do not
  plan a screenshot for verification: the agent and the verifier both read the
  accessibility snapshot, and screenshots may be disabled entirely.`;

export class PlannerAgent {
  private client: OpenAI;
  private model: string | null = null;
  private modelOverride: string | undefined;

  constructor(client: OpenAI, modelOverride?: string) {
    this.client = client;
    this.modelOverride = modelOverride;
  }

  /**
   * All three sources, each labelled — not the first non-empty one. The old
   * `analysis || pages || visits` chain meant a successful memory analysis threw
   * away the page/component summary the planner needs to name a registry lookup.
   */
  private async _resolveContext(memoryContext?: string): Promise<string> {
    const [pageSummary, visitSummary] = await Promise.all([getPageSummary(), getVisitSummary()]);
    return [
      memoryContext ? `### Navigation analysis\n${memoryContext}` : '',
      pageSummary ? `### Known pages and their components\n${pageSummary}` : '',
      visitSummary ? `### Visit history\n${visitSummary}` : '',
    ].filter((part) => part !== '').join('\n\n');
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
