# TODO — visual-bot Refactoring

Proposals after analyzing the codebase. Priority: high → low.

---

## High priority

### 1. Check deleted files — make sure nothing is broken
Per `git status`, the following were deleted:
- `visual-bot/agents/post-run/dom-memory-agent.ts`
- `visual-bot/agents/post-run/page-memory-agent.ts`
- `visual-bot/analyze-dom-memory.ts`
- `visual-bot/analyze-memory.ts`
- `visual-bot/dom-memory.ts`

Need to make sure none of the active code imports them. Otherwise — runtime errors.

### 2. Figure out the new files at the root of visual-bot
New files with no obvious place in the architecture appeared per `git status`:
- `visual-bot/lm-model-manager.ts` — what is this? Is it used?
- `visual-bot/registry-context.ts` — already used in `main/agent.ts` and `planner/`, but there's no README
- `visual-bot/run-pipeline.ts` — entry point for the pipeline? Does it duplicate `pipeline-runner.ts`?

---

## Medium priority

### 3. Concurrent writes to JSON files
`dom-component-store.ts` and `content-summary-store.ts` — no locking.  
If several sessions run in parallel → race condition → data loss.  
**Solution:** add a simple write queue or use an append-only approach.

### 4. Hardcoded paths in the stores
`data/content-summaries.json` and `data/dom-components.json` — the paths are hardwired directly into the files.  
If `data/` needs to be moved, the code will have to be changed in several places.  
**Solution:** move it out into config/env as a `DATA_DIR` variable.

### 5. `post-run/post-run-visual-agent.ts` — redundant file
This is just a re-export from `post-run-snapshot-compare-agent.ts`. There's no logic in it.  
**Solution:** remove the file, move the exports directly into `post-run-snapshot-compare-agent.ts`.

### 6. Duplicated directory paths
`snapshot-compare` and `snapshot-text-compare` both hardcode paths to `./screenshots/...`.  
These paths are repeated in `BaseCompareAgent` and its subclasses.  
**Solution:** pass the directories through the constructor.

---

## Low priority

### 7. `SessionCollector` — the step counter isn't persistent
The `nextStepId()` counter lives only in memory. If a new instance is created for the same session, it will start from 1 and overwrite the old steps.  
**Solution:** read the number of existing steps from the file system during `init()`.

### 8. `task-verification-agent.ts` — responses only in Russian
Hardcoded in the system prompt. If the project ends up being used in another language, this will need to change.  
**Solution:** pass the language as a parameter or remove the language restriction.

### 9. Add a README for the root of `visual-bot/`
There are READMEs in the subfolders, but there's no overall overview of the whole `visual-bot/` — what it is, how to run it, what env variables are needed.

---

## Check before deleting

Files from `git status` that were modified but whose role is unclear — worth reading before deciding:
- `visual-bot/attention-memory.ts` (modified)
- `visual-bot/memory.ts` (modified)
- `visual-bot/run-logger.ts` (modified)
- `visual-bot/utils.ts` (modified)
- `visual-bot/visual-diff.ts` (modified)
- `visual-bot/visual-text-diff.ts` (modified)
