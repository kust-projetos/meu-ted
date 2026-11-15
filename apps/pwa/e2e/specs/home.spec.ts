/**
 * Home page E2E tests — HOME-01..10
 *
 * Matrix:
 * HOME-01 profile button → /perfil
 * HOME-02 bell → notification sheet opens
 * HOME-03 quick expense → expense sheet
 * HOME-04 account card → patrimonio contas
 * HOME-05 card card → patrimonio cartoes
 * HOME-06 payable card → compromissos
 * HOME-07 notification item → navigates to target
 * HOME-08 dismiss notification → removed
 * HOME-09 quick income → income sheet
 * HOME-10 quick transfer → transfer sheet
 *
 * Harness aligned with auth/transaction (CSP + reset + fixed clock + register).
 * Seed: Conta Corrente, Dinheiro, Nubank card; payables Conta de Luz / Internet.
 * Fixed clock 2026-07-17 → Internet overdue notification present.
 */

import { test, expect } from "@playwright/test";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import { prepareSpec, authenticate, getJournal } from "../support/harness";



let counter = 0;
function tid(): string {
  counter += 1;
  return `home-${counter}`;
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** Write verbs that are unexpected on pure navigation/open flows. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_WRITE_PATHS = new Set([
  "/auth/devices/register",
  "/auth/sign-in/email",
  "/auth/sign-in",
  "/auth/agent-token",
]);

async function assertNoUnexpectedWrites(testId: string): Promise<void> {
  const journal = await getJournal(testId);
  const unexpected = journal.filter(
    (e) => WRITE_METHODS.has(e.method) && !AUTH_WRITE_PATHS.has(e.path),
  );
  expect(unexpected).toEqual([]);
}

async function init(page: import("@playwright/test").Page, id: string) {
  // `prepareSpec`, not `initSpec`: the init script below must be registered
  // BEFORE the first navigation, and `initSpec` navigates internally.
  const guard = await prepareSpec(page, id, {
    baselineAllows: false,
    allow: [
      { message: "reading 'waiting'", reason: "SW blocked" },
      { message: "ERR_ABORTED", reason: "RSC prefetch abort on nav" },
      { url: "_rsc", reason: "RSC prefetch aborted on nav" },
    ],
  });
  // Clear dismissed notifications so HOME-07/08 see seed alerts
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("pi-finance:notifications-dismissed");
    } catch {
      /* noop */
    }
  });
  await page.goto("/");
  await authenticate(page);
  return guard;
}

// ── HOME-01 ────────────────────────────────────────────────────────────────

test("[HOME-01] profile button navigates to /perfil", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  await page.getByRole("button", { name: "Abrir perfil" }).click();
  await expect(page).toHaveURL(/\/perfil$/);
  await expect(page.getByRole("heading", { name: /perfil|conta/i })).toBeVisible({
    timeout: 10000,
  });
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ── HOME-02 ────────────────────────────────────────────────────────────────

test("[HOME-02] tap notification bell opens notification sheet", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  await page.getByRole("button", { name: "Notificações" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Notificações" })).toBeVisible();
  // Product renamed Pi → Meu Ted; the sheet shows "Alertas do Meu Ted".
  await expect(dialog.getByText("Alertas do Meu Ted")).toBeVisible();
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ── HOME-03 ────────────────────────────────────────────────────────────────

test("[HOME-03] tap quick expense opens expense sheet", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.locator('nav[data-nav="bottom"]').getByRole("button", { name: "Novo lançamento" }).click();
    await page.getByRole("group", { name: "Novo lançamento" }).getByRole("button", { name: "Despesa" }).click();
  } else {
    await page.getByRole("button", { name: "Novo lançamento" }).click();
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await expect(dialog.getByText("Nova despesa")).toBeVisible();
  }
  await expect(dialog.getByRole("button", { name: /^Despesa$/ })).toBeVisible();
  await expect(dialog.getByPlaceholder("0,00")).toBeVisible();

  // Negative: cancel/close is safe
  await dialog.getByRole("button", { name: "Fechar" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ── HOME-04 ────────────────────────────────────────────────────────────────

test("[HOME-04] account card navigates to patrimonio contas", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  await page.getByRole("button", { name: "Abrir Conta Corrente em Contas" }).click();
  await expect(page).toHaveURL(/\/hub\/patrimonio\?aba=contas/);
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ── HOME-05 ────────────────────────────────────────────────────────────────

test("[HOME-05] card card navigates to patrimonio cartoes", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  await page.getByRole("button", { name: "Abrir Nubank em Cartões" }).click();
  await expect(page).toHaveURL(/\/hub\/patrimonio\?aba=cartoes/);
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ── HOME-06 ────────────────────────────────────────────────────────────────

test("[HOME-06] payable card navigates to compromissos", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  // The section is now "Compromissos" and its rows are buttons.
  await page.getByRole("button", { name: /em Contas a pagar/i }).first().click();
  await expect(page).toHaveURL(/\/compromissos\?aba=a-pagar/);
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ── HOME-07 ────────────────────────────────────────────────────────────────

test("[HOME-07] tap notification item navigates to target", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  await page.getByRole("button", { name: "Notificações" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Seed Internet due 2026-07-15 with clock 2026-07-17 → overdue payable alert → compromissos
  const item = dialog.getByTestId("notification-item").first();
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Abrir" }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/compromissos\?aba=a-pagar/);
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ── HOME-08 ────────────────────────────────────────────────────────────────

test("[HOME-08] dismiss notification removes it", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  await page.getByRole("button", { name: "Notificações" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const items = dialog.getByTestId("notification-item");
  const before = await items.count();
  expect(before).toBeGreaterThan(0);

  const firstTitle = await items.first().locator(".text-\\[14px\\]").textContent();
  await items.first().getByRole("button", { name: "Dispensar" }).click();

  // Item removed from list
  await expect(items).toHaveCount(before - 1);
  if (firstTitle) {
    await expect(dialog.getByText(firstTitle, { exact: true })).toHaveCount(0);
  }

  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ── HOME-09 ────────────────────────────────────────────────────────────────

test("[HOME-09] tap quick income opens income sheet", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.locator('nav[data-nav="bottom"]').getByRole("button", { name: "Novo lançamento" }).click();
    await page.getByRole("group", { name: "Novo lançamento" }).getByRole("button", { name: "Receita" }).click();
  } else {
    await page.getByRole("button", { name: "Novo lançamento" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Receita" }).click();
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(
    (page.viewportSize()?.width ?? 0) < 1024 ? "Nova receita" : "Novo lançamento",
  )).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Receita$/ })).toBeVisible();
  await expect(dialog.getByPlaceholder("0,00")).toBeVisible();

  await dialog.getByRole("button", { name: "Fechar" }).click();
  await expect(dialog).toBeHidden();
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ── HOME-10 ────────────────────────────────────────────────────────────────

test("[HOME-10] tap quick transfer opens transfer sheet", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.locator('nav[data-nav="bottom"]').getByRole("button", { name: "Novo lançamento" }).click();
    await page.getByRole("group", { name: "Novo lançamento" }).getByRole("button", { name: "Transferência" }).click();
  } else {
    await page.getByRole("button", { name: "Novo lançamento" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Transferência" }).click();
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(
    (page.viewportSize()?.width ?? 0) < 1024 ? "Nova transferência" : "Novo lançamento",
  )).toBeVisible();
  await expect(dialog.getByText("Origem (saída)")).toBeVisible();
  await expect(dialog.getByText("Destino (entrada)")).toBeVisible();

  await dialog.getByRole("button", { name: "Fechar" }).click();
  await expect(dialog).toBeHidden();
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

test("[HOME-11] home customization order persists after reload by workspace", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);
  await expect(page.getByText(/Saldo total em contas/i)).toBeVisible({ timeout: 90_000 });

  await page.getByRole("button", { name: "Personalizar início" }).click();
  const customizer = page.getByRole("dialog", { name: "Personalizar início" });
  await expect(customizer).toBeVisible();
  const list = customizer.locator('ol[aria-label="Blocos da página inicial"]');
  const readOrder = async () =>
    list.locator("> li > span.min-w-0.flex-1").evaluateAll((nodes) =>
      nodes.map((n) => (n.textContent ?? "").trim()),
    );
  const before = await readOrder();
  expect(before.length, "customizer should list at least 2 blocks").toBeGreaterThan(1);
  const firstTitle = before[0]!;
  await customizer.getByRole("button", { name: `Mover ${firstTitle} para baixo` }).click();
  const expected = [before[1], before[0], ...before.slice(2)];
  await expect.poll(readOrder).toEqual(expected);
  await customizer.getByRole("button", { name: "Fechar" }).click();
  await expect(customizer).toBeHidden();

  await page.reload();
  await expect(page.getByText(/Saldo total em contas/i)).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Personalizar início" }).click();
  const customizerAfter = page.getByRole("dialog", { name: "Personalizar início" });
  await expect(customizerAfter).toBeVisible();
  const listAfter = customizerAfter.locator('ol[aria-label="Blocos da página inicial"]');
  await expect
    .poll(() =>
      listAfter.locator("> li > span.min-w-0.flex-1").evaluateAll((nodes) =>
        nodes.map((n) => (n.textContent ?? "").trim()),
      ),
    )
    .toEqual(expected);
  await customizerAfter.getByRole("button", { name: "Fechar" }).click();

  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
