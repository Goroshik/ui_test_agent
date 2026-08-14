# agents/snapshot-text-compare/

Text comparison agent for ARIA snapshots (accessibility tree).

## Files

### `snapshot-text-compare-agent.ts` — class `SnapshotTextCompareAgent`
Extends `BaseCompareAgent`. Compares incoming text snapshots against the baseline via `VisualTextDiff` (LLM-based text comparison).

**Directories:**
- Incoming: `./screenshots/snapshots-incoming/`
- Baseline: `./screenshots/snapshots-baseline/`
- Changes: `./screenshots/snapshots-changes/`

**File formats:** `.txt`

**Inherited logic (from BaseCompareAgent):**
- Rotation of baseline and changes files
- `BASELINE_KEEP_COUNT` (default: 1)
- `CHANGES_KEEP_COUNT` (default: 5)
- `CLEANUP_CHANGES_AFTER_PROCESS` (default: true)

**Difference from snapshot-compare/:** works with text (ARIA tree) rather than images. Uses `VisualTextDiff` instead of `VisualDiff`.

**Used from:** `post-run/post-run-snapshot-compare-agent.ts`
