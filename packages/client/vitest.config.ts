import { defineConfig } from "vitest/config";

/**
 * Minimal node-environment runner for the client's PURE logic — the Zustand
 * message store and the todo-fold. These suites render no JSX, so we deliberately
 * skip `vite.config.ts` (react/tailwind plugins) and stay in the fast, dep-light
 * node environment. Type-only `@cm/shared` imports are erased at transform, so no
 * DOM or workspace-build is required to run them.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
