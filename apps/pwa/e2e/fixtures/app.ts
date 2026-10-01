/**
 * Playwright test fixtures and shared E2E helpers.
 * Provides: test/extended fixtures, CSP modification, device registration,
 * fixture API URL constant, and journal query helpers.
 */

import { test as base } from "@playwright/test";
import type { Page } from "@playwright/test";
import { FIXTURE_URL } from "../support/reset";
import { createGuard, type GuardState } from "../support/failure-guard";

export { FIXTURE_URL };
export { createGuard, type GuardState };

let testCounter = 0;
function generateTestId(): string {
  testCounter++;
  return `e2e-${Date.now()}-${testCounter}`;
}

/**
 * Modify CSP headers to allow fixture API connections.
 * Must be called BEFORE page.goto().
 */
export async function allowFixtureCsp(page: Page): Promise<void> {
  await page.route("**", async (route) => {
    const response = await route.fetch();
    const csp = response.headers()["content-security-policy"];
    if (csp) {
      const modified = csp
        .replace(/connect-src\s+([^;]+)/, `connect-src ${FIXTURE_URL} $1`)
        .replace(/script-src\s+([^;]+)/, "script-src 'unsafe-eval' $1");
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": modified },
      });
    } else {
      await route.fulfill({ response });
    }
  });
}

/**
 * Register device by clicking the "Registrar" button.
 * Must be called after page.goto() when on registration screen.
 */
export async function registerDevice(page: Page): Promise<void> {
  const emailInput = page.getByLabel("E-mail");
  const passwordInput = page.getByLabel("Senha");
  const loginBtn = page.getByRole("button", { name: "Entrar" });
  const regBtn = page.getByRole("button", { name: "Registrar" });

  if (await emailInput.isVisible({ timeout: 4000 }).catch(() => false)) {
    await emailInput.fill("test@example.com");
    await passwordInput.fill("password123");
    await loginBtn.click();
  } else if (await regBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await regBtn.click();
  }
  await page.waitForTimeout(1000);
  await page.waitForLoadState("networkidle");
}

/**
 * Query the fixture journal for entries matching method+path.
 */
export async function getJournalEntries(testId: string): Promise<Array<{ method: string; path: string; status: number }>> {
  const res = await fetch(`${FIXTURE_URL}/__e2e/journal?testId=${testId}`, {
    headers: { "x-e2e-test-id": testId },
  });
  if (!res.ok) return [];
  return res.json();
}

/**
 * Standard setup: CSP modification, fixture reset, fixed clock, and test header.
 */
export async function e2eSetup(page: Page, testId: string): Promise<void> {
  await allowFixtureCsp(page);
  const res = await fetch(`${FIXTURE_URL}/__e2e/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-e2e-test-id": testId },
    body: JSON.stringify({ testId, seed: "populated" }),
  });
  if (!res.ok) throw new Error(`Fixture reset failed: ${res.status}`);
  await page.clock.setFixedTime("2026-07-17T12:00:00.000Z");
  await page.context().setExtraHTTPHeaders({ "x-e2e-test-id": testId });
}

/* eslint-disable react-hooks/rules-of-hooks */
export const test = base.extend<{
  testId: string;
  guard: GuardState;
  fixtureUrl: string;
}>({
  testId: async ({}, use) => {
    await use(generateTestId());
  },
  guard: async ({}, use) => {
    await use(createGuard());
  },
  fixtureUrl: async ({}, use) => {
    await use(FIXTURE_URL);
  },
});
/* eslint-enable react-hooks/rules-of-hooks */

export { expect } from "@playwright/test";
