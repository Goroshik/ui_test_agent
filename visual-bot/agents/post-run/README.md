# agents/post-run/

Post-run agents: snapshot comparison and task-execution verification.

## Files

### `post-run-snapshot-compare-agent.ts` — classes `PostRunCompareAgent` / `PostRunSnapshotCompareAgent` / `PostRunVisualAgent`
Orchestrator for comparisons. Delegates work to two specialized agents:
- `ScreenshotCompareAgent` (from `snapshot-compare/`) — compares PNG/JPG screenshots
- `SnapshotTextCompareAgent` (from `snapshot-text-compare/`) — compares ARIA snapshots (.txt)

Methods: `process()`, `processScreenshots()`, `processSnapshots()`

---

### `post-run-visual-agent.ts`
Re-exports `PostRunSnapshotCompareAgent` and `PostRunVisualAgent` as the module's public interface. Contains no logic of its own.

---

### `task-verification-agent.ts` — class `TaskVerificationAgent`
Verifies task execution: looks at the page's latest ARIA snapshot and decides whether the task was completed. A text agent — no vision model is needed.

**Input:** task description + ARIA snapshot (text, from `Agent.getLastAriaSnapshot()`)
**Output:** `{ success: boolean, reason: string }` (responses in Russian)
**Fallback:** if no snapshot is passed — the newest `.txt` from `./screenshots/snapshots-incoming/`
**Behavior:** the LLM strictly evaluates whether the task was completed based on the accessibility tree (URL, headings, field values, alerts, open dialogs)
**Limit:** the snapshot is truncated to `VERIFICATION_SNAPSHOT_MAX_CHARS` (default 20000), head + tail

**Used:** as the final step after the agent completes a task
