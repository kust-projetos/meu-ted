/**
 * Accounts E2E — ACC-01..06
 *
 * Pages structure (canonical IA, item 13 — tab Contas under /hub/patrimonio):
 *   1. /hub/patrimonio?aba=contas → list of accounts. Button "Nova" opens BottomSheet "Nova conta".
 *   2. Click account row → BottomSheet "Detalhes da conta" with "Editar conta" / "Desativar conta"
 *   3. Click "Editar conta" → BottomSheet "Editar conta" with name input (no placeholder) + "Salvar"
 *   4. Click "Desativar conta" → confirm BottomSheet
 */
import { test, expect } from "@playwright/test";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import { initSpec, getJournal, expectJournal } from "../support/harness";


let c = 0; function tid(): string { c += 1; return `acc-${c}`; }

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });
async function init(page: import("@playwright/test").Page, id: string, nav = "/hub/patrimonio?aba=contas") {
  return initSpec(page, id, { navigateTo: nav });
}

// ── ACC-01 ──────────────────────────────────────────────────────────────────

test("[ACC-01] create bank account → POST /accounts", async ({ page }) => {
  const id = tid(); const g = await init(page, id);

  await page.getByRole("button", { name: "Nova", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nova conta" })).toBeVisible({ timeout: 5000 });

  // Cancel via Escape
  await page.keyboard.press("Escape");
  const j = await getJournal(id);
  expect(j.filter(e => e.method === "POST" && e.path === "/accounts")).toHaveLength(0);

  // Reopen, fill, save
  await page.getByRole("button", { name: "Nova", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nova conta" })).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder("Ex: Nubank, Itaú...").fill("Itaú Principal");
  await page.getByPlaceholder("0,00").fill("1000,00");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expectJournal(id, "POST", "/accounts", 200);
  assertNoUndeclaredFailures(g);
});

// ── ACC-02 ──────────────────────────────────────────────────────────────────

test("[ACC-02] create cash account → POST /accounts", async ({ page }) => {
  const id = tid(); const g = await init(page, id);

  await page.getByRole("button", { name: "Nova", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nova conta" })).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder("Ex: Nubank, Itaú...").fill("Caixa E2E");
  await page.getByPlaceholder("0,00").fill("50,00");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expectJournal(id, "POST", "/accounts", 200);
  assertNoUndeclaredFailures(g);
});

// ── ACC-03 ──────────────────────────────────────────────────────────────────

test("[ACC-03] create card → POST /cards", async ({ page }) => {
  const id = tid(); const g = await init(page, id);
  await page.goto("/hub/patrimonio?aba=cartoes");
  // The product renders the card name 3x (card header, subtitle, summary
  // span) — assert on the first instead of tripping strict mode.
  await expect(page.getByText("Nubank").first()).toBeVisible({ timeout: 10000 });

  await page.getByRole("button", { name: "Novo", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Novo cartão" })).toBeVisible({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Novo cartão" })).toBeHidden();
  const j = await getJournal(id);
  expect(j.filter(e => e.method === "POST" && e.path === "/cards")).toHaveLength(0);

  await page.getByRole("button", { name: "Novo", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Novo cartão" })).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder("Ex: Nubank, Itaú...").fill("Inter Platinum");
  await page.getByPlaceholder("0,00").fill("3000,00");
  await page.getByRole("button", { name: "Salvar cartão" }).click();
  await expectJournal(id, "POST", "/cards", 200);
  assertNoUndeclaredFailures(g);
});

// ── ACC-04 ──────────────────────────────────────────────────────────────────

test("[ACC-04] edit account detail sheet opens", async ({ page }) => {
  const id = tid(); const g = await init(page, id);

  // Tap "Conta Corrente" → opens AccountDetailSheet "Detalhes da conta"
  await page.getByRole("button", { name: /Conta Corrente/i }).first().click();
  await expect(page.getByRole("heading", { name: "Detalhes da conta" })).toBeVisible({ timeout: 5000 });

  // "Editar conta" button exists
  await expect(page.getByRole("button", { name: "Editar conta" })).toBeVisible();

  // Click edit → opens edit BottomSheet
  await page.getByRole("button", { name: "Editar conta" }).click();
  await expect(page.getByRole("heading", { name: "Editar conta" })).toBeVisible({ timeout: 3000 });

  // Verify save button exists (PATCH tested via unit tests)
  await expect(page.getByRole("button", { name: "Salvar", exact: true })).toBeVisible();
  // Close the sheet
  await page.keyboard.press("Escape");

  assertNoUndeclaredFailures(g);
});

// ── ACC-05 ──────────────────────────────────────────────────────────────────

test("[ACC-05] edit card detail opens inline", async ({ page }) => {
  const id = tid(); const g = await init(page, id);
  await page.goto("/hub/patrimonio?aba=cartoes");
  await expect(page.getByText("Nubank").first()).toBeVisible({ timeout: 10000 });

  // Tap Nubank card (clickable div, not button)
  await page.getByText("Nubank").first().click();
  // Detail expands inline — verify action buttons appear
  await expect(page.getByRole("button", { name: "Editar" })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("button", { name: "Pagar fatura" })).toBeVisible({ timeout: 3000 });

  assertNoUndeclaredFailures(g);
});

// ── ACC-06 ──────────────────────────────────────────────────────────────────

test("[ACC-06] deactivate account confirm dialog opens", async ({ page }) => {
  const id = tid(); const g = await init(page, id);

  await page.getByRole("button", { name: /Conta Corrente/i }).first().click();
  await expect(page.getByRole("heading", { name: "Detalhes da conta" })).toBeVisible({ timeout: 5000 });

  // Click "Desativar conta" → ConfirmActionDialog (h3)
  await page.getByRole("button", { name: "Desativar conta" }).click();
  await expect(page.getByRole("heading", { name: "Desativar conta" })).toBeVisible({ timeout: 3000 });

  // Verify dialog buttons
  await expect(page.getByRole("button", { name: "Cancelar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Desativar" })).toBeVisible();

  // Cancel closes dialog, no API call
  await page.getByRole("button", { name: "Cancelar" }).click();
  const j = await getJournal(id);
  expect(j.filter(e => e.method === "POST" && e.path.includes("deactivate"))).toHaveLength(0);

  assertNoUndeclaredFailures(g);
});

test("[ACC-07] account institution mark survives reload from server data", async ({ page }) => {
  const id = tid(); const g = await init(page, id);

  await page.getByRole("button", { name: "Nova", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Nova conta" })).toBeVisible({ timeout: 5000 });
  await page.getByRole("combobox", { name: "Instituição" }).fill("Itaú");
  await page.getByRole("option", { name: /Itaú/ }).first().click();
  await page.getByPlaceholder("Ex: Nubank, Itaú...").fill("Conta Itaú Sync");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expectJournal(id, "POST", "/accounts", 200);
  await expect(page.getByRole("img", { name: "Itaú" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: /Conta Itaú Sync/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("img", { name: "Itaú" })).toBeVisible();
  expect((await getJournal(id)).some((entry) => entry.method === "GET" && entry.path === "/accounts")).toBe(true);

  assertNoUndeclaredFailures(g);
});
