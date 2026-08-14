# TODO 4 — Open problems and edge cases

This file describes known problems that need to be solved.
Each section is a separate task with context and a proposed direction for the solution.

---

## Problem 1: the 100KB DOM snapshot limit may not be enough

### Context
TODO-1 specifies: if the DOM snapshot exceeds 100KB — truncate to the first 200 interactive elements and write `truncated: true`. But "first 200" means elements in DOM order, not in order of importance. On a page like `/admin/reports`, or in an SPA with a large table, there can be 500+ interactive elements, and the ones actually needed may end up at the tail.

### What needs to be solved
- Define a truncation strategy that preserves the elements that matter
- Never lose the element the agent is about to interact with (it is known via its fingerprint)
- Determine whether the full DOM even needs to be stored, or whether the "neighborhood" of the current action is enough

### Proposed direction
Instead of "first 200" — priority-based sampling:
1. The element from the fingerprint of the current step — always included
2. Elements within a ~500px radius of the current element's bbox
3. Elements with a `data-testid` or `aria-label` (semantically marked up)
4. Everything else, up to the limit

It may be worth storing not a single DOM snapshot per step, but only the "focus zone" — the DOM subtree around the interaction. This is both more compact and more accurate for identity resolution.

Another option — store only the ARIA snapshot as the primary source (it's more compact than the DOM), and produce a DOM snapshot only for selectors, not for structural analysis.

---

## Problem 2: an element was removed or moved

### Context
The registry accumulates data across runs. The component `cart-page__checkout-btn` used to be on `/cart`, but after a redesign it was removed or moved into the header. In the next run, the Identity Agent will either fail to find it (creating a duplicate) or find the wrong element via the old selector.

### What needs to be solved
- Detect that a component has disappeared
- Detect that a component has moved (same meaning, different location)
- Avoid cluttering the registry with dead entries
- Avoid breaking tests that reference it

### Proposed direction

**Detecting disappearance:**
After each run, for each page in `meta.json` we store the list of components that were found. If a component is listed against that page in the registry but did not appear in the run — we set `lastSeen: <date>` and `missingInRuns: [runId]`. After N consecutive misses — we set `status: "possibly_removed"` and `needsReview: true`.

**Detecting a move:**
If a new run produces a component with the same ariaRole + ariaName but on a different page or in a different location — this is a merge candidate. The LLM decides: is this a moved component or a new, similar one? If confidence > 0.85 — merge, updating `pages` and `selectors`. Otherwise — two separate components, with a `needsReview: true` flag and `possibleDuplicateOf: "other-component-id"`.

**What to do with tests:**
Test files that use a component with `status: "possibly_removed"` — on the next generation, emit a warning instead of failing. Add to the top of the test:
```javascript
// WARNING: component "cart-page__checkout-btn" not found in the last 3 runs
// Check registry/components.json → status: "possibly_removed"
```

---

## Problem 3: very many selectors — is a vector database needed

### Context
After dozens of runs, the registry can grow to thousands of components. During identity resolution we need to quickly check "does such a component already exist in the registry". A linear scan over JSON is slow. In addition, fuzzy search ("find a component similar to this one") is impossible over JSON without an LLM call for every element.

### What needs to be solved
- Fast lookup during identity resolution
- Fuzzy search for detecting duplicates and moved components
- Not overcomplicating the stack without a real need

### Proposed direction

**First, try without vectors:**
For deterministic matching by testid and ariaName, an in-memory inverted index is enough:
```json
// registry/index.json — built automatically from components.json
{
  "byTestid": { "checkout-btn": "cart-page__checkout-btn" },
  "byAriaName": { "checkout": ["cart-page__checkout-btn"] },
  "byUrlAndRole": { "/cart__button": ["cart-page__checkout-btn"] }
}
```
This index is rebuilt on every registry update. Lookup is O(1). For a registry of up to ~5000 components this is sufficient.

**When to add a vector database:**
Only if deterministic matching cannot handle fuzzy cases — for example, a button renamed from "Checkout" to "Place order" with no testid. In that case, embedding ariaName + context would give semantic similarity.

A candidate stack, if it comes to that: `sqlite-vss` (SQLite with a vector extension) — minimal overhead, file-based database, no separate service needed. Embeddings via the same local LLM already in use.

**Important:** vector search does not replace deterministic matching — it complements it for fuzzy, low-confidence cases. Architecture: deterministic lookup first, and only at `confidence < 0.7` do an additional vector search.

---

## Problem 4: test reuse — write once, use everywhere

### Context
Currently the Test Gen Agent generates each flow as a separate file with duplicated code. Login is needed in 15 different flows — and each one has the same 10 lines. When the login API changes, all 15 files need to be updated.

### What needs to be solved
- Extract reusable flows into separate modules
- Let the Test Gen Agent know that login is already written — don't regenerate it
- Ensure reusable modules are also updated when the registry changes

### Proposed direction

**Split tests into three layers:**

```
tests/
  shared/                          # reusable blocks (generated once)
    flows/
      login-flow.js                # cy.loginViaUI(), cy.loginViaAPI()
      cart-add-item.js             # cy.addItemToCart(productId)
      checkout-flow.js             # cy.completeCheckout(address)
    fixtures/
      user-default.json
      cart-with-items.json
  
  generated/                       # final tests (generated from shared + scenarios)
    e2e/
      cart-checkout.cy.js
      product-search.cy.js
```

**How the Test Gen Agent learns about shared blocks:**

Add a section to `registry/test-gen-config.json`:
```json
{
  "sharedFlows": [
    {
      "id": "login",
      "description": "User authentication",
      "triggerComponents": ["login-page__email-input", "login-page__submit-btn"],
      "cypressCommand": "cy.loginViaUI(email, password)",
      "file": "tests/shared/flows/login-flow.js"
    }
  ]
}
```

When the agent sees steps in a scenario that match `triggerComponents` from a sharedFlow, it does not regenerate the code — instead it inserts a call to the `cy.loginViaUI()` command.

**The shared flow file is generated once** and afterward is only updated if the components it references have changed (via the `registry-hash` mechanism from TODO-3).

---

## Problem 5: clean tests, environment bring-up, DB reset

### Context
Currently generated tests mock the network via `cy.intercept`. But sometimes real integration tests are needed — against a real backend with a real database. That requires: bringing up a DB with a set of test data, running the test, resetting the DB afterward. In addition, tests must not depend on state left behind by a previous test.

### What needs to be solved
- Automatic environment bring-up before a run (seeding the DB with test data)
- Isolation between tests (each test works with a clean state)
- Resetting and restoring the DB after tests that write data
- This must not require manual steps at run time

### Proposed direction

**Two testing modes — different strategies:**

*"mocked" mode (default):*
Everything is mocked via `cy.intercept`. No DB needed. Fast, isolated, works without an environment. This is what is generated today.

*"integrated" mode:*
Real backend, real DB. Suitable for smoke tests and verifying critical flows.

**For integrated mode we need:**

`tests/support/db-setup.js` — a module for managing state:
```javascript
// Invoked via cy.task() — Cypress can execute Node.js code through tasks
// cypress/plugins/index.js registers the tasks

// Examples of commands that need to be implemented:
cy.task("db:seed", "checkout-scenario")   // load test data
cy.task("db:reset")                        // roll back to a clean state
cy.task("db:snapshot", "before-checkout") // save a state snapshot
cy.task("db:restore", "before-checkout")  // restore a snapshot
```

**Isolation strategy:**

Don't reset the DB after every test — that's slow. Instead:
- Each test creates data with a unique prefix (`test_<uuid>_user@example.com`)
- After the run, a single job cleans up all records with the `test_` prefix
- For tests that change global state (settings, flags) — `db:snapshot` + `db:restore` in `beforeEach`/`afterEach`

**Environment bring-up:**

Add scripts to `package.json`:
```json
{
  "scripts": {
    "test:e2e": "npm run env:up && cypress run && npm run env:down",
    "env:up": "docker compose -f docker-compose.test.yml up -d && npm run db:wait && npm run db:seed:base",
    "env:down": "docker compose -f docker-compose.test.yml down",
    "db:wait": "wait-on tcp:5432 -t 30000",
    "db:seed:base": "node scripts/seed-base.js"
  }
}
```

**What the Test Gen Agent generates for integrated mode:**

When `test-gen-config.json` contains `"mode": "integrated"` — the agent adds to each test file:
```javascript
before(() => { cy.task("db:seed", "scenario-name"); });
after(() => { cy.task("db:reset"); });
```

And it creates `tests/fixtures/db-seeds/scenario-name.js` with the dataset for that scenario — based on the storage snapshot from the run (which held the real values used by the agent).
