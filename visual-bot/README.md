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

Screenshots are saved to `./screenshots/` with sequential numbering:

```
screenshots/
  001-navigate-github.com.png
  002-screenshot.png
  003-click-sign_in.png
  ...
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `LM_STUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio server URL |
| `LM_STUDIO_MODEL` | `qwen2.5-7b-instruct` | Model identifier |
| `LM_STUDIO_API_KEY` | `lm-studio` | API key (any value works) |
| `MAX_ITERATIONS` | `30` | Max agent steps before stopping |
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
