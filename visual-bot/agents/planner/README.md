# agents/planner/

Pre-planning agents — run before `main/agent.ts` starts.

## Files

### `planner-agent.ts` — class `PlannerAgent`
Generates a step-by-step task execution plan based on the user's request + knowledge from the registry.

**What it does:**
- Accepts a task and optional memory context
- Enriches the request with site knowledge (page summary from the registry, visit history)
- Returns a numbered list of concrete steps with tool syntax

**Context sources (in priority order):**
1. Passed-in memory context
2. Page summary from the component registry
3. Visit history from memory

---

### `memory-analysis-agent.ts` — class `MemoryAnalysisAgent`
Analyzes the knowledge base (registry) and suggests relevant pages and navigation paths for the task.

**What it does:**
- Tokenizes the task into keywords
- Scores registry pages by keyword match
- Returns text with sections: "Relevant Pages", "Suggested Path", "Known Shortcuts"
- Limit: no more than `MAX_PAGES_IN_CONTEXT = 12` pages

**Used:** called before `PlannerAgent`, to pass it relevant context
