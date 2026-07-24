import { defineConfig } from "crap4ts";

// Threshold rationale (see docs/quality-gates.md): the project currently has
// near-zero unit test coverage, so a strict/default threshold would fail on
// almost every function. We use the "lenient" preset (30) and, in the CI gate,
// scope enforcement to changed files via --changed-since so it acts as a
// ratchet on new/modified code instead of blocking on pre-existing debt.
export default defineConfig({
  threshold: 30,
  coverageMetric: "line",
  exclude: ["**/*.test.*", "**/*.spec.*", "**/*.d.ts"],
  format: "table",
  src: ["visual-bot"],
  sort: "crap",
});
