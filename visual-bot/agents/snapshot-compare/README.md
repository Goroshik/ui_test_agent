# agents/snapshot-compare/

Visual comparison agent for screenshots (PNG/JPG).

## Files

### `snapshot-compare-agent.ts` — classes `ScreenshotCompareAgent` / `SnapshotCompareAgent`
Extends `BaseCompareAgent`. Compares incoming screenshots against the baseline via `VisualDiff` (LLM-based comparison).

**Directories:**
- Incoming: `./screenshots/incoming/`
- Baseline: `./screenshots/baseline/`
- Changes: `./screenshots/changes/`

**File formats:** `.png`, `.jpg`

**Inherited logic (from BaseCompareAgent):**
- Rotation of baseline and changes files
- `BASELINE_KEEP_COUNT` (default: 1) — how many baseline files to keep
- `CHANGES_KEEP_COUNT` (default: 5) — how many changes files to keep
- `CLEANUP_CHANGES_AFTER_PROCESS` (default: true) — clean up after processing

**Used from:** `post-run/post-run-snapshot-compare-agent.ts`
