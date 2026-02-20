import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Vitest config for integration tests (real API calls).
 *
 * Run with:  npm run test:integration
 *
 * These tests are intentionally excluded from the main `npm test` suite
 * because they require real API credentials and incur API costs.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/integration/**/*.test.ts"],
    // Longer timeout for real network calls
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});
