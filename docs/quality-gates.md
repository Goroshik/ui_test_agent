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

Current state: **all five green in ~25s**, 638 tests across 28 files, CRAP
`0 above threshold (30), worst 30.0`, mutation score 68.33.

The runner is [scripts/gate.cjs](../scripts/gate.cjs) rather than a shell `&&`
chain: it `chdir`s to the project root (hooks can fire from a parent directory),
invokes each binary directly through `node`, names the step that failed, and
exits **2** so a failure also blocks the Claude Code `Stop` hook. The scripts are
`.cjs` because this package is `"type": "module"`.

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

## Two ways CRAP silently reports 0% — both fixed

The CRAP gate originally reported *57 functions over threshold, worst 72.0* while
measuring nothing at all. Two independent causes, worth knowing because both fail
**silently**: a well-tested function simply reads 0%.

### 1. Windows path mismatch (fixed by a preprocessor)

crap4ts 1.0.1's Istanbul adapter does:

```js
if (prefix && absolutePath.startsWith(prefix))   // absolutePath: "D:\work\..."
                                                 // prefix:       "D:/work/..."
```

The v8 reporter writes backslash paths on Windows while `prefix` is normalized to
forward slashes, so the prefix is never stripped. Coverage keys stay absolute
(`D:/work/.../visual-bot/utils.ts`) while the complexity side keys by
`visual-bot/utils.ts` — nothing joins, and **every** function reads 0%. No
configuration avoids it: with `cwd: undefined` the fallback looks for
`lastIndexOf("/")` in a backslash path and yields an empty prefix.

Fixed by [scripts/normalize-coverage-paths.cjs](../scripts/normalize-coverage-paths.cjs),
which rewrites the coverage file to POSIX separators before crap4ts reads it.
It is a no-op on POSIX. The `crap` script runs it first.

### 2. Span-overlap cutoff (fixed in the source)

crap4ts matches coverage to a function only at **≥ 0.8 span overlap**, comparing
the complexity span (which starts at the *declaration*) against the coverage span
(which starts at the *body*). A signature long relative to its body sinks the
ratio below the cutoff and the function is dropped:

| Function | hits | ratio | credited |
|---|---|---|---|
| `_findStableSelector` | 30 | 0.71 | no |
| `_determineSelector` | 15 | 0.69 | no |
| `Screenshotter.capture` | 4 | 0.72 | no |
| `_classify` | 8 | 1.00 | yes |

This is cross-platform, not a Windows quirk. The fix is to fit the signature on
one line — sometimes by naming an inline parameter/return object type
(`SelectorDecision`, `MatchCandidates`, `PreferredSelectorParts`). Five functions
needed it; each carries a comment saying why, so nobody "tidies" the signature
back into a multi-line form and silently loses the coverage credit.

### A related config inconsistency

`vitest.config.ts` excludes `visual-bot/index.ts` from coverage, but
`crap4ts.config.ts` (`src: ["visual-bot"]`) still scores it — so anything in
`index.ts` has no coverage entry and can never clear the threshold. Rather than
touch either write-protected config, `runAnalysisPipeline` moved to
[visual-bot/run-analysis-pipeline.ts](../visual-bot/run-analysis-pipeline.ts).
Keep entry points to thin wiring; put logic worth testing in a module.

## How the offenders were cleared

57 reported → 0, by writing tests rather than moving thresholds. The working loop:

1. Write tests for the function.
2. Re-measure.
3. If it still reads 0% despite obvious hits, it is the span-overlap cutoff —
   collapse the signature.

Nothing was suppressed, no threshold moved, no file excluded. Along the way the
gate caught real mistakes in the new tests themselves: unused destructured
bindings, a dozen unnecessary type assertions, five `ValidationConstraints`
literals missing required fields, and an `exactOptionalPropertyTypes` violation
in a mock recorder.

Two tests deliberately pin **current** behaviour rather than desirable behaviour,
each labelled as such in a comment:

- the greedy `\s*` in the `### Result` regex lets a blank line swallow the result
  block, so the next header becomes the parsed value;
- an empty quoted accessible name (`- button "" [ref=e1]`) matches neither ARIA
  pattern, so the role is lost entirely.

## Known soft spots

These are the honest weak points of a green gate, in rough order of how much they
would matter if something broke.

- **Mutation covers one file.** `edge-case-deriver.ts` is gated at 65; the other
  50 source files are not mutation-tested at all. So for everything else the gate
  proves the code *runs* under test (CRAP) but not that the assertions would
  *catch* a behaviour change. This is the largest remaining gap.
- **76 surviving mutants** remain in the one gated file, mostly string-literal and
  logical-operator mutations in cache/dedupe keys, where the tests assert on
  *count* rather than on the resulting key.
- **Line coverage, not branch.** `coverageMetric: "line"` means a CC-8 function
  clears the threshold at 30% of its lines; several offenders were cleared at
  76–100% but the metric does not require every branch.
- **Coverage has no minimum threshold**, by design — CRAP is the coverage gate,
  since a flat global percentage says nothing about *where* the risk is. For
  reference it currently sits at 36.5% lines / 37.6% statements.
- **Two entry points are excluded from coverage** (`run-pipeline.ts`,
  `run-adversarial.ts`) as top-level wiring; they are still linted and
  typechecked. `index.ts` is excluded from coverage but still scored by CRAP —
  keep it to wiring only (see the config inconsistency above).
- **Some suites lean on stubbed private methods** (`_generatePageTest`,
  `_fetchAndSaveScreenshot`, `_executeMcpTool`). That isolates the unit under
  test, but it also means renaming a private method can leave a test passing
  against a method nobody calls any more.
