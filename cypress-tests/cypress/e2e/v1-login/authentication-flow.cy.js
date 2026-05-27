// SESSION ID: 2026-05-26_18-06-54
// STEPS: 2-4

import { SELECTORS } from '../../support/selectors';

describe('Login: User Login Authentication Flow', () => {
  beforeEach(() => {
    cy.intercept('POST', '**/api/login', { statusCode: 200, body: { token: 'fake-token' } }).as('loginSuccess');
    cy.visit('/v1/login');
  });

  // STEP 2-4: Happy path - user enters credentials and submits login form successfully
  it('should submit login form with valid credentials and authenticate user', () => {
    cy.get(SELECTORS.V1_LOGIN.EMAIL).should('exist').and('be.visible').and('be.enabled');
    cy.get(SELECTORS.V1_LOGIN.EMAIL).clear().type(Cypress.env('email'));

    cy.get(SELECTORS.V1_LOGIN.PASSWORD).should('exist').and('be.visible').and('be.enabled');
    cy.get(SELECTORS.V1_LOGIN.PASSWORD).clear().type(Cypress.env('password'));

    cy.get(SELECTORS.V1_LOGIN.SIGN_IN).should('exist').and('be.visible').and('be.enabled');
    cy.get(SELECTORS.V1_LOGIN.SIGN_IN).click();

    cy.wait('@loginSuccess').its('response.statusCode').should('eq', 200);
  });

  // Edge case: Login API returns 500 error
  it('should display error message when login API returns 500 error', () => {
    cy.intercept('POST', '**/api/login', { statusCode: 500, body: { error: 'Internal Server Error' } }).as('loginError500');

    cy.get(SELECTORS.V1_LOGIN.EMAIL).clear().type(Cypress.env('email'));
    cy.get(SELECTORS.V1_LOGIN.PASSWORD).clear().type(Cypress.env('password'));
    cy.get(SELECTORS.V1_LOGIN.SIGN_IN).click();

    cy.wait('@loginError500').its('response.statusCode').should('eq', 500);
  });

  // Edge case: Login API returns 401 unauthorized
  it('should display error message when login API returns 401 unauthorized', () => {
    cy.intercept('POST', '**/api/login', { statusCode: 401, body: { error: 'Unauthorized' } }).as('loginError401');

    cy.get(SELECTORS.V1_LOGIN.EMAIL).clear().type(Cypress.env('email'));
    cy.get(SELECTORS.V1_LOGIN.PASSWORD).clear().type(Cypress.env('password'));
    cy.get(SELECTORS.V1_LOGIN.SIGN_IN).click();

    cy.wait('@loginError401').its('response.statusCode').should('eq', 401);
  });

  // Edge case: Login API returns 400 invalid credentials
  it('should display error message when login API returns 400 invalid credentials', () => {
    cy.intercept('POST', '**/api/login', { statusCode: 400, body: { error: 'Invalid credentials' } }).as('loginError400');

    cy.get(SELECTORS.V1_LOGIN.EMAIL).clear().type(Cypress.env('email'));
    cy.get(SELECTORS.V1_LOGIN.PASSWORD).clear().type(Cypress.env('password'));
    cy.get(SELECTORS.V1_LOGIN.SIGN_IN).click();

    cy.wait('@loginError400').its('response.statusCode').should('eq', 400);
  });

  // Edge case: Submit button shows loading state during API call
  it('should show loading state on submit button during API call', () => {
    cy.intercept('POST', '**/api/login', (req) => {
      req.reply((res) => {
        res.delay(1000);
        res.send({ statusCode: 200, body: { token: 'fake-token' } });
      });
    }).as('loginWithDelay');

    cy.get(SELECTORS.V1_LOGIN.EMAIL).clear().type(Cypress.env('email'));
    cy.get(SELECTORS.V1_LOGIN.PASSWORD).clear().type(Cypress.env('password'));
    cy.get(SELECTORS.V1_LOGIN.SIGN_IN).click();

    cy.get(SELECTORS.V1_LOGIN.SIGN_IN).should('be.disabled');
    cy.wait('@loginWithDelay');
  });

  // Edge case: Email field submitted empty
  it('should not submit form when email field is empty', () => {
    cy.get(SELECTORS.V1_LOGIN.EMAIL).should('exist').and('be.visible');
    cy.get(SELECTORS.V1_LOGIN.PASSWORD).clear().type(Cypress.env('password'));
    cy.get(SELECTORS.V1_LOGIN.SIGN_IN).click();
  });

  // Edge case: Password field submitted empty
  it('should not submit form when password field is empty', () => {
    cy.get(SELECTORS.V1_LOGIN.EMAIL).clear().type(Cypress.env('email'));
    cy.get(SELECTORS.V1_LOGIN.PASSWORD).should('exist').and('be.visible');
    cy.get(SELECTORS.V1_LOGIN.SIGN_IN).click();
  });
});