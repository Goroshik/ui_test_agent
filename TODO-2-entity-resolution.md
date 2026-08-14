# TODO: Entity Resolution — how to determine that this is the same component

## Problem
Three sources (ARIA, DOM, Network) describe the same elements in different languages.
We need to reliably merge them into a single ComponentRecord entry.

Example: one element is described like this across three sources:
- ARIA:    `button[name="Checkout"]`
- DOM:     `<button data-testid="checkout-btn" class="btn-primary">`
- Network: `step-007 → POST /api/checkout`

---

## Identity Resolution Algorithm

### Stage 1: Anchor Matching (deterministic, no LLM)

The core idea: `step-NNN.json` records `action.element` — a fingerprint of the element
at the moment of interaction. This is the only record where we know exactly WHICH element
triggered the network events.

#### 1.1 Build the anchor index
For each step, collect the anchor:
```javascript
const anchor = {
  stepId: step.stepId,
  testid: step.action.element.testid,       // "checkout-btn"
  ariaRole: step.action.element.ariaRole,   // "button"
  ariaName: step.action.element.ariaName,   // "Checkout"
  tagName: step.action.element.tagName,     // "button"
  text: step.action.element.text,           // "Checkout"
  bbox: step.action.element.bbox            // {x, y, w, h}
};
```

#### 1.2 Match against the ARIA snapshot
Search `aria-components.json` for a record where `stepId == anchor.stepId` AND one of:
- `ariaRole == anchor.ariaRole` + `ariaName == anchor.ariaName` → STRONG MATCH
- only `ariaName == anchor.ariaName` → WEAK MATCH

#### 1.3 Match against the DOM snapshot
Search `dom-components.json` for a record where `stepId == anchor.stepId` AND one of:
- `testid == anchor.testid` (if testid is not null) → STRONG MATCH
- `tagName == anchor.tagName` + `text == anchor.text` → MEDIUM MATCH
- `ariaLabel == anchor.ariaName` → MEDIUM MATCH

#### 1.4 Match against Network
Search `network-map.json` for a record where `stepId == anchor.stepId` → direct match.
(Network events are already tied to stepId during collection.)

---

### Stage 2: Canonical ID Generation

After matching, we need to generate a stable component ID for the registry.

#### Canonical ID generation rule
Format: `<page-slug>__<component-slug>`

```javascript
function generateCanonicalId(anchor, url) {
  // page slug: /cart → "cart", /products/123 → "products-detail"
  const pageSlug = urlToSlug(url);

  // component slug: priority is testid > ariaName > text
  const componentSlug = anchor.testid
    ? kebabCase(anchor.testid)
    : anchor.ariaName
      ? kebabCase(anchor.ariaName)
      : `${anchor.tagName}-${hashShort(anchor.bbox)}`;

  return `${pageSlug}__${componentSlug}`;
}
```

Examples:
- `/cart` + testid `checkout-btn` → `cart__checkout-btn`
- `/` + ariaName `Open menu` → `home__open-menu`
- `/products` + button without id → `products__button-a3f2`

---

### Stage 3: LLM Merge Agent (for ambiguous cases)

Only invoke the LLM when the deterministic algorithm did not produce a STRONG MATCH.

#### 3.1 Prompt for LLM disambiguation

```
You are a UI component matching agent.

Given an anchor (the element from the interaction step):
<anchor_json>

Given a list of candidates from the ARIA snapshot of this step:
<aria_candidates_json>

Given a list of candidates from the DOM snapshot of this step:
<dom_candidates_json>

Your task: determine which candidate from ARIA and which from DOM describe the same
element as the anchor.

Rules:
1. If unsure — set confidence: "low" and explain why.
2. If there are no candidates — return null.
3. Do not guess. Null is better than an incorrect match.

Return JSON:
{
  "ariaMatch": { "index": 0, "confidence": "high|medium|low" },
  "domMatch": { "index": 2, "confidence": "high|medium|low" },
  "reasoning": "brief reason"
}
```

#### 3.2 When NOT to invoke the LLM
- If there is only 1 candidate on the page with the required role → take it automatically
- If the testid matches → take it automatically
- If overall confidence is already "high" → don't spend tokens

---

### Stage 4: Building the ComponentRecord

After a successful match, assemble the final record.

#### 4.1 ComponentRecord structure

```typescript
interface ComponentRecord {
  // IDENTITY
  id: string;                    // "cart__checkout-btn"
  label: string;                 // "Checkout button" (human readable)
  componentType: string;         // "button" | "input" | "link" | "form" | "modal" | etc

  // WHERE
  pages: string[];               // ["/cart", "/checkout/step1"] — pages where it appeared
  lastSeen: string;              // ISO timestamp

  // HOW TO SELECT (in order of reliability)
  selectors: {
    preferred: string;           // best selector for Cypress
    aria: string;                // "button[name='Checkout']"
    testid: string | null;       // "[data-testid='checkout-btn']"
    css: string | null;          // ".btn-primary.checkout-button"
    xpath: string | null;        // only as a last-resort fallback
  };

  // WHAT IT DOES
  actions: ComponentAction[];

  // STATES
  states: {
    disabled_when?: string;      // "cart is empty"
    hidden_when?: string;        // "user not logged in"
    loading_after?: string;      // "after click, ~500ms"
    variants?: string[];         // ["default", "loading", "disabled"]
  };

  // ASSERTIONS (what to check after interaction)
  assertions: {
    pre_interaction: string[];   // ["be.visible", "be.enabled"]
    post_interaction: string[];  // ["url include /confirmation", "network 200"]
  };

  // META
  confidence: "high" | "medium" | "low";
  seenCount: number;             // how many times it was seen
  manualOverride: boolean;       // true = don't touch automatically
  notes: string;                 // place for manual notes
}

interface ComponentAction {
  type: "click" | "fill" | "select" | "hover" | "focus";
  value?: string;                // for fill/select

  // Network side effects
  network?: {
    method: string;              // "POST"
    urlPattern: string;          // "/api/checkout" or a regex
    requestShape?: object;       // approximate payload shape
    expectedStatus: number;      // 200
    responseShape?: object;      // approximate response shape
  };

  // Storage side effects
  storageDiff?: {
    localStorage?: { added?: object; changed?: object; removed?: string[] };
    cookies?: { added?: object; removed?: string[] };
  };

  // Navigation side effects
  navigation?: {
    to: string;                  // "/confirmation" or "same page"
    condition?: string;          // "on success"
  };
}
```

---

### Stage 5: Merge Strategy (updating an existing record)

When a component already exists in the registry and we found it again:

#### 5.1 Merge rules

```javascript
function mergeComponentRecord(existing, newData) {
  // NEVER touch it if manualOverride is set
  if (existing.manualOverride) return existing;

  return {
    ...existing,

    // pages: union
    pages: [...new Set([...existing.pages, ...newData.pages])],

    // selectors: add new ones, don't remove old ones
    selectors: {
      preferred: existing.selectors.preferred, // don't change preferred automatically
      aria: newData.selectors.aria || existing.selectors.aria,
      testid: existing.selectors.testid || newData.selectors.testid,
      css: existing.selectors.css || newData.selectors.css,
      xpath: existing.selectors.xpath || newData.selectors.xpath,
    },

    // actions: add new patterns, don't duplicate
    actions: mergeActions(existing.actions, newData.actions),

    // states: merge the objects
    states: { ...existing.states, ...newData.states },

    // assertions: union
    assertions: {
      pre_interaction: [...new Set([
        ...existing.assertions.pre_interaction,
        ...newData.assertions.pre_interaction
      ])],
      post_interaction: [...new Set([
        ...existing.assertions.post_interaction,
        ...newData.assertions.post_interaction
      ])],
    },

    // meta: update
    confidence: upgradeConfidence(existing.confidence, newData.confidence),
    seenCount: existing.seenCount + 1,
    lastSeen: new Date().toISOString(),
  };
}
```

#### 5.2 How mergeActions works
Two actions are considered duplicates if their `type` + `network.urlPattern` match.
If it's a duplicate — take the one with higher confidence, merge the remaining fields.

---

### Stage 6: Preferred Selector Logic

Determine `selectors.preferred` for Cypress — the most reliable one.

#### Priority:
1. `[data-testid="..."]` — if present, always preferred
2. `[aria-label="..."]` — if unique on the page
3. `role + name` via `cy.findByRole` (testing-library) — semantically stable
4. `#id` — only if the id is not dynamic (not `input-1234-abc`)
5. `.class` — only if the class is clearly semantic, not utilitarian
6. `xpath` — only as a last resort

#### Uniqueness check (via DOM snapshot)
```javascript
// Count how many elements the selector matches on the page
// If > 1 — don't use it as preferred, look for a more specific one
```

---

### Summary: what the Identity Resolution Agent does step by step

```
1. Read all step-NNN.json files → build the anchor index
2. Read aria-components.json, dom-components.json, network-map.json
3. For each anchor:
   a. Deterministic matching by stepId + strong signals
   b. If ambiguous → LLM resolution
   c. Generate the canonical ID
   d. Assemble the ComponentRecord from all sources
   e. Determine the preferred selector
4. Read registry/components.json
5. For each new ComponentRecord:
   a. If the ID already exists → merge per the rules above
   b. If new → add it
6. Write the updated registry/components.json
7. Update registry/pages.json
8. Print a report: N added, M updated, K conflicts
```
