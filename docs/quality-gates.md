# Quality gates

Machine-verified quality. The whole gate is one command:

```bash
yarn gate
```

It runs `typecheck` → `lint` → `coverage` → `crap` → `mutation`, failing fast on
the first non-zero exit code. The behavioural rules that go with these gates
(thresholds are never lowered, suppressions are forbidden, …) live in
[../CLAUDE.md](../CLAUDE.md#rules--these-are-not-negotiable).

## What each gate checks

| Gate | Command | Config | Threshold |
|---|---|---|---|
| Types | `yarn typecheck` | `tsconfig.json` | zero errors |
| Lint | `yarn lint` | `eslint.config.js` | zero errors |
| Coverage | `yarn coverage` | `vitest.config.ts` | reporters only, no minimum |
| CRAP | `yarn crap` | `crap4ts.config.ts` | 30 per function |
| Mutation | `yarn mutation` | `stryker.conf.json` | `break: 65` |

### Types

`strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`.

### Lint

Type-aware (`recommendedTypeChecked` + `projectService`), with the complexity
budget: `complexity: 8`, `max-depth: 3`, `max-lines-per-function: 50`,
`max-params: 4`, plus `no-explicit-any`, `no-non-null-assertion`,
`no-floating-promises`.

`max-lines-per-function` is off for `*.test.ts` only: a `describe()` wrapping many
`it()` cases is declarative structure, not an algorithm. `complexity`, `max-depth`
and `max-params` still apply to test files.

### Coverage

v8 provider, reporters `text` + `json` + `lcov`, `all: true` so untested files
still appear. `coverage/coverage-final.json` is the input to the CRAP gate, which
is why `coverage` must run before `crap` in the chain.

### Mutation

Stryker with the vitest runner, `coverageAnalysis: "perTest"`, `incremental: true`.
`mutate` is currently scoped to `visual-bot/generators/edge-case-deriver.ts` — the
most self-contained core module, chosen in Phase 3 so a run takes ~25s instead of
hours. Last run: **68.33%** mutation score, 164 killed / 76 survived, `break: 65`.

## CRAP: why the threshold and the complexity limit are coupled

`CRAP = CC² × (1 − coverage)³ + CC`

With **zero** coverage the score collapses to `CC² + CC`:

| CC | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| CRAP at 0% coverage | 2 | 6 | 12 | 20 | 30 | 42 | 56 | 72 |

Two consequences worth knowing before touching any threshold:

1. **ESLint caps CC at 8, so the maximum achievable CRAP is 72.** Any crap4ts
   threshold ≥ 72 is a no-op that can never fail — it is not a gate.
2. **At 0% coverage, threshold 30 admits CC ≤ 5 and rejects CC ≥ 6.** So the
   band CC 6–8 is legal for the linter but only if it carries tests. Coverage
   needed to bring an untested function under 30:

   | CC | minimum line coverage to score ≤ 30 |
   |---|---|
   | 6 | 12.7% |
   | 7 | 22.3% |
   | 8 | 30.0% |

## Open issue: CRAP does not currently pass

`yarn crap` fails today. This is pre-existing debt, not a regression introduced
by the gate work:

```
Summary: 487 functions | 57 above threshold (30) | worst: 72.0 | FAIL
```

All 57 offenders are the same shape — **complexity 6–8 with 0% coverage**:

| CC | offenders |
|---|---|
| 6 | 31 |
| 7 | 9 |
| 8 | 17 |

Concentrated in the agent/generator layer, which is the code that calls out to an
LLM and therefore needs mocking to test at all:

| File | offenders |
|---|---|
| `visual-bot/agents/main/agent.ts` | 11 |
| `visual-bot/agents/pipeline/identity-resolution-agent.ts` | 10 |
| `visual-bot/generators/test-planner.ts` | 4 |
| `visual-bot/agents/pipeline/needs-testid-report-agent.ts` | 4 |
| `visual-bot/validators/test-validator.ts` | 3 |
| `visual-bot/utils.ts` | 3 |
| `visual-bot/screenshotter.ts` | 3 |
| `visual-bot/mcp-client.ts` | 3 |
| 11 further files | 1–2 each |

`yarn crap:changed` (ratchet against `origin/master`) does not help *on this
branch* — Phase 1 refactored nearly every file, so 43 of 268 changed-file
functions are still over. Once this branch is on `master` the ratchet becomes
meaningful, because only genuinely new work will show up as changed.

**Threshold 30 is unreachable right now** without writing mocked unit tests for
57 functions across 19 files. That decision is the user's, not the agent's — see
rule 5 in CLAUDE.md. Until it is resolved the `Stop` hook will keep failing.

## Known soft spots

- **Mutation covers one file.** `edge-case-deriver.ts` is gated at 65; the other
  49 source files are not mutation-tested at all.
- **76 surviving mutants** remain in the one gated file, mostly string-literal and
  logical-operator mutations in cache/dedupe keys where the tests assert on
  *count* rather than on the resulting key.
- **Coverage has no minimum threshold**, by design — CRAP is the coverage gate,
  since a flat global percentage would say nothing about *where* the risk is.
- **Three entry points are excluded from coverage** (`index.ts`,
  `run-pipeline.ts`, `run-adversarial.ts`) as top-level wiring. They are still
  linted and typechecked, and `index.ts` is still counted by CRAP.
