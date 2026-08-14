# agents/pipeline/

Post-run analysis pipeline. Runs after `main/agent.ts` completes. Processes the collected data and builds the component registry.

## Execution order

```
Steps 2-4 — in parallel:
  aria-analyzer-agent    → analyzed/aria-components.json
  dom-analyzer-agent     → analyzed/dom-components.json
  network-analyzer-agent → analyzed/network-map.json

Step 5 — after steps 2-4:
  identity-resolution-agent → registry/components.json
                               registry/pages.json
```

(Step 1 — data collection in `main/agent.ts` via `SessionCollector`)

## Files

### `pipeline-runner.ts` — class `PipelineRunner`
Pipeline orchestrator. Runs steps 2-4 in parallel, then step 5 sequentially.

---

### `aria-analyzer-agent.ts` — class `AriaAnalyzerAgent` (Step 2)
**Input:** `raw/aria/*-aria.yaml`  
**Output:** `analyzed/aria-components.json`  
Extracts interactive ARIA components: ariaRole, ariaName, state (disabled/checked/expanded), context, pageUrl, stepId.

---

### `dom-analyzer-agent.ts` — class `DomAnalyzerAgent` (Step 3)
**Input:** `raw/dom/*-dom.html`  
**Output:** `analyzed/dom-components.json`  
Extracts DOM element attributes for selector generation: tagName, testid, cssSelector, id, name, type, text, ariaLabel, pageUrl, stepId.

---

### `network-analyzer-agent.ts` — class `NetworkAnalyzerAgent` (Step 4)
**Input:** `raw/network/*-network.json`  
**Output:** `analyzed/network-map.json`  
Maps UI interactions to API calls. Filters out noise (analytics, CDN, fonts). Processes in batches of 10 steps.  
Fields: stepId, method, urlPattern, requestPayloadShape, expectedStatus, responseShape.

---

### `identity-resolution-agent.ts` — class `IdentityResolutionAgent` (Step 5)
**Input:** steps/*.json + the three analyzed/*.json files  
**Output:** `registry/components.json`, `registry/pages.json`  
Key agent: matches "anchors" (interactive elements) against ARIA/DOM/Network data and builds the registry.

**Matching strategy:**
- ARIA: strict (role+name) → medium (name only) → LLM fallback
- DOM: strict (testid) → medium (tagName+text or ariaLabel) → LLM fallback

**Confidence levels:** high, medium, low  
**Component ID format:** `{pageSlug}__{componentSlug}` (max 80 characters)
