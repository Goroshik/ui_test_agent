# TODO: Generating Cypress Tests from the Component Registry

## Concept
The test generator reads ComponentRecord entries from the registry and session steps,
and generates full-fledged Cypress tests. The registry is the single source of truth
for selectors and assertions.

---

## Test Generator Agent Architecture

### Input
- `registry/components.json` — the component registry
- `sessions/<id>/steps/step-NNN.json` — session steps (for the scenario)
- `sessions/<id>/analyzed/network-map.json` — network effects

### Output
- `cypress/e2e/<page-name>/<test-name>.cy.js` — generated tests
- `cypress/support/selectors.js` — centralized selectors file
- `cypress/fixtures/<component-id>.json` — fixtures for network mocking

---

## Step 1: Generate cypress/support/selectors.js

This is the most important file. All tests take selectors ONLY from here.
When the registry changes — regenerate this file → all tests update automatically.

### selectors.js file format
```javascript
// AUTO-GENERATED FILE — do not edit manually
// Source: registry/components.json
// Last updated: <timestamp>
//
// For manual edits: edit registry/components.json
// and run npm run generate:selectors

export const SELECTORS = {
  // Page: /cart
  CART: {
    CHECKOUT_BTN: '[data-testid="checkout-btn"]',          // confidence: high
    QUANTITY_INPUT: '[data-testid="quantity-input"]',      // confidence: high
    REMOVE_ITEM_BTN: '[aria-label="Remove item"]',         // confidence: medium
    CART_TOTAL: '[data-testid="cart-total"]',              // confidence: high
    EMPTY_STATE: '[data-testid="empty-cart-message"]',     // confidence: medium
  },

  // Page: /
  HOME: {
    HEADER_LOGO: '[data-testid="header-logo"]',
    NAV_CART_LINK: '[aria-label="Cart (3 items)"]',        // NOTE: dynamic aria-name
    SEARCH_INPUT: '[data-testid="search-input"]',
  },

  // Global (appear on many pages)
  GLOBAL: {
    LOADING_SPINNER: '[data-testid="loading-spinner"]',
    ERROR_TOAST: '[role="alert"]',
    MODAL_OVERLAY: '[role="dialog"]',
    CONFIRM_BTN: '[data-testid="confirm-btn"]',
    CANCEL_BTN: '[data-testid="cancel-btn"]',
  }
};

// Helpers for dynamic components
export const getCartItemSelector = (productId) =>
  `[data-testid="cart-item-${productId}"]`;

export const getTabSelector = (tabName) =>
  `[role="tab"][aria-label="${tabName}"]`;
```

### How to generate selectors.js

Prompt for the LLM:
```
Given the component registry (registry/components.json).
Generate the file cypress/support/selectors.js.

Rules:
1. Use the preferred selector from each ComponentRecord
2. Group by pages (key = page slug in UPPER_SNAKE_CASE)
3. Components with pages.length > 2 → put in GLOBAL
4. Constant name = UPPER_SNAKE_CASE derived from the component label
5. Add a comment with confidence if it is not "high"
6. For components where ariaName contains dynamic data (digits, IDs) →
   generate a helper function instead of a static string
7. Add a JSDoc comment describing the component

Return only the file's code, without markdown.
```

---

## Step 2: Generate Cypress fixtures

For each ComponentAction with a network effect, create a fixture file.

### Fixture format
```json
// cypress/fixtures/cart__checkout-btn--success.json
{
  "orderId": "order-12345",
  "total": 99.99,
  "status": "confirmed",
  "redirectUrl": "/confirmation/order-12345"
}
```

```json
// cypress/fixtures/cart__checkout-btn--error.json
{
  "error": "PAYMENT_FAILED",
  "message": "Payment method declined",
  "code": 402
}
```

### Generating fixtures from responseShape
The LLM takes `action.network.responseShape` from the ComponentRecord and generates
realistic fixtures — one for the success case, one for the error case.

---

## Step 3: Generating the test file

### 3.1 Test structure — one file per scenario

A scenario is a sequence of steps from one session or part of it.

```
cypress/e2e/
  cart/
    checkout-flow.cy.js       # scenario: add item → checkout → confirmation
    empty-cart.cy.js          # scenario: empty cart
    quantity-update.cy.js     # scenario: change quantity
```

### 3.2 Anatomy of a generated test

```javascript
// AUTO-GENERATED FILE
// Session: <sessionId>
// Steps: step-001 → step-007
// Regenerate: npm run generate:tests -- --session <sessionId>

import { SELECTORS } from '../../support/selectors';

describe('Cart: Checkout Flow', () => {

  // ─── Setup ────────────────────────────────────────────────────────────────

  beforeEach(() => {
    // Network interceptors — set BEFORE cy.visit()
    cy.intercept('POST', '/api/checkout', {
      fixture: 'cart__checkout-btn--success.json'
    }).as('checkoutRequest');

    cy.intercept('GET', '/api/cart', {
      fixture: 'cart__get-cart--success.json'
    }).as('getCart');

    // Reset state
    cy.clearLocalStorage();
    cy.clearCookies();
  });

  // ─── Happy Path ───────────────────────────────────────────────────────────

  it('should complete checkout successfully', () => {
    // STEP 1: Open the cart page
    cy.visit('/cart');
    cy.wait('@getCart');

    // STEP 2: Make sure the cart is not empty
    cy.get(SELECTORS.CART.CART_TOTAL).should('be.visible');
    cy.get(SELECTORS.CART.EMPTY_STATE).should('not.exist');

    // STEP 3: Verify the Checkout button is available
    cy.get(SELECTORS.CART.CHECKOUT_BTN)
      .should('be.visible')
      .should('be.enabled')
      .should('contain.text', 'Checkout');

    // STEP 4: Click Checkout
    cy.get(SELECTORS.CART.CHECKOUT_BTN).click();

    // STEP 5: Verify the network request
    cy.wait('@checkoutRequest').then((interception) => {
      expect(interception.response.statusCode).to.eq(200);
      // Verify that orderId was saved in localStorage
      cy.window().its('localStorage').invoke('getItem', 'orderId')
        .should('not.be.null');
    });

    // STEP 6: Verify the redirect
    cy.url().should('include', '/confirmation');
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────────

  it('should disable checkout button when cart is empty', () => {
    cy.intercept('GET', '/api/cart', { body: { items: [] } }).as('emptyCart');
    cy.visit('/cart');
    cy.wait('@emptyCart');

    cy.get(SELECTORS.CART.CHECKOUT_BTN).should('be.disabled');
    cy.get(SELECTORS.CART.EMPTY_STATE).should('be.visible');
  });

  it('should handle checkout API error gracefully', () => {
    cy.intercept('POST', '/api/checkout', {
      statusCode: 402,
      fixture: 'cart__checkout-btn--error.json'
    }).as('checkoutFail');

    cy.visit('/cart');
    cy.get(SELECTORS.CART.CHECKOUT_BTN).click();
    cy.wait('@checkoutFail');

    // Should display an error message
    cy.get(SELECTORS.GLOBAL.ERROR_TOAST)
      .should('be.visible')
      .should('contain.text', 'Payment method declined');

    // Should not redirect
    cy.url().should('include', '/cart');
  });
});
```

---

## Step 4: Prompts for the Test Generator Agent

### 4.1 Prompt: generating the happy path test

```
You are generating a Cypress test based on a recorded session.

COMPONENT REGISTRY (only entries relevant to this page):
<subset_of_registry_json>

SESSION STEPS:
<session_steps_json>

GENERATION RULES:
1. Import SELECTORS from '../../support/selectors' — no hardcoded strings
2. Every cy.intercept() goes IN beforeEach, BEFORE cy.visit()
3. After every click() that triggers network activity — cy.wait('@alias')
4. Check state BEFORE the interaction (pre_interaction assertions from the registry)
5. Check state AFTER the interaction (post_interaction assertions from the registry)
6. Check storage changes (from storageDiff) via cy.window().its('localStorage')
7. Add a "// STEP N:" comment before each logical step
8. describe: "PageName: Scenario Name"
9. it: "should <action> <expected result>"

FORBIDDEN:
- cy.wait(1000) — only cy.wait('@networkAlias') or Cypress retry-ability
- hardcoded selector strings — only SELECTORS.X.Y
- cy.get('body').click() or other unreliable actions
- ignoring network effects from the registry

Return only the file's code, without markdown blocks.
```

### 4.2 Prompt: generating edge cases

```
Based on the ComponentRecord for component <component_id>:
<component_record_json>

Generate edge case tests for the following scenarios:
1. Component in a disabled state (if states.disabled_when is defined)
2. Component hidden (if states.hidden_when is defined)
3. Network error (status 500) for each network action
4. Network timeout for each network action
5. Component in a loading state (if states.loading_after is defined)

Each edge case gets its own it() block.
Use the same rules as for the happy path.
```

---

## Step 5: Centralized updates

### How the update works when the registry changes

```
registry/components.json changed
       ↓
npm run generate:selectors
       → regenerate cypress/support/selectors.js
       ↓
npm run generate:fixtures
       → regenerate cypress/fixtures/ (only for changed components)
       ↓
npm run generate:tests -- --affected-only
       → regenerate only tests for affected components
       ↓
git diff cypress/
       → a human reviews the changes
```

### Manual edits in the registry
Fields for manual editing in `registry/components.json`:
- `selectors.preferred` — change the primary selector
- `states.*` — add/fix state descriptions
- `assertions.*` — add custom checks
- `notes` — add context
- `manualOverride: true` — freeze the component from auto-updates

After a manual edit — run `npm run generate:selectors` and the tests will pick it up.

---

## Step 6: Command structure (package.json scripts)

```json
{
  "scripts": {
    "collect": "node src/agents/main-navigator.js",
    "analyze": "node src/agents/run-analyzers.js",
    "resolve": "node src/agents/identity-resolution.js",
    "generate:selectors": "node src/generators/selectors-generator.js",
    "generate:fixtures": "node src/generators/fixtures-generator.js",
    "generate:tests": "node src/generators/test-generator.js",
    "generate:all": "npm run generate:selectors && npm run generate:fixtures && npm run generate:tests",
    "pipeline": "npm run collect && npm run analyze && npm run resolve && npm run generate:all"
  }
}
```

---

## Step 7: Rules for writing tests (for the LLM and for humans)

### DO ✅
- `cy.get(SELECTORS.CART.CHECKOUT_BTN).click()` — always through the registry
- `cy.findByRole('button', { name: /checkout/i }).click()` — if there's no testid
- `cy.wait('@networkAlias')` — always wait for network after actions with side effects
- `cy.get(selector).should('be.visible')` before interacting
- One it() = one scenario, independent of the others

### DON'T ❌
- `cy.get('.btn-primary').click()` — hardcoded CSS
- `cy.wait(2000)` — arbitrary timeouts
- Dependencies between tests via global state
- `cy.get('button:contains("Checkout")')` — fragile text match
- Checking `cy.url().should('eq', '...')` with a full URL (prefer `include`)

---

## Step 8: Validating generated tests

After generation, run an automated check:

```javascript
// src/validators/test-validator.js
// Verify that in the generated tests:
// 1. There are no hardcoded selectors (regex: /cy\.get\(['"`][.#\[]/g)
// 2. All cy.wait() calls use aliases, not numbers
// 3. All SELECTORS imports exist in selectors.js
// 4. All cy.intercept() calls come before cy.visit() in beforeEach
// If there are violations — return to the LLM for a fix, pointing out the lines
```
