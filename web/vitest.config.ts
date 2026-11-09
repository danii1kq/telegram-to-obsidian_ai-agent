import { defineConfig } from "vitest/config";

/**
 * The tests of the frontend.
 *
 * The renderer of the notes needs a DOM: DOMPurify sanitizes the html with the
 * browser API, so the tests run in jsdom instead of a bare node process.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
