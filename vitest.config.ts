import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The canvas tests draw on a surface, so they need a DOM.
    environment: "jsdom",
  },
});
