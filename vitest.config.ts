import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so unit tests don't load the React/PWA plugins.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    restoreMocks: true,
  },
});
