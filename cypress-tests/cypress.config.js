const { defineConfig } = require("cypress");

module.exports = defineConfig({
  e2e: {
    specPattern: "cypress/e2e/**/*.cy.js",
    baseUrl: "https://test.app.juggl.co",
    supportFile: "cypress/support/e2e.js"
  },
  video: false,
  screenshotOnRunFailure: true
});
