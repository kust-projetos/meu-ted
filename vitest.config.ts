import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    workspace: [
      'packages/llm-contracts',
      'apps/api',
      'apps/pwa',
      'apps/agent',
      'apps/codex-broker',
    ],
  },
});
