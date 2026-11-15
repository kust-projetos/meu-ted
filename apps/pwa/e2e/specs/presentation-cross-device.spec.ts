import { test, expect } from "@playwright/test";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import { authenticate, expectJournal, getJournal, initSpec } from "../support/harness";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

async function startCleanDevice(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    if ("caches" in globalThis) {
      await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
    }
    await Promise.all((await indexedDB.databases()).flatMap((db) =>
      db.name ? [new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(db.name!);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      })] : [],
    ));
  });
  await page.context().clearCookies();
  await page.goto("/");
  await authenticate(page);
  // The home page may mirror server data while authenticating. Clear again
  // after login so the target page must resolve the presentation from its API read.
  await page.evaluate(() => localStorage.clear());
  expect(await page.evaluate(() =>
    Object.keys(localStorage).some((key) => key.startsWith("meu-ted:account-appearance:")),
  )).toBe(false);
}

test("[ACC-08] account institution appearance persists cross-device from server", async ({ page }) => {
  const id = "acc-cross-device";
  const guard = await initSpec(page, id, { navigateTo: "/hub/patrimonio?aba=contas" });

  await page.getByRole("button", { name: "Nova", exact: true }).click();
  await page.getByRole("combobox", { name: "Instituição" }).fill("Itaú");
  await page.getByRole("option", { name: /Itaú/ }).first().click();
  await page.getByPlaceholder(/Ex: Nubank/).fill("Conta Itaú cross-device");
  await page.getByPlaceholder("0,00").fill("1000,00");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expectJournal(id, "POST", "/accounts", 200);
  expect((await getJournal(id)).some((entry) =>
    entry.method === "POST" && entry.path === "/accounts" &&
    (entry.body as { institutionId?: string } | undefined)?.institutionId === "itau",
  )).toBe(true);

  await startCleanDevice(page);
  await page.goto("/hub/patrimonio?aba=contas");
  await expect(page.getByText("Conta Itaú cross-device")).toBeVisible();
  await expect(page.getByRole("img", { name: "Itaú" })).toBeVisible();
  assertNoUndeclaredFailures(guard);
});

test("[CARD-09] card product appearance persists cross-device from server", async ({ page }) => {
  const id = "card-cross-device";
  const guard = await initSpec(page, id, { navigateTo: "/hub/patrimonio?aba=cartoes" });

  await page.getByRole("button", { name: "Novo", exact: true }).click();
  await page.getByRole("combobox", { name: "Instituição" }).fill("Nubank");
  await page.getByRole("option", { name: /Nubank/ }).first().click();
  await page.getByLabel("Modelo do cartão").selectOption("nubank-ultravioleta");
  await page.getByPlaceholder("Ex: Nubank, Itaú...").fill("Nubank cross-device");
  await page.getByPlaceholder("0,00").fill("3000,00");
  await page.getByRole("button", { name: "Salvar cartão" }).click();
  await expectJournal(id, "POST", "/cards", 200);
  expect((await getJournal(id)).some((entry) =>
    entry.method === "POST" && entry.path === "/cards" &&
    (entry.body as { institutionId?: string; cardProductId?: string } | undefined)?.institutionId === "nubank" &&
    (entry.body as { cardProductId?: string } | undefined)?.cardProductId === "nubank-ultravioleta",
  )).toBe(true);

  await startCleanDevice(page);
  await page.goto("/hub/patrimonio?aba=cartoes");
  await expect(page.getByText("Ultravioleta").first()).toBeVisible();
  await expect(page.getByText(/Disponível\s+R\$\s*3\.000,00/)).toBeVisible();
  assertNoUndeclaredFailures(guard);
});
