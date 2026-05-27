// SESSION ID: 2026-05-26_18-06-54
// STEPS: 1

import { SELECTORS } from '../../support/selectors';

describe('Login: Main Flow', () => {
  beforeEach(() => {
    cy.visit('https://test.app.juggl.co/v1/login');
  });

  it('should navigate to login page successfully', () => {
    // STEP 1: Navigate to login page
    cy.url().should('include', '/v1/login');
    cy.get('body').should('exist');
  });
});