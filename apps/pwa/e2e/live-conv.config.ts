import { defineConfig } from "@playwright/test";

/**
 * Live TED CONVERSATION — 5+ turnos com modelo real em produção.
 * Opt-in: PWA_LIVE_E2E=1 + PWA_LIVE_ADMIN_EMAIL/PWA_LIVE_ADMIN_PASSWORD.
 * Base URL: PWA_LIVE_BASE_URL. Sem credenciais no repo, sem webServer.
 */
export default defineConfig({
  testDir: "./specs",
  testMatch: /live-ted-conversation\.spec\.ts/,
  timeout: 600_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.PWA_LIVE_BASE_URL || "https://example.invalid",
    headless: true,
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
  },
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/live-conv-html" }]],
  outputDir: "test-results/live-conv",
});
