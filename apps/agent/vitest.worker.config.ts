import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  test: {
    include: ["tests/workerd/**/*.test.ts"],
    pool: "@cloudflare/vitest-pool-workers",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
