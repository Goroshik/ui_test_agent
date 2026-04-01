# visual-bot

A terminal AI agent that controls a browser via Playwright MCP and automatically
screenshots every step.

## Prerequisites

- Node.js 20+
- [LM Studio](https://lmstudio.ai/) with a tool-capable model loaded
- Playwright browsers installed

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

## Start LM Studio server

1. Open LM Studio
2. Load a model that supports tool/function calling (e.g. `qwen2.5-7b-instruct`,
   `mistral-nemo`, `llama-3.1-8b-instruct`)
3. Go to **Local Server** tab → click **Start Server**
4. The server runs at `http://localhost:1234/v1` by default

Set the model name in `.env` to match what you loaded:

```env
LM_STUDIO_MODEL=qwen2.5-7b-instruct
```

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
incoming screenshots against `./screenshots/baseline/` via LM Studio:

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

| Variable | Default | Description |
|---|---|---|
| `LM_STUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio server URL |
| `LM_STUDIO_MODEL` | `qwen2.5-7b-instruct` | Model identifier |
| `LM_STUDIO_API_KEY` | `lm-studio` | API key (any value works) |
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
