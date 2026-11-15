import { test, expect, type Browser } from "@playwright/test";
import { allowFailure, attachGuard, assertNoUndeclaredFailures, createGuard } from "../support/failure-guard";
import { applyCspRewrite, authenticate, getJournal, initSpec } from "../support/harness";
import { E2E_TEST_ID_HEADER, FIXED_CLOCK } from "../support/reset";

async function secondDevice(browser: Browser, testId: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const guard = createGuard();
  attachGuard(page, guard);
  allowFailure(guard, { url: "/auth/session", status: 401, message: "401 (Unauthorized)", reason: "expected anonymous cookie-session probe before login" });
  allowFailure(guard, { message: "reading 'waiting'", reason: "SW blocked" });
  allowFailure(guard, { url: "/profile", reason: "fixture has no /profile" });
  allowFailure(guard, { url: "/pwa-control", reason: "fixture has no /pwa-control" });
  await page.clock.setFixedTime(FIXED_CLOCK);
  await applyCspRewrite(page);
  await context.setExtraHTTPHeaders({ [E2E_TEST_ID_HEADER]: testId });
  await page.route(
    /\/api\/agent\/agents\/finance-chat-agent\/[^/]+\/rpc\/pending-operations\/active(?:\?.*)?$/,
    async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0 }) }),
  );
  return { context, page, guard };
}

test("[ACC-08] account institution appearance persists cross-device from server", async ({ browser, page }) => {
  const testId = "cross-device-account";
  const guard = await initSpec(page, testId);
  const device = await secondDevice(browser, testId);
  await page.goto("/hub/patrimonio?aba=contas");
  await page.getByRole("button", { name: "Nova", exact: true }).click();
  await page.getByRole("combobox", { name: "Instituição" }).fill("Itaú");
  await page.getByRole("option", { name: /Itaú/ }).first().click();
  await page.getByPlaceholder(/Ex: Nubank/).fill("Conta Itaú cross-device");
  await page.getByPlaceholder("0,00").fill("1000,00");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect.poll(async () => getJournal(testId)).toContainEqual(expect.objectContaining({
    method: "POST", path: "/accounts", body: expect.objectContaining({ institutionId: "itau" }),
  }));

  try {
    await device.page.goto("/");
    await authenticate(device.page);
    expect(await device.page.evaluate(() =>
      Object.keys(localStorage).some((key) => key.startsWith("meu-ted:account-appearance:")),
    )).toBe(false);
    await device.page.goto("/hub/patrimonio?aba=contas");
    await expect(device.page.getByRole("button", { name: /Conta Itaú cross-device/ })).toBeVisible();
    await expect(device.page.getByRole("img", { name: "Itaú" })).toBeVisible();
    assertNoUndeclaredFailures(guard);
    assertNoUndeclaredFailures(device.guard);
  } finally {
    await device.context.close();
  }
});

test("[CARD-09] card product appearance persists cross-device from server", async ({ browser, page }) => {
  const testId = "cross-device-card";
  const guard = await initSpec(page, testId, { navigateTo: "/hub/patrimonio?aba=cartoes" });
  const device = await secondDevice(browser, testId);
  await page.getByRole("button", { name: "Novo", exact: true }).click();
  await page.getByRole("combobox", { name: "Instituição" }).fill("Nubank");
  await page.getByRole("option", { name: /Nubank/ }).first().click();
  await page.getByLabel("Modelo do cartão").selectOption({ label: /Roxinho/ });
  await page.getByPlaceholder("Ex: Nubank, Itaú...").fill("Nubank cross-device");
  await page.getByPlaceholder("0,00").fill("3000,00");
  await page.getByRole("button", { name: "Salvar cartão" }).click();
  await expect.poll(async () => getJournal(testId)).toContainEqual(expect.objectContaining({
    method: "POST", path: "/cards",
    body: expect.objectContaining({ institutionId: "nubank", cardProductId: "nubank-roxinho" }),
  }));

  try {
    await device.page.goto("/");
    await authenticate(device.page);
    expect(await device.page.evaluate(() =>
      Object.keys(localStorage).some((key) => key.startsWith("meu-ted:account-appearance:")),
    )).toBe(false);
    await device.page.goto("/hub/patrimonio?aba=cartoes");
    await expect(device.page.getByText("Nubank cross-device").first()).toBeVisible();
    await expect(device.page.getByText("Roxinho").first()).toBeVisible();
    assertNoUndeclaredFailures(guard);
    assertNoUndeclaredFailures(device.guard);
  } finally {
    await device.context.close();
  }
});
