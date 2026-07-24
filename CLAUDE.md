# CLAUDE.md

## Project

`visual-bot` — terminal AI agent that drives a browser via Playwright MCP and
generates Cypress tests from what it observes. TypeScript, ESM (`"type": "module"`),
run with `tsx`. Package manager: **yarn** (v1). Test runner: **vitest**.

Entry points:

- `yarn start` — interactive agent (`visual-bot/index.ts`)
- `yarn pipeline` — component-analysis pipeline (`visual-bot/run-pipeline.ts`)
- `yarn test` — generator chain (planner → selectors → fixtures → tests → validate)
- `yarn test:unit` — vitest unit + property tests

## Quality gates

Quality is verified by machine, not by reading diffs. The full gate is:

```bash
yarn gate
```

which runs, in order, failing fast on the first non-zero exit:

`typecheck` → `lint` → `coverage` → `crap` → `mutation`

`yarn gate:quick` (`typecheck` + `lint`) is the fast feedback loop and runs
automatically after every `Edit`/`Write` via the `PostToolUse` hook in
`.claude/settings.json`. The full `gate` runs on the `Stop` hook.

Current thresholds are documented, with rationale, in
[docs/quality-gates.md](docs/quality-gates.md).

### Rules — these are not negotiable

1. **Thresholds are never lowered to make a gate pass.** Not the ESLint
   `complexity`/`max-depth`/`max-lines-per-function`/`max-params` limits, not the
   crap4ts `threshold`, not the Stryker `break` score. If a threshold blocks you,
   fix the code or the tests.

2. **Suppressions are forbidden.** No `eslint-disable` (file- or line-level), no
   `@ts-ignore`, no `@ts-expect-error`, no `any` to escape a type error, no
   non-null assertion (`!`) to escape a null check.

3. **Tests are never neutered.** No `.skip`, no `.only`, no deleting or weakening
   an assertion so a test goes green. A test with no meaningful assertion is
   worse than no test — Stryker will surface it as surviving mutants anyway.

4. **Nothing is excluded from checks** — no new entries in the `exclude` lists of
   `vitest.config.ts`, `crap4ts.config.ts`, or `eslint.config.js`, and no
   narrowing of Stryker's `mutate` globs to dodge a failure.

5. **When a gate fails, fix the cause.** If you genuinely believe a threshold is
   unreachable, stop and say so explicitly — *"threshold N is unreachable
   because ..."* — with the numbers behind the claim, and propose options. Do not
   change the threshold and carry on.

6. **Gate configs are write-protected.** `tsconfig.json`, `eslint.config.js`,
   `vitest.config.ts`, `crap4ts.config.ts`, `stryker.conf.json`, `package.json`,
   `.claude/settings.json` and the existing test files are in
   `permissions.deny`. That denial is the mechanism enforcing rules 1–4 — do not
   attempt to route around it (no `sed`/`python`/shell rewrites of those files,
   no asking the user to disable the hook so a broken change can land).

### Writing code that passes the gate

- Keep cyclomatic complexity ≤ 8 per function; extract helpers rather than
  nesting. Note that a function at CC 8 with no tests scores CRAP 72 — complexity
  and coverage are coupled, so complex code *must* come with tests.
- **Keep function signatures on one line.** crap4ts credits coverage to a function
  only at ≥ 0.8 span overlap, measuring from the declaration while coverage starts
  at the body. A signature long relative to its body drops under the cutoff and
  the function reports **0% coverage however well it is tested** — silently. Name
  an inline parameter or return object type instead of inlining it across lines.
  Several functions carry a comment saying exactly this; don't reflow them back.
- If a function you just tested still shows 0% in `yarn crap`, that is the cutoff
  above, not a missing test. See [docs/quality-gates.md](docs/quality-gates.md).
- Entry points (`index.ts`, `run-pipeline.ts`, `run-adversarial.ts`) are excluded
  from coverage, so logic placed there is invisible to the gate. `index.ts` is
  still scored by CRAP, so keep it to wiring and put real logic in a module.
- Max nesting depth 3, max 50 lines per function, max 4 params. Prefer an options
  object over a fifth parameter.
- `strict` TS is on, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`: index access yields `T | undefined`, so narrow it;
  and `{ x?: string }` will not accept `x: undefined` — omit the key instead.
- Promises must be awaited or explicitly handled (`no-floating-promises`).
