import { defineConfig } from "vitest/config";

// Firestore security-rules tests. They need the Firestore emulator running;
// use `npm run test:rules`, which starts it around the run.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rules/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
