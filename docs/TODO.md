# TODO / Ideas to think about

Backlog of improvements collected while building the test-generation pipeline.
Sorted roughly by leverage. Each item: **why** + **rough effort** + **what we have today**.

---

## 1. Feedback loop from Cypress runs

**Why.** Right now we generate tests and forget about them. We don't know which
tests pass, which fail, which are flaky. Every regeneration starts blind.

**What we have.** Cypress writes results to `cypress-tests/cypress/screenshots/`
+ videos. No JSON aggregation.

**What to add.**
- Run Cypress with `--reporter json --reporter-options output=results.json`
- Parser script reads `results.json` → MongoDB collection `test_runs`
  `{ specFile, title, status, durationMs, error, screenshot, sessionId, generatedAt }`
- `yarn generate:tests --feedback` reads last failures and includes them in the
  prompt: *"the previous version of this test failed with: <error>. Fix it."*

**Effort.** Low — half a day. Pure plumbing, no LLM.

---

## 2. `data/memory/lessons-learned.md`

**Why.** Agent has no persistent memory across sessions. Same mistakes repeat
(forgetting to mock `/auth/get-user`, wrong fixture names, etc.).

**What to add.**
- Append-only markdown file with rules learned from past runs.
  Format: `- [2026-05-26] On login page, app crashes if /auth/get-user isn't mocked first`
- Inject into both `test-planner` and `test-generator` prompts.
- Hand-curated initially. Later — auto-extract from failed test runs (see #1).

**Effort.** Low — 1 hour. Big payoff because lessons compound.

---

## 3. Edge-case catalog (`docs/edge-cases.md`)

**Why.** LLM doesn't naturally write good negative tests. Currently produces
generic "network 500" cases. Needs a structured catalog per component type
(textbox → empty, max length, XSS, unicode, SQL injection, etc.).

**What to add.**
- `docs/edge-cases.md` — YAML-ish catalog: component-type → list of edge cases
- `test-planner` reads it and emits richer `scenario.edgeCases`
- `test-generator` produces an `it()` per edge case

**Effort.** Medium — half a day for catalog + plumbing. Quality jump should be
visible immediately.

---

## 4. Validator → generator feedback loop

**Why.** Validator finds violations after the fact. By then the test is already
written. If we wired it into generation, one retry would fix most issues.

**What to add.**
```ts
let code = await runLlm(prompt);
let attempt = 0;
while (attempt < 2) {
  const violations = validate(code);
  if (violations.length === 0) break;
  code = await runLlm(fixupPrompt(code, violations));
  attempt++;
}
```

**Effort.** Low — 2 hours. Pure win since validator already exists.

---

## 5. Component-level knowledge in registry

**Why.** Every component is a blank slate. We don't remember "this textbox
crashes on empty submit" or "this dropdown needs scroll-into-view first".

**What to add.**
- Extend `ComponentRecord` with:
  ```ts
  knownIssues: Array<{ issue: string; workaround: string; firstSeen: string }>;
  successfulTests: number;
  failedTests: number;
  ```
- After Cypress run (see #1), update these fields automatically.
- `test-generator` mentions known issues in the prompt for that component.

**Effort.** Medium — 1 day. Real benefit accrues over weeks of runs.

---

## 6. Two-step generation (decompose)

**Why.** One mega-prompt asks LLM to do too much: pick scenarios + write happy
path + write edge cases + handle fixtures + format correctly. Smaller prompts
hallucinate less.

**What to add.**
- Step 1 — `test-brainstormer`: outputs JSON list of `it()` titles + types
  (`happy`/`edge`) + what each tests. No code yet.
- Step 2 — `test-coder`: receives ONE `it()` spec, writes ONE `it()` body.
  Loop over the list.

**Effort.** Medium — 1 day. Could even run step 2 in parallel for speed.

---

## 7. Prompt libraries to evaluate

In rough order of usefulness for this project:

- **Instructor** (Python) or Anthropic native tool-use — force structured JSON
  output for `test-planner` / `test-brainstormer`. No more regex parsing.
- **Promptfoo** — A/B test prompts on a regression set. We need a small dataset
  of "task → ideal `.cy.js`" pairs first.
- **DSPy** (Python) — programmatic prompt optimization. Endgame play, needs
  20+ labelled examples. Worth investigating once we have a feedback loop.
- **Guidance** (Microsoft) — token-level constrained generation. Heavy to wire
  up, but would kill hallucinated fixture names dead.
- **LangSmith / Helicone** — observability. Nice-to-have once prompts stabilise.

**Effort.** Spike on Instructor — 2 hours. Promptfoo — half a day to set up
a basic suite.

---

## 8. Reflexion / self-critique pass

**Why.** Has notable quality boost on edge cases — model rereads its own output
as an adversary and finds gaps.

**What to add.** Optional second LLM call only for `priority: high` scenarios:
*"You are a hostile QA reviewer. List 5 cases the test above misses."* → feed
back into a third generation pass.

**Effort.** Low (2 hours) but **expensive at runtime** — ~3× token cost.
Reserve for critical flows.

---

## 9. Stable component IDs across sessions

**Why.** Component id changes when testid is discovered (`v1-login__sign-in`
→ `v1-login__login-submit-btn`). Old fixtures become orphans.

**What to add.**
- Pick id from the most stable signal available, but keep a `aliases: string[]`
  array of previous ids.
- Fixtures-generator and test-generator look up by both current id and aliases.

**Effort.** Low — 2 hours.

---

## 10. `generate:support` command

**Why.** `cypress/support/e2e.js` is hand-maintained. When `cy.login()` keys
change in `selectors.js`, it silently breaks.

**What to add.**
- `yarn generate:support` reads `selectors.js`, regenerates `e2e.js` with
  current `SELECTORS.V1_LOGIN.*` keys.
- Optional: template file at `docs/templates/support-e2e.template.js` so
  custom commands live in version control.

**Effort.** Low — 1-2 hours.

---

## 11. App-error allowlist instead of global swallow

**Why.** Currently `Cypress.on('uncaught:exception', () => false)` swallows
EVERY app error. Real regressions hide.

**What to add.**
- Allowlist file `cypress/support/known-errors.txt` (one regex per line).
- Errors matching the allowlist are swallowed; everything else fails the test.
- Auto-populate from observed errors (with manual review).

**Effort.** Low — 2 hours.

---

## 12. Test-level memory: visual baselines

**Why.** Visual regression is half-built (`PostRunCompareAgent`). Snapshot
comparison runs but baselines aren't versioned cleanly.

**What to add.**
- `data/baselines/<page>/<viewport>/screenshot.png` committed to git.
- Per-page tolerance config (some pages have animated content).
- Cypress task `cy.matchScreenshot(name)` that fails the test on diff > threshold.

**Effort.** Medium — 1-2 days.

---

## Prioritised "next 3"

If I were picking what to do next, in this order:

1. **#4 Validator-loop** — cheapest, lifts quality immediately.
2. **#2 lessons-learned.md** — start hand-writing rules as we hit bugs.
   Compounds over time.
3. **#1 Cypress feedback parser** — unlocks #5, #2-auto, real metrics.

Everything else can wait until we see what hurts most after these.
