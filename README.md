# visual-bot

Terminal AI agent that drives a real browser through [Playwright MCP](https://github.com/microsoft/playwright-mcp),
records everything it does, and turns that recording into Cypress tests.

You describe a task in plain language. The agent opens the browser, works through
the task using accessibility snapshots, and saves every step — DOM, network,
storage, screenshots. A post-run pipeline then turns those raw artifacts into a
component registry, and generators turn the registry into runnable `.cy.js`
specs with selectors and fixtures.

```bash
yarn start "log in as admin and open the policies page"
```

## Why it works off accessibility snapshots

The agent does not look at pixels to decide what to click. Each step it asks
Playwright for an ARIA snapshot, finds the element by role and accessible name,
and acts on the `ref` from that snapshot. That is what makes the recording
reusable: a role plus an accessible name survives a redeploy, while coordinates
and generated class names do not.

Screenshots are still captured, but only for the optional visual-diff pass.

## Requirements

| | |
|---|---|
| Node | 20+ |
| Package manager | **yarn** v1 (`yarn install`) |
| LLM | An [OpenRouter](https://openrouter.ai/keys) API key — or a local Ollama |
| MongoDB | Optional; used to log runs and steps |

TypeScript throughout, ESM (`"type": "module"`), run directly with `tsx` — there
is no build step for normal use.

## Setup

```bash
yarn install
cp .env.example .env
```

Then put an OpenRouter key in `.env`:

```
OPENROUTER_API_KEY=sk-or-...
```

That is the only mandatory setting. Everything else in `.env.example` is
documented inline and has a working default.

### Model roles

Four roles are configured independently, so you can spend money where it matters:

| Role | Used for |
|---|---|
| `main` | browser execution — the agent loop itself |
| `planner` | memory analysis and turning a task into steps |
| `analyzer` | snapshot/screenshot comparison, verification, the analysis pipeline |
| `coding` | generating tests, selectors and fixtures |

Each role takes a provider (`openrouter` by default, or `ollama`) and an optional
model override — `MAIN_PROVIDER`, `ANALYZER_MODEL`, and so on. `LLM_PROVIDER` and
`OPENROUTER_MODEL` set the defaults for all four.

The default model is text-only, which suits the whole default path: both the
browser agent and the verifier work from ARIA snapshots and never send an image.
If you enable `SCREENSHOT_ANALYSIS_ENABLED`, give `ANALYZER_MODEL` a
vision-capable model — otherwise prefer the ARIA diff
(`SNAPSHOT_ANALYSIS_ENABLED`).

To run entirely locally, set `LLM_PROVIDER=ollama`. Local phases load their model
before running and unload it after, so a modest GPU can host several roles.

## What a run does

`yarn start "<task>"` executes these stages. Most are individually switchable in
`.env`.

1. **Plan** — memory analysis over what previous runs learned about the app, then
   a concrete step list. Skip with `PLANNER_ENABLED=false`.
2. **Execute** — the agent loop: ARIA snapshot → pick element → act → record.
   After each action it re-snapshots to confirm the click or keystroke actually
   landed (`ACTION_EFFECT_CHECK_ENABLED`), which is what stops it building on a
   step that never happened. A loop detector watches for the same action
   repeating and halts the run.
3. **Verify** — checks from the final ARIA snapshot whether the task actually
   completed. On failure the run is retried (`MAX_RETRIES`, default 2).
4. **Analyze** — the post-run pipeline, below.
5. **Compare** — optional diff of snapshots and screenshots against stored
   baselines, so drift in the app surfaces between runs.

Every step lands in `data/sessions/<session-id>/`:

```
session-meta.json      run metadata and a summary per step
steps/step-NNN.json    one record per action: what, where, and the artifacts
raw/dom/               structured dumps of interactive elements
raw/network/           requests captured during the step
raw/screenshots/
raw/storage/           written, but currently always empty — see below
analyzed/              output of the pipeline stages
```

Two things a newcomer would otherwise trip over:

- **`raw/storage/` is a stub.** The agent writes the file but passes empty
  objects, so localStorage, sessionStorage and cookies are not actually captured
  yet. `SessionCollector.saveStorage()` is ready for real data.
- **`raw/aria/` only appears in older sessions.** ARIA snapshots are no longer
  persisted per step — the structured DOM dump carries what the analyzers need.
  The agent still uses ARIA snapshots live, and `saveAriaSnapshot()` still exists,
  it is just no longer called.

## The analysis pipeline

```bash
yarn pipeline              # latest session
yarn pipeline <session-id> # a specific one
```

Reads a recorded session and builds a component registry:

1. **ARIA, DOM and network analysis** run in parallel over the raw artifacts.
2. **Identity resolution** decides which observations across steps and pages are
   the *same* component — deterministically by testid, role+name or tag+text, and
   only falling back to the LLM when that is genuinely ambiguous. The result is a
   canonical id per component.
3. **Classification** grades every component's selectors and writes a report.

Outputs:

| File | Contents |
|---|---|
| `data/registry/components.json` | every known component: selectors, actions, assertions, confidence |
| `data/registry/pages.json` | which components live on which page |
| `data/reports/classification.json` | machine-readable selector grading |
| `data/reports/needs-testid.md` | **read this one** — components a developer should add a `data-testid` to |

`needs-testid.md` is the useful human artifact. A component the user interacted
with but which has no stable hook cannot be tested reliably, so it is listed with
a suggested testid. Until someone adds it, the generated spec for it is skipped
rather than silently flaky.

## Generating Cypress tests

```bash
yarn test
```

Runs the generator chain in order, each step feeding the next:

| Step | Output |
|---|---|
| test planner | `cypress-tests/test-plan.json` — scenarios per page |
| selectors generator | `cypress-tests/cypress/support/selectors.js` |
| fixtures generator | `cypress-tests/cypress/fixtures/*--success.json`, `*--error.json` |
| test generator | `cypress-tests/cypress/e2e/**/*.cy.js` |
| validator | fails on generated specs that break Cypress rules |

The validator is the reason to trust the output: it rejects forbidden
cross-framework patterns, `cy.intercept` registered after `cy.visit`, and
fixture references that do not exist on disk.

Run the generated suite:

```bash
yarn test:ui
```

### Adversarial pass

```bash
npx tsx visual-bot/run-adversarial.ts            # latest session
npx tsx visual-bot/run-adversarial.ts <session-id>
```

Replays each grounded edge case against the real app — over-long input, wrong
format, a required field left empty — and records what the app actually did
(navigated, showed a validation error, marked the field invalid, or silently
swallowed it). Those observations make the generated assertions describe real
behaviour instead of a guess.

## Quality gates

Quality here is verified by machine, not by reading diffs:

```bash
yarn gate
```

Runs `typecheck` → `lint` → `coverage` → `crap` → `mutation`, stopping at the
first failure. `yarn gate:quick` (typecheck + lint) is the fast loop.

Thresholds, the rationale behind them, and two ways CRAP can silently report 0%
coverage on Windows are documented in
[docs/quality-gates.md](docs/quality-gates.md). **Read that before touching a
config** — a well-tested function reporting 0% is usually a signature-formatting
problem, not a missing test.

The rules that apply when a gate fails are in [CLAUDE.md](CLAUDE.md): thresholds
are never lowered, suppressions are forbidden, and gate configs are
write-protected. Fix the code or the tests.

## Layout

```
visual-bot/
  index.ts                  entry point: plan → execute → verify → analyze
  run-pipeline.ts           analysis pipeline on a recorded session
  run-adversarial.ts        adversarial replay pass
  agents/
    main/                   the browser agent loop
    planner/                memory analysis and step planning
    pipeline/               ARIA, DOM, network, identity resolution, reporting
    post-run/               task verification and snapshot comparison
    adversarial/            edge-case replay
    dom-components/         DOM splitting and hashing
  generators/               planner, selectors, fixtures, tests
  validators/               generated-spec validation
  pipeline/                 session collector, stores, shared types
scripts/                    gate runner and its helpers
cypress-tests/              generated suite (its own package)
data/                       sessions, registry, reports — produced at runtime
```

## Further reading

Most directories carry their own README with file-by-file detail — those are the
place to look before changing a module, and several are in Russian:

| | |
|---|---|
| [visual-bot/](visual-bot/README.md) | agent internals and prerequisites |
| [visual-bot/agents/](visual-bot/agents/README.md) | what each agent group is responsible for |
| [visual-bot/agents/main/](visual-bot/agents/main/README.md) | the browser agent loop |
| [visual-bot/agents/pipeline/](visual-bot/agents/pipeline/README.md) | analysis stages and identity resolution |
| [visual-bot/agents/planner/](visual-bot/agents/planner/README.md) | memory analysis and planning |
| [visual-bot/agents/post-run/](visual-bot/agents/post-run/README.md) | verification and comparison |
| [visual-bot/pipeline/](visual-bot/pipeline/README.md) | session collector and stores |
| [docs/quality-gates.md](docs/quality-gates.md) | thresholds, and the CRAP pitfalls |
| [docs/cypress-cheatsheet.md](docs/cypress-cheatsheet.md) | conventions the generated specs follow |

Open work is tracked in [TODO.md](TODO.md) and the `TODO-*.md` files.

## Notes

- The agent is instructed to narrate in Russian; its step commentary and the
  verifier's reasons are stored that way in logs and Mongo. Source code and
  comments are English. Changing that is a one-line edit to `SYSTEM_PROMPT` in
  `visual-bot/agents/main/agent.ts`.
- `data/` and `screenshots/` are runtime output and mostly gitignored; the
  registry and reports are the parts worth keeping.
- Mongo is optional — without `MONGO_URI` a run still works, it just is not
  logged to the database.
