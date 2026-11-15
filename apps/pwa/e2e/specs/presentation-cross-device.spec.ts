import { test, expect } from "@playwright/test";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import { expectJournal, getJournal, initSpec } from "../support/harness";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("[ACC-08] account institution appearance persists cross-device from server", async ({ browser, page }) => {
  const guardA = await initSpec(page, "acc-801", { navigateTo: "/hub/patrimonio?aba=contas" });
  const contextB = await browser.newContext();
  try {
    const pageB = await contextB.newPage();
    const guardB = await initSpec(pageB, "acc-802");
    await page.getByRole("button", { name: "Nova", exact: true }).click();
    await page.getByRole("combobox", { name: "Instituição" }).fill("Itaú");
    await page.getByRole("option", { name: /Itaú/ }).first().click();
    await page.getByPlaceholder(/Ex: Nubank/).fill("Conta Itaú cross-device");
    await page.getByPlaceholder("0,00").fill("1000,00");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expectJournal("acc-801", "POST", "/accounts", 200);
    expect((await getJournal("acc-801")).some((entry) =>
      entry.method === "POST" && entry.path === "/accounts" &&
      (entry.body as { institutionId?: string } | undefined)?.institutionId === "itau",
    )).toBe(true);

    expect(await pageB.evaluate(() =>
      Object.keys(localStorage).some((key) => key.startsWith("meu-ted:account-appearance:")),
    )).toBe(false);
    await pageB.goto("/hub/patrimonio?aba=contas");
    await expect(pageB.getByRole("button", { name: /Conta Itaú cross-device/ })).toBeVisible();
    await expect(pageB.getByRole("img", { name: "Itaú" })).toBeVisible();
    assertNoUndeclaredFailures(guardA);
    assertNoUndeclaredFailures(guardB);
  } finally {
    await contextB.close();
  }
});

test("[CARD-09] card product appearance persists cross-device from server", async ({ browser, page }) => {
  const guardA = await initSpec(page, "card-801", { navigateTo: "/hub/patrimonio?aba=cartoes" });
  const contextB = await browser.newContext();
  try {
    const pageB = await contextB.newPage();
    const guardB = await initSpec(pageB, "card-802");
    await page.getByRole("button", { name: "Novo", exact: true }).click();
    await page.getByRole("combobox", { name: "Instituição" }).fill("Nubank");
    await page.getByRole("option", { name: /Nubank/ }).first().click();
    await page.getByLabel("Modelo do cartão").selectOption({ label: /Roxinho/ });
    await page.getByPlaceholder("Ex: Nubank, Itaú...").fill("Nubank cross-device");
    await page.getByPlaceholder("0,00").fill("3000,00");
    await page.getByRole("button", { name: "Salvar cartão" }).click();
    await expectJournal("card-801", "POST", "/cards", 200);
    expect((await getJournal("card-801")).some((entry) =>
      entry.method === "POST" && entry.path === "/cards" &&
      (entry.body as { institutionId?: string; cardProductId?: string } | undefined)?.institutionId === "nubank" &&
      (entry.body as { cardProductId?: string } | undefined)?.cardProductId === "nubank-roxinho",
    )).toBe(true);

    expect(await pageB.evaluate(() =>
      Object.keys(localStorage).some((key) => key.startsWith("meu-ted:account-appearance:")),
    )).toBe(false);
    await pageB.goto("/hub/patrimonio?aba=cartoes");
    await expect(pageB.getByText("Nubank cross-device").first()).toBeVisible();
    await expect(pageB.getByText("Roxinho").first()).toBeVisible();
    assertNoUndeclaredFailures(guardA);
    assertNoUndeclaredFailures(guardB);
  } finally {
    await contextB.close();
  }
});
