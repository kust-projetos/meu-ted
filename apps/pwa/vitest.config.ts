import { defineConfig } from "vitest/config";
import path from "path";

// P2-11: coverage scope is the WHOLE production source tree (src/**), with
// proportionate exclusions instead of a frozen commit-range list. Route/page
// wrappers are excluded because they only compose covered features and are
// exercised end-to-end by the Playwright suite; global calibrated thresholds
// gate the whole tree.
interface CoverageConfig {
  provider: "v8";
  reporter: string[];
  all: boolean;
  include: string[];
  exclude: string[];
  thresholds: {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
  };
}

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // threads pool is reliable in this workspace (forks pool hangs under
    // file-parallelism on this environment). The default worker count
    // (all CPUs) triggers "Failed to start threads worker" timeouts on this
    // environment; capping maxWorkers keeps `pnpm test` runnable and stable
    // (P0.5 benchmark A/B: config A = maxWorkers 2, fileParallelism true).
    pool: "threads",
    maxWorkers: 2,
    fileParallelism: true,
    testTimeout: 10000,
    hookTimeout: 10000,
    setupFiles: ["./src/test/setup.ts"],
    include: [
      "src/**/*.test.{ts,tsx}",
      "e2e/fixture-api/server.test.ts",
      "e2e/support/failure-guard.test.ts",
      "e2e/support/harness.test.ts",
      "e2e/support/ports.test.ts",
      "e2e/support/fail-closed.test.ts",
      "e2e/support/run-ci-failure.test.ts",
      "e2e/support/run-ci-outputs.test.ts",
      "e2e/support/live-closure-guards.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      all: true,
      include: ["src/**"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/__tests__/**",
        "**/*.config.*",
        "src/test/**",
        "src/env.d.ts",
        // Route/page wrappers only compose covered features and are covered by e2e.
        "src/app/**/page.tsx",
        "src/app/layout.tsx",
        "src/app/manifest.ts",
      ],
      // P2-11: global thresholds calibrated against the measured src/** baseline
      // (83.8/75.6/83.5/86.4) with ~3.5pt headroom — a real ratchet without
      // freezing out legacy modules the way the old per-file gate did.
      thresholds: {
        statements: 80,
        branches: 72,
        functions: 80,
        lines: 83,
      },
    } as CoverageConfig,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
