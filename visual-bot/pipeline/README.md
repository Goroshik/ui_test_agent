# pipeline/

File-based persistence layer — replaces MongoDB. Contains types, data stores, and the session collector.

## Files

### `types.ts`
All TypeScript types for the pipeline. No dependencies — interfaces only.

Key types:
| Type | What it describes |
|-----|--------------|
| `SessionMeta` | Session metadata (id, task, baseUrl, status, steps) |
| `StepRecord` | Full record of a step: URL, action, before/after artifacts, status |
| `ActionData` | Action description: type, element, value |
| `ArtifactRefs` | References to artifact files (ARIA, DOM, network, storage, screenshot) |
| `StorageDiff` | Storage changes (added/changed/removed) |
| `AriaComponent` | ARIA component after analysis (role, name, state, context) |
| `DomComponent` | DOM component (tag, testid, css, id, text, ariaLabel) |
| `NetworkTrigger` | Network request pattern (method, urlPattern, shapes) |
| `ComponentRecord` | Entry in the component registry (id, selectors, actions, states, confidence) |
| `ComponentRegistry` | The entire component registry |
| `PageRegistry` | Mapping of URL → page metadata + list of components |

---

### `session-collector.ts` — the `SessionCollector` class
Manages the file structure of a single session: creates directories, saves steps and artifacts.

**Usage in `main/agent.ts`:** created at session start; the `beginStep()`/`completeStep()` method is called on every step.

**Structure created:**
```
sessions/{sessionId}/
├── session-meta.json         ← session status + step summary
├── steps/
│   ├── step-001.json         ← full record of each step
│   └── ...
├── analyzed/                 ← written to by pipeline/ agents
└── raw/
    ├── aria/                 ← step-NNN-aria.yaml
    ├── dom/                  ← step-NNN-dom.html
    ├── network/              ← step-NNN-network.json
    ├── storage/              ← step-NNN-storage.json
    └── screenshots/          ← step-NNN-{before|after}.webp
```

**Key methods:**
- `init(task, baseUrl)` — creates directories, writes session-meta.json
- `nextStepId()` → `"step-001"`, `"step-002"` ...
- `beginStep()` / `completeStep()` — step lifecycle
- `saveAriaSnapshot()`, `saveDomSnapshot()`, `saveNetwork()`, `saveStorage()`, `saveScreenshot()` — artifact writers
- `finishSession(status)` — finalizes the session

---

### `dom-component-store.ts`
File-based store for DOM block descriptions. Replaces the MongoDB `components` collection.

**Data file:** `data/dom-components.json`  
**Structure:** `URL → blockName → { blockName, contentHash, description, analyzedAt }`

**Exports:**
- `upsertComponent(doc)` — create/update a component
- `getComponent(url, blockName)` — fetch by URL + block name
- `findComponentByHash(contentHash)` — find by hash (cross-URL deduplication)
- `getComponentsByUrl(url)` — all components on a page

**Used from:** `agents/dom-components/orchestrator.ts`

---

### `content-summary-store.ts`
File-based cache of AI-generated content descriptions (screenshots, snapshots).

**Data file:** `data/content-summaries.json`  
**Key:** `"{key}__{kind}"` → description text

**Exports:**
- `getContentSummary(key, kind)` → `string | null`
- `upsertContentSummary(key, kind, summary)` → `void`

---

## Data files (created at runtime)

```
data/
├── content-summaries.json
└── dom-components.json

sessions/
└── {sessionId}/
    └── ... (see SessionCollector above)
```
