# visual-bot

A terminal AI agent that controls a browser via Playwright MCP and automatically
screenshots every step.

## Prerequisites

- Node.js 20+
- An [OpenRouter](https://openrouter.ai/) API key (the default provider)
- Playwright browsers installed
- Optionally [Ollama](https://ollama.com/) — only if you route some role back to a local model

## Install

```bash
cd visual-bot
npm install
npx playwright install chromium
```

Copy the env file and edit if needed:

```bash
cp .env.example .env
```

## Configure the model provider

Every role (`main`, `planner`, `analyzer`, `coding`) runs on OpenRouter by
default, so the only mandatory setting is the key:

```env
OPENROUTER_API_KEY=sk-or-...
```

The default model is `deepseek/deepseek-v4-flash` — the cheapest DeepSeek on
OpenRouter as of 2026-07-26 ($0.09 / 1M input tokens, $0.18 / 1M output tokens,
1M-token context).

It is **text-only**, and the default pipeline is fine with that. Everything
works off ARIA snapshots (`browser_snapshot`):

| Stage | Input | Needs vision? |
|---|---|---|
| `Agent` — drives the browser | ARIA snapshot text | no — screenshots go to disk, never to the model |
| `TaskVerificationAgent` — did the task succeed? | last ARIA snapshot | no |
| `VisualTextDiff` — page vs baseline | ARIA snapshot text | no (`SNAPSHOT_ANALYSIS_ENABLED`) |
| `VisualDiff` — screenshot vs baseline | screenshot, resized to 512px | **yes** (`SCREENSHOT_ANALYSIS_ENABLED`) |

So the only reason to configure a second model is if you want the pixel diff:

```env
ANALYZER_MODEL=qwen/qwen3-vl-235b-a22b-instruct
```

Otherwise leave `SCREENSHOT_ANALYSIS_ENABLED=false` and stay on DeepSeek for the
whole run. Note that the component registry — and therefore the generated Cypress
tests — is built from ARIA/DOM/network only; no pixels feed into it either way.

To move a role — or everything — back to a local Ollama:

```env
LLM_PROVIDER=ollama          # all roles local
MAIN_PROVIDER=ollama         # or just this one
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MAIN_MODEL=qwen2.5-vl:7b
```

Leaving an `OLLAMA_*_MODEL` blank auto-picks whatever Ollama currently has
loaded (`/api/ps`). Ollama's load/unload model swapping is skipped automatically
when no role uses it.

## Usage

The pipeline is three steps. Run one, or run them back to back:

```bash
npx tsx visual-bot/run.ts crawl "log in and open the team page"   # 1. browse + record
npx tsx visual-bot/run.ts analyze                                # 2. build the registry
npx tsx visual-bot/run.ts generate                               # 3. write Cypress tests
npx tsx visual-bot/run.ts all "log in and open the team page"     # all three, in order
```

| Step | Reads | Writes |
|---|---|---|
| `crawl` | task prompt + `data/registry/` (site knowledge from past runs) | `data/sessions/<id>/`, `data/memory.json`, screenshots |
| `analyze` | `data/sessions/` | `data/registry/components.json`, `pages.json`, needs-testid report |
| `generate` | `data/registry/` | `cypress-tests/cypress/e2e/`, selectors, fixtures |

Each step is a separate process, so they are independently re-runnable: re-analyze
without re-crawling, regenerate without re-analyzing. `analyze` takes the most
recent session by default — pass `--session <id>` (or a positional id) for another.

If `all` fails partway, everything the earlier steps produced is already on disk;
fix the cause and re-run from the step that failed.

`yarn start` still runs crawl + analyze together as before, for compatibility.

Run snapshot comparison as a standalone agent:

```bash
npm run start:compare
```

Run screenshot comparison only:

```bash
npm run start:compare:screenshots
```

Run text snapshot comparison only:

```bash
npm run start:compare:snapshots
```

All artifacts are saved only to the project-root folder:
`D:/work/agent_for_tests/screenshots` (or `${process.cwd()}/screenshots`).

Screenshots are first saved to `./screenshots/incoming/` with sequential numbering.
After the main browser run finishes, a separate post-run visual agent compares
incoming screenshots against `./screenshots/baseline/` via the `analyzer` model:

- if baseline does not exist: screenshot is saved as baseline
- if no visual changes: new screenshot is deleted
- if changed: both images + text report are saved to `./screenshots/changes/`

Text snapshots (`browser_snapshot`) are saved to `./screenshots/snapshots-incoming/`
and compared separately against `./screenshots/snapshots-baseline/`. Changes are
stored in `./screenshots/snapshots-changes/`.

When a change is detected, the compare model also writes a short "attention rule"
to `./screenshots/attention-memory.json`. These rules are automatically injected
into future compare prompts so the model keeps focusing on previously missed UI
patterns (e.g. label renames).

File layout:

```
screenshots/
  incoming/
    001-navigate-github.com_20260331-121500.png
  baseline/
    navigate-github.com.png
  changes/
    20260331-121530-navigate-github.com/
      old.png
      new.png
      changes.txt
```

Important: `./visual-bot/screenshots` is not used by runtime logic.

## Environment variables

See `.env.example` for the full annotated list. The provider-related ones:

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | _(required)_ | OpenRouter key |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter endpoint |
| `OPENROUTER_MODEL` | `deepseek/deepseek-v4-flash` | Default model for every role |
| `LLM_PROVIDER` | `openrouter` | Default provider: `openrouter` or `ollama` |
| `<ROLE>_PROVIDER` | _(inherits `LLM_PROVIDER`)_ | Per-role provider (`MAIN`, `PLANNER`, `ANALYZER`, `CODING`) |
| `<ROLE>_MODEL` | _(inherits the provider default)_ | Per-role model override |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Local Ollama endpoint (opt-in) |
| `OLLAMA_API_KEY` | `ollama` | API key (any value works) |
| `MODEL_SWITCHING_ENABLED` | `true` | Ollama load/unload swapping; ignored when no role is local |
| `MAX_ITERATIONS` | `30` | Max agent steps before stopping |
| `ATTENTION_MEMORY_MAX` | `200` | Max saved compare attention rules |
| `DEBUG` | _(unset)_ | Set to `1` to show MCP logs and tool results |

## Debug mode

```bash
DEBUG=1 node index.js "go to example.com"
```

## How it works

```
index.js
  └── Agent.run(prompt)
        ├── MCPClient.connect()   — spawns @playwright/mcp via stdio JSON-RPC
        ├── loop:
        │     LLM → tool_calls → MCPClient.callTool()
        │                      → Screenshotter.capture()  (auto after every call)
        │                      → feed result back to LLM
        └── LLM returns final text → done
```

The agent uses the [Model Context Protocol](https://modelcontextprotocol.io/) to
communicate with the Playwright browser server. All available browser tools
(navigate, click, type, select, evaluate, etc.) are discovered dynamically and
forwarded to the LLM as OpenAI-compatible function definitions.

## Full pipeline (index.ts)

```
MemoryAnalysisAgent   — analyzes the registry, finds relevant pages
       ↓
PlannerAgent          — generates a step-by-step plan from the task + context
       ↓
Agent (main)          — executes the steps in the browser, collects artifacts
       ↓
PostRunCompareAgent   — compares screenshots and ARIA snapshots against baseline
       ↓
TaskVerificationAgent — verifies task completion from the final ARIA snapshot
       ↓
PipelineRunner        — analyzes artifacts → builds the component registry
```

To rerun just the pipeline without re-executing the task:

```bash
npx tsx visual-bot/run-pipeline.ts [sessionId]
```

## File structure

```
visual-bot/
├── index.ts                  — entry point, orchestrator
├── run-pipeline.ts           — standalone analysis run for a saved session
├── run.ts                    — CLI: crawl / analyze / generate / all
├── steps.ts                  — what to run at each step (pure module)
├── llm-provider.ts           — provider and model selection per role (OpenRouter / Ollama)
├── tool-catalog.ts           — single source of truth: tool names, schemas, and prompt descriptions
├── url-path.ts               — path normalization (:id instead of record identifiers)
├── ollama-model-manager.ts   — local model management in Ollama (load/unload)
├── visual-diff.ts            — screenshot comparison via LLM
├── visual-text-diff.ts       — ARIA snapshot comparison via LLM
├── attention-memory.ts       — accumulates comparison rules to reduce false positives
├── registry-context.ts       — cache and provider of the component registry for agents
├── memory.ts                 — tracker of visited URLs
├── run-logger.ts             — logging to file and MongoDB
├── utils.ts                  — resolveModel, resizeForVision, parseDiffJson
├── agents/                   — all agents (see agents/README.md)
└── pipeline/                 — types and file storage (see pipeline/README.md)
```
