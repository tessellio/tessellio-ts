import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The canvas tests draw on a surface, so they need a DOM.
    environment: "jsdom",
    // The budget suites measure real decode-and-apply time; a second
    // worker running beside them steals the very thing they assert on.
    // Files run one at a time so a measurement means what it says.
    fileParallelism: false,
  },
});
