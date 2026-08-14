# TODO: Agents Pipeline — data collection, persistence, updates

## Context
Visual regression testing system. The main agent walks through pages,
collects artifacts, which specialized agents then use for analysis.

---

## Data file architecture

### Directories
```
./data/
  sessions/
    <sessionId>/          # one session = one pass
      session-meta.json   # session metadata
      steps/
        step-001.json     # data for one step
        step-002.json
        ...
      raw/
        aria/
          step-001-aria.yaml
        dom/
          step-001-dom.html
        network/
          step-001-network.json
        storage/
          step-001-storage.json
        screenshots/
          step-001.webp

./registry/
  components.json         # component registry (built by the Identity Agent)
  pages.json              # known pages and their components
  selectors.json          # all known selectors (for fast lookup)
```

---

## Step 1: Main Navigator Agent

### Task
Walks through pages according to the task, performs actions, on EACH step collects
and persists artifacts BEFORE and AFTER the action.

### What to do

#### 1.1 Session initialization
On start, create `session-meta.json`:
```json
{
  "sessionId": "<uuid>",
  "startedAt": "<ISO timestamp>",
  "task": "<task string>",
  "baseUrl": "<url>",
  "status": "running",
  "steps": []
}
```

#### 1.2 On each step — BEFORE the action
Collect and write to `step-NNN.json`:
```json
{
  "stepId": "step-001",
  "stepIndex": 1,
  "timestamp": "<ISO>",
  "url": "<current url>",
  "action": {
    "type": "click | fill | navigate | select | hover",
    "description": "<what we're doing and why>",
    "element": {
      "testid": "<data-testid if present>",
      "ariaRole": "<role>",
      "ariaName": "<accessible name>",
      "tagName": "<tag>",
      "text": "<innerText if button/link>",
      "bbox": { "x": 0, "y": 0, "width": 0, "height": 0 },
      "xpath": "<xpath to the element>",
      "cssPath": "<short css path>"
    },
    "value": "<value for fill/select>"
  },
  "before": {
    "ariaSnapshotFile": "raw/aria/step-001-aria.yaml",
    "domFile": "raw/dom/step-001-dom.html",
    "storageFile": "raw/storage/step-001-storage.json",
    "screenshotFile": "raw/screenshots/step-001-before.webp"
  },
  "after": null
}
```

#### 1.3 Collecting the ARIA snapshot (before the action)
Use Playwright:
```javascript
// Get the aria snapshot of the whole page
const ariaSnapshot = await page.locator('body').ariaSnapshot();
// Write to raw/aria/step-NNN-aria.yaml
```
IMPORTANT: ariaSnapshot() returns a YAML string with a tree of roles, names, and states.
This is the most valuable source for entity resolution.

#### 1.4 Collecting the DOM snapshot (before the action)
```javascript
// Serialize a simplified DOM — interactive elements only
const dom = await page.evaluate(() => {
  const selectors = [
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[data-testid]', '[aria-label]'
  ];
  return document.querySelectorAll(selectors.join(',')).map... // collect attributes
});
```
Write ONLY the interactive elements, not the whole HTML. Full HTML is too large.
Format: minimal HTML or a JSON array of elements with attributes.

Attributes for each element:
- tagName, id, className, data-testid, aria-label, aria-role, name, type, value,
  placeholder, href, disabled, checked, textContent (first 100 characters)

#### 1.5 Collecting the Storage snapshot (before the action)
Via a CDP session:
```javascript
const client = await page.context().newCDPSession(page);

// localStorage
const storageData = await page.evaluate(() => ({
  localStorage: Object.fromEntries(
    Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])
  ),
  sessionStorage: Object.fromEntries(
    Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])
  )
}));

// cookies
const cookies = await page.context().cookies();
```
Write to `step-NNN-storage.json`.

#### 1.6 Network listener — enable BEFORE the step starts
```javascript
const networkEvents = [];
const requestHandler = (request) => {
  if (['xhr', 'fetch'].includes(request.resourceType())) {
    networkEvents.push({
      type: 'request',
      stepId: currentStepId,
      timestamp: Date.now(),
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postData: request.postData()
    });
  }
};
const responseHandler = (response) => {
  if (['xhr', 'fetch'].includes(response.request().resourceType())) {
    networkEvents.push({
      type: 'response',
      stepId: currentStepId,
      timestamp: Date.now(),
      url: response.url(),
      status: response.status(),
      // read the body only if content-type is json and size < 50kb
    });
  }
};
page.on('request', requestHandler);
page.on('response', responseHandler);
```

#### 1.7 Screenshot BEFORE the action
```javascript
await page.screenshot({
  path: `raw/screenshots/step-NNN-before.webp`,
  type: 'webp',
  quality: 80
});
```

#### 1.8 PERFORM THE ACTION

#### 1.9 AFTER the action — collect the diff
Wait 500ms for network requests to finish, then:

1. Screenshot after
2. Storage snapshot after
3. Compute the storage diff:
```json
{
  "added": { "orderId": "123" },
  "changed": { "cartCount": { "from": "3", "to": "0" } },
  "removed": { "draftOrder": null }
}
```
4. Stop the network listener, save events to `step-NNN-network.json`
5. Write all collected data into the `after` field in `step-NNN.json`

#### 1.10 Update session-meta.json
Add the step to the `steps` array with a brief description and status.

---

## Step 2: ARIA Analyzer Agent

### Task
Reads all `step-NNN-aria.yaml` files and builds a list of unique interactive
components encountered during the session.

### What to do

#### 2.1 Read all aria files for the session
Walk `sessions/<sessionId>/raw/aria/`.

#### 2.2 LLM prompt
For each aria file:
```
You are analyzing an ARIA snapshot of a web page.
Extract a list of ALL interactive elements.

For each element return JSON:
{
  "ariaRole": "button",
  "ariaName": "Checkout",
  "state": { "disabled": false, "checked": null, "expanded": null },
  "context": "inside form[name=cart]",
  "pageUrl": "<url from meta>",
  "stepId": "<stepId>"
}

Return only a JSON array, with no explanations.
```

#### 2.3 Save the result
Write to `sessions/<sessionId>/analyzed/aria-components.json`.

---

## Step 3: DOM Analyzer Agent

### Task
Reads DOM snapshot files, extracts elements with their attributes.

#### 3.1 LLM prompt
```
You are analyzing a DOM snapshot of a web page. You are given a list of interactive elements.
For each element extract:
{
  "tagName": "button",
  "testid": "checkout-btn",
  "cssSelector": ".btn-primary",
  "id": null,
  "name": null,
  "type": "submit",
  "text": "Checkout",
  "ariaLabel": "Proceed to checkout",
  "pageUrl": "<url>",
  "stepId": "<stepId>"
}
Return only a JSON array.
```

#### 3.2 Save
Write to `sessions/<sessionId>/analyzed/dom-components.json`.

---

## Step 4: Network Analyzer Agent

### Task
Reads network logs and builds a map: which UI element → which API call.

#### 4.1 LLM prompt
```
You are given a session's network request log. Each request has a stepId.
For each step, determine:
{
  "stepId": "step-007",
  "triggers": [
    {
      "method": "POST",
      "urlPattern": "/api/checkout",
      "requestPayloadShape": { "cartId": "string", "items": "array" },
      "expectedStatus": 200,
      "responseShape": { "orderId": "string", "total": "number" }
    }
  ]
}
Return only a JSON array.
```

#### 4.2 Save
Write to `sessions/<sessionId>/analyzed/network-map.json`.

---

## Step 5: Identity Resolution Agent

### Task
Merge records from the three sources into unified ComponentRecords.
Detailed description in the file TODO-2-entity-resolution.md.

#### 5.1 Input files
- `analyzed/aria-components.json`
- `analyzed/dom-components.json`
- `analyzed/network-map.json`
- `steps/step-NNN.json` (for the element fingerprint from `action.element`)

#### 5.2 Output
Update `registry/components.json` — add new components, update existing ones.

### Registry update logic (IMPORTANT)
- If a component already exists in the registry (match by stable ID) — MERGE, don't overwrite
- On merge: add new selectors, don't remove existing ones
- Increase the `confidence` field on every confirmation
- Always update the `lastSeen` field
- The `manualOverride: true` field — NEVER touch automatically

---

## Registry file formats

### registry/components.json
```json
{
  "version": "1.0",
  "lastUpdated": "<ISO>",
  "components": {
    "cart-page__checkout-btn": { /* ComponentRecord */ },
    "global__header-logo": { /* ComponentRecord */ }
  }
}
```

### registry/pages.json
```json
{
  "/cart": {
    "title": "Shopping Cart",
    "components": ["cart-page__checkout-btn", "cart-page__quantity-input"],
    "lastSeen": "<ISO>"
  }
}
```

---

## Key principles

1. **Step atomicity**: all files for one step are written together. If the agent crashes
   partway through — the step is marked `status: incomplete` and is not used for analysis.

2. **Idempotency**: re-running the agents on the same files must not duplicate
   records in the registry.

3. **Don't delete old data**: sessions accumulate. Deletion is manual only.

4. **File size**: a DOM snapshot must not exceed 100KB. If it does — truncate to
   the first 200 interactive elements and write `truncated: true`.

5. **Timeouts**: after each action, wait MIN(networkIdle, 2000ms) before collecting after-data.
