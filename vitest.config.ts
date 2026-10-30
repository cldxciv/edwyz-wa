import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Two projects:
 * - unit: tests/**\/*.test.ts except tests/db/**. Never needs a database (`npx vitest run`, `npm test`).
 * - db:   tests/db/**\/*.test.ts against a disposable Postgres named by DATABASE_URL_TEST (docs/SPEND-CONTROLS-SPEC.md 10.2).
 *         Every file skips cleanly when the variable is unset, so the project always exists and `npm run test:db` only does
 *         real work where a test database is configured (the pre-deploy check). Each file works in its own schema
 *         (tests/helpers/pg.ts), so files may run in parallel.
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "tests/db/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
