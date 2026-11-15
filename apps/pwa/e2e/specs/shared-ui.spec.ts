/**
 * Shared UI E2E tests — UI-01..08
 *
 * Dirty-form confirm (transaction sheet / profile edit):
 * UI-01 back from dirty form → confirm prompt
 * UI-02 close dirty form → confirm prompt
 * UI-03 confirm discard → leaves form
 * UI-04 cancel discard → stays on form
 *
 * Banners on /registros:
 * UI-05 stale(unavailable) retry → journal GET retry
 * UI-06 stale(snapshot) dismiss → banner hidden, no extra retry write
 * UI-07 write-error retry → journal activity
 * UI-08 write-error dismiss → banner hidden
 */

import { test, expect } from "@playwright/test";
// `allowFailure` stays: UI-07/UI-08 declare tolerated failures inline.
import { allowFailure, assertNoUndeclaredFailures } from "../support/failure-guard";
import { FIXTURE_URL } from "../support/reset";
import { prepareSpec, authenticate, getJournal } from "../support/harness";
import { openNewTransaction } from "../support/new-transaction";

let counter = 0;
function tid(): string {
  counter += 1;
  return `ui-${counter}`;
}


test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});


async function setScenario(
  testId: string,
  scenario: {
    method: string;
    pathname: string;
    status?: number;
    once?: boolean;
  },
): Promise<void> {
  const res = await fetch(`${FIXTURE_URL}/__e2e/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-e2e-test-id": testId },
    body: JSON.stringify({ testId, ...scenario }),
  });
  if (!res.ok) throw new Error(`Scenario failed: ${res.status}`);
}



const SW_ONLY = [{ message: "reading 'waiting'", reason: "SW blocked" }] as const;

async function init(
  page: import("@playwright/test").Page,
  id: string,
  path = "/",
) {
  const guard = await prepareSpec(page, id, {
    baselineAllows: false,
    allow: SW_ONLY,
  });
  await page.goto(path);
  await authenticate(page);
  return guard;
}

async function dirtifyTxSheet(page: import("@playwright/test").Page) {
  const dialog = await openNewTransaction(page, "expense");
  const amount = dialog.getByPlaceholder("0,00");
  await amount.click();
  await amount.pressSequentially("1234", { delay: 15 });
  await expect(amount).not.toHaveValue("");
  return dialog;
}

function discardDialog(page: import("@playwright/test").Page) {
  // Confirm sits above the sheet (z-30); title is unique.
  return page.getByRole("dialog").filter({ hasText: "Descartar alterações?" });
}

// ── UI-01 ──────────────────────────────────────────────────────────────────

test("[UI-01] back from dirty form shows confirm prompt", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id, "/perfil");

  await page.getByRole("button", { name: "Editar perfil" }).click();
  const edit = page.getByRole("dialog").filter({ hasText: "Editar perfil" });
  await expect(edit).toBeVisible();

  const nameInput = edit.getByRole("textbox").first();
  await nameInput.click();
  await nameInput.pressSequentially(" X", { delay: 20 });
  await expect(nameInput).toHaveValue(/X$/);

  // Back (Voltar) while dirty
  await edit.getByRole("button", { name: "Voltar" }).click();
  const confirm = discardDialog(page);
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Descartar" })).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Continuar editando" })).toBeVisible();
  // Form still open underneath
  await expect(edit.getByRole("heading", { name: "Editar perfil" })).toBeVisible();
  assertNoUndeclaredFailures(guard);
});

// ── UI-02 ──────────────────────────────────────────────────────────────────

test("[UI-02] close dirty form shows confirm prompt", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  const sheet = await dirtifyTxSheet(page);
  await sheet.getByRole("button", { name: "Fechar" }).click();

  const confirm = discardDialog(page);
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(/alterações não salvas/i)).toBeVisible();
  // Sheet still open underneath. The sheet title is viewport-dependent
  // ("Nova despesa" preselected on mobile, "Novo lançamento" on desktop),
  // so pin the expense form itself instead of the title.
  await expect(sheet.getByPlaceholder("0,00")).toBeVisible();
  assertNoUndeclaredFailures(guard);
});

// ── UI-03 ──────────────────────────────────────────────────────────────────

test("[UI-03] confirm discard on dirty form → navigates away", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  await dirtifyTxSheet(page);
  await page.getByRole("button", { name: "Fechar" }).click();
  const confirm = discardDialog(page);
  await expect(confirm).toBeVisible();

  await confirm.getByRole("button", { name: "Descartar" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("dialog").filter({ hasText: "Novo lançamento" })).toHaveCount(0);
  // Shell signal is viewport-dependent (FAB mobile / CTA desktop).
  const ui03Fab = page.locator('nav[data-nav="bottom"]').getByRole("button", { name: "Novo lançamento" });
  const ui03Cta = page.getByRole("button", { name: "Novo lançamento" });
  await expect
    .poll(
      async () =>
        (await ui03Fab.isVisible().catch(() => false)) ||
        (await ui03Cta.isVisible().catch(() => false)),
    )
    .toBe(true);
  assertNoUndeclaredFailures(guard);
});

// ── UI-04 ──────────────────────────────────────────────────────────────────

test("[UI-04] cancel discard on dirty form → stays on form", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  const sheet = await dirtifyTxSheet(page);
  const amountBefore = await sheet.getByPlaceholder("0,00").inputValue();
  await sheet.getByRole("button", { name: "Fechar" }).click();

  const confirm = discardDialog(page);
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Continuar editando" }).click();

  await expect(confirm).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByPlaceholder("0,00")).toHaveValue(amountBefore);
  assertNoUndeclaredFailures(guard);
});

// ── UI-05 ──────────────────────────────────────────────────────────────────

test("[UI-05] stale error retry button → retry journal", async ({ page }) => {
  const id = tid();
  const guard = await prepareSpec(page, id, {
    baselineAllows: false,
    allow: [
      ...SW_ONLY,
      { status: 503, reason: "forced unavailable bootstrap" },
      { message: "503", reason: "forced unavailable bootstrap" },
    ],
  });

  // Fail essential list reads so domains become unavailable (no prior snapshot).
  for (const pathname of ["/transactions", "/accounts", "/categories"]) {
    await setScenario(id, { method: "GET", pathname, status: 503, once: false });
  }

  await page.goto("/registros");
  await authenticate(page);

  const banner = page.getByTestId("stale-banner");
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toHaveAttribute("data-variant", "unavailable");
  await expect(banner.getByRole("button", { name: "Tentar novamente" })).toBeVisible();

  const before = (await getJournal(id)).filter((e) => e.method === "GET").length;
  await Promise.all([
    page.waitForLoadState("networkidle"),
    banner.getByRole("button", { name: "Tentar novamente" }).click(),
  ]);
  // Reload re-runs bootstrap → more GET journal entries
  await expect
    .poll(async () => (await getJournal(id)).filter((e) => e.method === "GET").length, {
      timeout: 15000,
    })
    .toBeGreaterThan(before);
  assertNoUndeclaredFailures(guard);
});

// ── UI-06 ──────────────────────────────────────────────────────────────────

test("[UI-06] stale error dismiss button → no retry", async ({ page }) => {
  const id = tid();
  const guard = await prepareSpec(page, id, {
    baselineAllows: false,
    allow: [
      ...SW_ONLY,
      { status: 503, reason: "forced unavailable for dismiss" },
      { message: "503", reason: "forced unavailable for dismiss" },
    ],
  });

  for (const pathname of ["/transactions", "/accounts", "/categories"]) {
    await setScenario(id, { method: "GET", pathname, status: 503, once: false });
  }

  await page.goto("/registros");
  await authenticate(page);

  const banner = page.getByTestId("stale-banner");
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toHaveAttribute("data-variant", "unavailable");
  const dismiss = banner.getByRole("button", { name: "Dispensar aviso" });
  await expect(dismiss).toBeVisible();

  // Count only the poisoned resource GETs — bootstrap GETs (dashboard/summary,
  // insights/quick, profile, auth) are legitimate background telemetry and may
  // land at any time; dismiss must not trigger retries of the 503 resources.
  const resourceGets = (j: Awaited<ReturnType<typeof getJournal>>) =>
    j.filter((e) => e.method === "GET" && ["/transactions", "/accounts", "/categories"].some((p) => (e.path ?? "").includes(p))).length;
  const getsBefore = resourceGets(await getJournal(id));
  await dismiss.click();
  await expect(banner).toHaveCount(0);

  // Dismiss must not trigger retry GETs
  const getsAfter = resourceGets(await getJournal(id));
  expect(getsAfter).toBe(getsBefore);
  assertNoUndeclaredFailures(guard);
});

// ── UI-07 ──────────────────────────────────────────────────────────────────

test("[UI-07] write-error retry button → retry journal", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);
  allowFailure(guard, { status: 500, reason: "forced write error" });
  allowFailure(guard, { message: "500", reason: "forced write error" });
  await setScenario(id, {
    method: "POST",
    pathname: "/transactions/expense",
    status: 500,
    once: false,
  });

  const sheet = await openNewTransaction(page, "expense");
  const amount = sheet.getByPlaceholder("0,00");
  await amount.click();
  await amount.pressSequentially("5000", { delay: 10 });
  await sheet.getByPlaceholder("Ex: Aluguel, mercado...").fill("Falha E2E");
  // Salvar enables only with category + origin picked via their picker
  // sheets (same as TX-02 — the bare "Conta Corrente" chip on the main
  // sheet only opens the picker instead of selecting).
  await sheet.getByRole("button", { name: "Selecionar categoria" }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Alimentação" }).click();
  await sheet.getByRole("button", { name: "Selecionar conta ou cartão" }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: /Conta Corrente/ }).click();
  await sheet.getByRole("button", { name: /^Salvar$/ }).click();

  // Failed write keeps sheet open + dirty; discard to reach page chrome
  await sheet.getByRole("button", { name: "Fechar" }).click();
  const confirmClose = discardDialog(page);
  await expect(confirmClose).toBeVisible();
  await confirmClose.getByRole("button", { name: "Descartar" }).click();

  // BottomNav label is "Extrato" (navigates to /registros).
  // Desktop hides the BottomNav: the SidebarRail exposes the same
  // destination as a link.
  const extratoMobile = page.getByRole("button", { name: "Extrato" });
  if (await extratoMobile.isVisible().catch(() => false)) {
    await extratoMobile.click();
  } else {
    await page.getByRole("link", { name: "Extrato" }).click();
  }
  await expect(page).toHaveURL(/\/registros/);

  const banner = page.getByTestId("write-error-banner");
  await expect(banner).toBeVisible({ timeout: 10000 });
  const retry = banner.getByRole("button", { name: "Tentar de novo" });
  await expect(retry).toBeVisible();

  // "Tentar de novo" replays the failed mutation with the SAME commandId
  // (retryWriteError → same Idempotency-Key header), so the journal must
  // gain a NEW POST /transactions/expense carrying the same key — not a GET.
  const expensePosts = (j: Awaited<ReturnType<typeof getJournal>>) =>
    j.filter((e) => e.method === "POST" && e.path === "/transactions/expense");
  const before = expensePosts(await getJournal(id));
  expect(before.length).toBeGreaterThanOrEqual(1);
  const firstKey = before[0]?.idempotencyKey;
  expect(typeof firstKey).toBe("string");
  expect((firstKey as string).length).toBeGreaterThan(0);

  await retry.click();
  await expect
    .poll(async () => expensePosts(await getJournal(id)).length, {
      timeout: 15000,
    })
    .toBeGreaterThan(before.length);
  const after = expensePosts(await getJournal(id));
  expect(after.length).toBeGreaterThan(before.length);
  for (const entry of after) {
    expect(entry.idempotencyKey).toBe(firstKey);
  }
  assertNoUndeclaredFailures(guard);
});

// ── UI-08 ──────────────────────────────────────────────────────────────────

test("[UI-08] write-error dismiss button → no retry", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);
  allowFailure(guard, { status: 500, reason: "forced write error" });
  allowFailure(guard, { message: "500", reason: "forced write error" });
  await setScenario(id, {
    method: "POST",
    pathname: "/transactions/expense",
    status: 500,
    once: false,
  });

  const sheet = await openNewTransaction(page, "expense");
  const amount = sheet.getByPlaceholder("0,00");
  await amount.click();
  await amount.pressSequentially("5000", { delay: 10 });
  await sheet.getByPlaceholder("Ex: Aluguel, mercado...").fill("Falha dismiss");
  // Salvar enables only with category + origin picked via their picker
  // sheets (same as TX-02 — the bare "Conta Corrente" chip on the main
  // sheet only opens the picker instead of selecting).
  await sheet.getByRole("button", { name: "Selecionar categoria" }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Alimentação" }).click();
  await sheet.getByRole("button", { name: "Selecionar conta ou cartão" }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: /Conta Corrente/ }).click();
  await sheet.getByRole("button", { name: /^Salvar$/ }).click();

  await sheet.getByRole("button", { name: "Fechar" }).click();
  const confirmClose = discardDialog(page);
  await expect(confirmClose).toBeVisible();
  await confirmClose.getByRole("button", { name: "Descartar" }).click();

  // BottomNav label is "Extrato" (navigates to /registros); desktop uses
  // the SidebarRail link with the same name.
  const extratoMobileDismiss = page.getByRole("button", { name: "Extrato" });
  if (await extratoMobileDismiss.isVisible().catch(() => false)) {
    await extratoMobileDismiss.click();
  } else {
    await page.getByRole("link", { name: "Extrato" }).click();
  }
  await expect(page).toHaveURL(/\/registros/);
  // Authenticated shell signal is viewport-dependent (FAB on mobile,
  // SidebarRail CTA on desktop) — reuse the harness probe shape.
  const shellFab = page.locator('nav[data-nav="bottom"]').getByRole("button", { name: "Novo lançamento" });
  const shellCta = page.getByRole("button", { name: "Novo lançamento" });
  await expect
    .poll(
      async () =>
        (await shellFab.isVisible().catch(() => false)) ||
        (await shellCta.isVisible().catch(() => false)),
      { timeout: 10000 },
    )
    .toBe(true);

  const banner = page.getByTestId("write-error-banner");
  await expect(banner).toBeVisible({ timeout: 10000 });
  const getsBefore = (await getJournal(id)).filter((e) => e.method === "GET").length;

  await banner.getByRole("button", { name: "Fechar" }).click();
  await expect(banner).toHaveCount(0);

  const getsAfter = (await getJournal(id)).filter((e) => e.method === "GET").length;
  expect(getsAfter).toBe(getsBefore);
  assertNoUndeclaredFailures(guard);
});
