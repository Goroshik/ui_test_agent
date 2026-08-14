# agents/main/

Main browser automation agent.

## Files

### `agent.ts` — `Agent` class
The core executor agent. Manages the LLM loop, browser tools, and data collection for the pipeline.

**What it does:**
- Runs an iterative LLM loop (`run(prompt)`) until the task is complete or `MAX_ITERATIONS` is reached
- Connects to Playwright via an MCP server (`MCPClient`)
- Executes 50+ browser tools (navigate, click, type, hover, snapshot, etc.)
- Takes a screenshot and/or an ARIA snapshot after every page change
- Collects structured data for the pipeline: ARIA, DOM, network, storage, screenshots (`SessionCollector`)
- Logs every step to MongoDB
- Detects loops (loop detector)

**Dependencies:**
- `openai` — LLM client (via OpenRouter by default, see `llm-provider.ts`)
- `mongodb` — step logging
- `MCPClient` — Playwright MCP
- `Screenshotter` — screen capture
- `SessionCollector` — pipeline data collection
- `registry-context`, `memory.ts` — page and visit context

**Environment variables:**
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` — connection to OpenRouter (default provider)
- `MAIN_PROVIDER` / `LLM_PROVIDER` — `openrouter` (default) or `ollama`
- `MAIN_MODEL` — the model for this role; needs to be a vision model if screenshots are enabled
- `OLLAMA_BASE_URL`, `OLLAMA_API_KEY` — connection to a local Ollama instance (if selected)
- `MAX_ITERATIONS` (default: 60)
- `PIPELINE_ENABLED` — enable pipeline data collection
- `SCREENSHOTS_ENABLED`, `SNAPSHOTS_ENABLED`
- `DEBUG` — verbose logging
