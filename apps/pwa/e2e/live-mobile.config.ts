import { defineConfig } from "@playwright/test";

/**
 * Live MOBILE E2E — full PWA journey (login, accounts, transactions, TED chat,
 * TED mutation approval) against a REAL deployment at mobile viewport.
 *
 * Opt-in: PWA_LIVE_E2E=1 + PWA_LIVE_ADMIN_EMAIL/PWA_LIVE_ADMIN_PASSWORD.
 * Base URL: PWA_LIVE_BASE_URL (required when the live test is enabled).
 * No credentials checked in. No webServer — target must be reachable.
 */
export default defineConfig({
  testDir: "./specs",
  testMatch: /live-mobile-full\.spec\.ts/,
  timeout: 420_000,
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
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/live-mobile-html" }]],
  outputDir: "test-results/live-mobile",
});
