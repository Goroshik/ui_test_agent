# cypress-tests

Standalone Cypress project located next to the main repo.
It has its own `package.json` and does not depend on the root project dependencies.

## Run

```bash
cd cypress-tests
npm install
npm test
```

## Structure

- `cypress/e2e/` - Cypress tests
- `cypress.config.js` - Cypress config
- `package.json` - local dependencies and scripts for Cypress only
