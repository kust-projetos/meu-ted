import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^cloudflare:workers$/, replacement: fileURLToPath(new URL("./tests/mocks/cloudflare-workers.ts", import.meta.url)) },
      { find: /^cloudflare:email$/, replacement: fileURLToPath(new URL("./tests/mocks/cloudflare-email.ts", import.meta.url)) },
      { find: /^cloudflare:.+$/, replacement: fileURLToPath(new URL("./tests/mocks/cloudflare-workers.ts", import.meta.url)) },
    ],
  },
  ssr: {
    noExternal: [true, /.*/],
  },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "tests/workerd/**"],
    server: {
      deps: {
        inline: true,
      },
    },
  },
});
