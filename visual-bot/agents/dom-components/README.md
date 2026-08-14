# agents/dom-components/

Two-stage analysis of UI blocks from ARIA snapshots. Splits a page snapshot into named components and generates descriptions for them.

## Files

### `types.ts`
`ComponentBlock` interface: `{ blockName: string, content: string }`.

---

### `hasher.ts` — `hashContent()`
MD5 hash of a block's content. Used for deduplication — blocks with an unchanged hash are not regenerated.

---

### `splitter.ts` — `ComponentSplitter` class (Stage 1)
The LLM splits the ARIA snapshot into named UI blocks (navbar, sidebar, main-content, footer, etc.).  
Method: `split(snapshot)` → `ComponentBlock[]`

---

### `analyzer.ts` — `ComponentAnalyzer` class (Stage 2)
The LLM generates a human-readable description (3-5 sentences) for each block.  
Method: `describe(block)` → `string`

---

### `orchestrator.ts` — `ComponentOrchestrator` class
Orchestrates the whole split → analyze process with optimizations:
1. Skips blocks whose hash is unchanged
2. Reuses descriptions from other URLs if the content is identical
3. Saves new descriptions to the DB (`dom-component-store`)

**Used from:** `main/agent.ts` — after every page snapshot
