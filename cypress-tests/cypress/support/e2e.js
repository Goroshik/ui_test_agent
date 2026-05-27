import { SELECTORS } from './selectors.js';

/**
 * Swallow uncaught exceptions thrown by the *application under test* so they
 * don't crash our Cypress specs. Test-code errors (thrown inside `it`/hooks)
 * still bubble up as usual — this only catches errors from the loaded page.
 *
 * Set CYPRESS_STRICT_APP_ERRORS=1 to re-enable strict mode for debugging.
 */
Cypress.on('uncaught:exception', (err) => {
  if (Cypress.env('STRICT_APP_ERRORS')) return true;
  // Common noisy errors when the SPA boots without prior auth/state.
  // Returning false tells Cypress to ignore the exception.
  // eslint-disable-next-line no-console
  console.warn('[app uncaught]', err.message);
  return false;
});

/**
 * cy.login() — authenticates via the UI and caches the session.
 * Credentials are read from cypress.env.json or --env flags:
 *   { "email": "...", "password": "..." }
 */
Cypress.Commands.add('login', () => {
  cy.session(
    'authenticated',
    () => {
      cy.visit('/v1/login');
      cy.get(SELECTORS.V1_LOGIN.EMAIL)
        .should('be.visible')
        .clear()
        .type(Cypress.env('email') ?? '');
      cy.get(SELECTORS.V1_LOGIN.PASSWORD)
        .should('be.visible')
        .clear()
        .type(Cypress.env('password') ?? '', { log: false });
      cy.get(SELECTORS.V1_LOGIN.SIGN_IN)
        .should('be.visible')
        .click();
      cy.url().should('not.include', '/login');
    },
    {
      cacheAcrossSpecs: true,
    },
  );
});
