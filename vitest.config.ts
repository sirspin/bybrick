import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    // Throwaway local Postgres only. The harness refuses non-local hosts.
    env: {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://bybrick_test:bybrick_test@localhost:5432/postgres",
    },
  },
});
