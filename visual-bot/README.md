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

```bash
node index.js "go to github.com and explore the navigation"
node index.js "search for 'playwright' on npmjs.com and open the first result"
node index.js "go to news.ycombinator.com and list the top 5 stories"
```

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

## Полный пайплайн (index.ts)

```
MemoryAnalysisAgent   — анализирует реестр, находит релевантные страницы
       ↓
PlannerAgent          — генерирует пошаговый план из задачи + контекста
       ↓
Agent (main)          — выполняет шаги в браузере, собирает артефакты
       ↓
PostRunCompareAgent   — сравнивает скриншоты и ARIA-снапшоты с baseline
       ↓
TaskVerificationAgent — проверяет выполнение задачи по финальному ARIA-снапшоту
       ↓
PipelineRunner        — анализирует артефакты → строит реестр компонентов
```

Для перезапуска только пайплайна без повторного выполнения задачи:

```bash
npx tsx visual-bot/run-pipeline.ts [sessionId]
```

## Структура файлов

```
visual-bot/
├── index.ts                  — точка входа, оркестратор
├── run-pipeline.ts           — standalone запуск анализа для сохранённой сессии
├── llm-provider.ts           — выбор провайдера и модели по роли (OpenRouter / Ollama)
├── ollama-model-manager.ts   — управление локальной моделью в Ollama (load/unload)
├── visual-diff.ts            — сравнение скриншотов через LLM
├── visual-text-diff.ts       — сравнение ARIA-снапшотов через LLM
├── attention-memory.ts       — накопление правил сравнения для снижения ложных срабатываний
├── registry-context.ts       — кэш и провайдер реестра компонентов для агентов
├── memory.ts                 — трекер посещённых URL
├── run-logger.ts             — логирование в файл и MongoDB
├── utils.ts                  — resolveModel, resizeForVision, parseDiffJson
├── agents/                   — все агенты (см. agents/README.md)
└── pipeline/                 — типы и файловые хранилища (см. pipeline/README.md)
```
