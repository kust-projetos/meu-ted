/**
 * Production smoke E2E tests — SMOKE-01..04
 *
 * Opt-in only (E2E_PRODUCTION_SMOKE=1). Validates unauthenticated
 * registration shell across key routes without any fixture/API.
 * Never touches authenticated content or writes.
 *
 * Matrix:
 * SMOKE-01 direct load / → registration shell renders
 * SMOKE-02 direct load /registros → registration shell renders
 * SMOKE-03 direct load /contas → registration shell renders
 * SMOKE-04 direct load /cartoes → registration shell renders
 */

import { test, expect, type Page } from "@playwright/test";

// Only run when opt-in env var is set
const SMOKE = process.env.E2E_PRODUCTION_SMOKE === "1";
const READ_ONLY_METHODS = ["GET", "HEAD", "OPTIONS"];

async function gotoReadOnly(page: Page, path: string) {
  const writes: string[] = [];
  page.on("request", (req) => {
    if (!READ_ONLY_METHODS.includes(req.method())) {
      writes.push(`${req.method()} ${req.url()}`);
    }
  });
  await page.goto(path);
  if (writes.length > 0) {
    throw new Error(`production smoke emitted writes: ${writes.join(", ")}`);
  }
}

test.describe("production-smoke", () => {
  test.skip(!SMOKE, "Opt-in only — set E2E_PRODUCTION_SMOKE=1 to run");

  test("[SMOKE-01] direct load / shows registration shell, no authenticated content", async ({ page }) => {
    await gotoReadOnly(page, "/");
    // Assert registration shell is visible
    await expect(page.getByRole("button", { name: /Registrar|Entrar/i })).toBeVisible({ timeout: 15000 });
    // Assert no authenticated elements leak through
    await expect(page.locator('nav[data-nav="bottom"]').getByRole("button", { name: "Novo lançamento" })).toBeHidden();
    await expect(page.getByRole("heading", { name: /Resumo|Dashboard/i })).toBeHidden();
  });

  test("[SMOKE-02] direct load /registros shows registration shell", async ({ page }) => {
    await gotoReadOnly(page, "/registros");
    await expect(page.getByRole("button", { name: /Registrar|Entrar/i })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: /Registros/i })).toBeHidden();
  });

  test("[SMOKE-03] direct load legacy /contas redirects and shows registration shell", async ({ page }) => {
    await gotoReadOnly(page, "/contas");
    await expect(page).toHaveURL(/\/hub\/patrimonio\?aba=contas/);
    await expect(page.getByRole("button", { name: /Registrar|Entrar/i })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: /Contas/i })).toBeHidden();
  });

  test("[SMOKE-04] direct load legacy /cartoes redirects and shows registration shell", async ({ page }) => {
    await gotoReadOnly(page, "/cartoes");
    await expect(page).toHaveURL(/\/hub\/patrimonio\?aba=cartoes/);
    await expect(page.getByRole("button", { name: /Registrar|Entrar/i })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: /Cartões/i })).toBeHidden();
  });

  // V4.1 Task 9.10 — the deployed bundle must BE the approved commit.
  // EXPECTED_SHA comes from the deploy workflow (github.event.workflow_run.head_sha).
  test("[SMOKE-05] deployed PWA release identity matches the approved SHA", async ({ page }) => {
    const expected = (process.env.EXPECTED_SHA ?? "").trim();
    test.skip(!expected, "set EXPECTED_SHA to the approved deploy commit");
    const res = await page.request.get("/api/build-info");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(typeof body.gitSha).toBe("string");
    expect(body.gitSha).toBe(expected);
  });
});
