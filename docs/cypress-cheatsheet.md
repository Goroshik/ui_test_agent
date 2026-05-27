# Cypress test cheatsheet (used by test-generator)

The LLM reads this file before producing any Cypress spec. Every rule here
must hold in the generated `.cy.js`. **Cypress only — never Playwright, never
Jest, never RTL.**

## 1. Imports & file structure

```js
// ✅ Top of every spec
import { SELECTORS } from '../../support/selectors';

describe('PageName: Scenario name', () => {
  beforeEach(() => {
    cy.login();              // skip on login page itself
    cy.intercept(...).as('x'); // ALL intercepts go here, BEFORE visit
    cy.visit('/some/path');
  });

  it('should <action> <expected result>', () => { /* ... */ });
});
```

- No `require()`, no CommonJS.
- No default import: `import { SELECTORS }` only.
- One `describe()` per spec file.
- Each spec starts with a header comment: `// SESSION ID: …` and `// STEPS: a-b`.

## 2. Selectors

| Goal | ✅ Cypress | ❌ Forbidden |
|---|---|---|
| Get element | `cy.get(SELECTORS.LOGIN.EMAIL)` | `cy.get('[data-testid="email"]')` (hardcoded) |
| By text | `cy.contains('Sign in')` | `cy.get('button:has-text("Sign in")')` |
| Within scope | `cy.get(parent).within(() => { … })` | nested `cy.get` chained off detached query |

`SELECTORS.X.Y` values are **plain CSS strings** — use them directly.
Bracket-notation `SELECTORS['kebab-id']` is forbidden — only dot-notation.

## 3. Actions

| Action | ✅ Cypress | ❌ Forbidden |
|---|---|---|
| Type text | `cy.get(sel).clear().type('hello')` | `.fill('hello')` (Playwright) |
| Click | `cy.get(sel).click()` | `await el.click()` (Playwright) |
| Check | `cy.get(sel).check()` | `cy.get(sel).click()` for checkboxes |
| Select | `cy.get(sel).select('Option')` | `cy.get(sel).find('option').click()` |
| Submit form | `cy.get(formSel).submit()` | trigger Enter via DOM event |

**Forbidden everywhere:** `await page.…`, `page.locator(...)`, `getByTestId(...)`,
`getByRole(...)`, `expect(...)` (Playwright/Jest), `.fill(`, `.press(`, `.hover(`
chained on a Playwright locator.

## 4. Assertions

```js
// ✅ Visibility / state
cy.get(sel).should('exist').and('be.visible');
cy.get(sel).should('be.disabled');
cy.get(sel).should('have.attr', 'aria-checked', 'true');

// ✅ Text
cy.get(sel).should('contain', 'Welcome');
cy.get(sel).should('have.text', 'Welcome');

// ✅ URL
cy.url().should('include', '/dashboard');
cy.location('pathname').should('eq', '/dashboard');

// ✅ Storage
cy.window().its('localStorage').invoke('getItem', 'token').should('exist');
```

Always assert **before** interacting (`should('be.visible')`) and **after**
where the registry has `post_interaction` assertions.

## 5. Waiting

- ✅ `cy.wait('@alias')` after a click/submit that triggers an intercepted call.
- ✅ `cy.get(sel, { timeout: 10000 }).should(...)` to wait for element.
- ❌ `cy.wait(500)` — numeric waits are banned without exception.
- ❌ `await new Promise(r => setTimeout(r, 1000))` — no manual sleeps.

## 6. Network intercepts

**Never invent fixture filenames.** Only reference files in the AVAILABLE
FIXTURES list provided in the prompt. If no fixture exists for a call,
use an inline body instead:

```js
// ✅ Inline body when no fixture available
cy.intercept('POST', '**/api/x', { statusCode: 200, body: { ok: true } }).as('x');

// ✅ Fixture only when file IS in AVAILABLE FIXTURES
cy.intercept('POST', '**/api/login', { fixture: 'v1-login__sign-in--success.json' }).as('login');

// ❌ Inventing a filename = test breaks at runtime
cy.intercept('POST', '**/api/login', { fixture: 'login-success.json' }).as('login');
```

Pattern:

```js
beforeEach(() => {
  cy.intercept('POST', '**/api/login', { statusCode: 200, body: { token: 'fake' } }).as('login');
  cy.visit('/login');
});

it('logs in', () => {
  cy.get(SELECTORS.LOGIN.EMAIL).clear().type('a@b.c');
  cy.get(SELECTORS.LOGIN.PASSWORD).clear().type('xxx');
  cy.get(SELECTORS.LOGIN.SIGN_IN).click();
  cy.wait('@login').its('response.statusCode').should('eq', 200);
});
```

Every `cy.intercept()` lives **inside `beforeEach`, BEFORE `cy.visit`**.
Aliases follow camelCase: `loginSuccess`, not `login-success` or `LOGIN_SUCCESS`.

## 7. Credentials

```js
cy.get(SELECTORS.LOGIN.EMAIL).type(Cypress.env('email'));
cy.get(SELECTORS.LOGIN.PASSWORD).type(Cypress.env('password'));
```

Never hardcode credentials. `cy.login()` (in `support/e2e.js`) handles
auth once per spec — call it as the FIRST line of `beforeEach` (except on
the login page itself).

## 8. Async / await

Cypress chains are NOT promises. **Never** put `async`/`await` in a spec.

```js
// ❌
it('does thing', async () => { await cy.visit('/'); });

// ✅
it('does thing', () => { cy.visit('/'); });
```

## 9. Edge cases (from test plan)

| Edge case | Pattern |
|---|---|
| empty-state | seed empty fixture, assert empty placeholder visible |
| disabled | assert `should('be.disabled')` then attempt click → no nav |
| network-error | `cy.intercept(..., { statusCode: 500 }).as('err')` + assert error toast |
| loading-state | assert spinner appears, then `cy.wait('@call')`, then assert spinner gone |

## 10. Output requirements (when generating)

- Output **only raw JavaScript**, no markdown fences, no commentary.
- First character must be `/` (start of a `// comment`).
- ASCII quotes only (`'` `"`), never smart quotes.
- One blank line between `describe` and `beforeEach`, none inside expressions.
