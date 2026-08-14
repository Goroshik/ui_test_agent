# agents/

Root directory for all visual-bot agents. Each subfolder is a separate area of responsibility in the overall pipeline.

## Files in the root

### `base-compare-agent.ts`
Abstract base class for comparison agents (template method). Encapsulates the logic: read incoming files → compare with baseline → rotate files. Subclasses implement `readContent()` and `runDiff()`.

Used in: `snapshot-compare/`, `snapshot-text-compare/`

## Subfolders

| Folder | What it does |
|-------|-----------|
| `main/` | Main browser automation agent (LLM + Playwright MCP) |
| `planner/` | Task planning and memory analysis before a run |
| `pipeline/` | Post-run analysis: ARIA, DOM, network → component registry |
| `dom-components/` | Two-stage analysis of UI blocks from ARIA snapshots |
| `post-run/` | Comparison orchestrator + task-completion verification |
| `snapshot-compare/` | Visual comparison of screenshots (PNG/JPG) |
| `snapshot-text-compare/` | Text comparison of ARIA snapshots (.txt) |

## Overall execution flow

```
[User gives a task]
       ↓
planner/ → generates a step plan
       ↓
main/agent.ts → executes steps in the browser, collects data
       ↓
pipeline/ → analyzes the collected data → registry/
       ↓
post-run/ → compares screenshots/snapshots + verifies the result
```
