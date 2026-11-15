/**
 * Transfer record E2E — TRF-01..02
 *
 * Canonical flow: transfer between own accounts via the FAB quick menu and
 * verify the recorded entry (journal body carries description, amount,
 * origin, destination, date).
 *
 * Real UI (NewTransactionSheet.tsx, transfer mode):
 *   - FAB "Novo lançamento" → menuitem "Transferência"
 *     → dialog "Nova transferência" (NAV-08 proves this entry point).
 *   - Amount (placeholder "0,00"), description
 *     (placeholder "Ex: Aluguel, mercado..."), origin chips [0] /
 *     destination chips [1] ("Conta Corrente", "Dinheiro"), CTA "Transferir".
 *   - handleSave rejects missing/same origin-destination without POST;
 *     happy path → POST /transfers.
 * Seed (populated): acc-1 "Conta Corrente", acc-2 "Dinheiro".
 *
 * NOTE (terceiros): the product has no external-recipient concept —
 * transfers move funds between the workspace's own accounts only
 * (fromAccountId/toAccountId). There is no "transfer to third party" flow
 * to cover; these specs pin the canonical flow that exists.
 */

import { test, expect } from "@playwright/test";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import { initSpec, getJournal, expectJournal } from "../support/harness";
import { openNewTransaction } from "../support/new-transaction";

let counter = 0;
function tid(): string {
  counter += 1;
  return `trfrec-${counter}`;
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

async function init(page: import("@playwright/test").Page, id: string) {
  const guard = await initSpec(page, id);
  return guard;
}

/**
 * Canonical entry: quick menu / CTA → Transferência.
 * Mobile opens the preselected "Nova transferência" sheet via the FAB
 * group BUTTON (the FAB menu is a `group`, not an ARIA menu); desktop
 * opens the sheet via the SidebarRail CTA and selects the in-sheet
 * Transferência tab. Both converge on the transfer form (Transferir CTA).
 */
async function openTransferSheet(page: import("@playwright/test").Page) {
  const dialog = await openNewTransaction(page, "transfer");
  await expect(
    dialog.getByRole("button", { name: /^Transferir$/ }),
  ).toBeVisible();
  return dialog;
}

async function typeAmount(
  dialog: import("@playwright/test").Locator,
  digits: string,
) {
  const input = dialog.getByPlaceholder("0,00");
  await input.click();
  await input.fill("");
  await input.pressSequentially(digits, { delay: 15 });
}

/** Fill a R$ 250,00 "Reserva mensal" transfer acc-1 → acc-2 and confirm. */
async function createTransfer(
  page: import("@playwright/test").Page,
  dialog: import("@playwright/test").Locator,
) {
  await typeAmount(dialog, "25000");
  await dialog.getByPlaceholder("Ex: Aluguel, mercado...").fill("Reserva mensal");
  await dialog.getByRole("button", { name: /Conta Corrente/ }).nth(0).click();
  await dialog.getByRole("button", { name: /Dinheiro/ }).nth(1).click();
  await dialog.getByRole("button", { name: /^Transferir$/ }).click();
  await expect(dialog).toBeHidden();
}

// ── TRF-01 ──────────────────────────────────────────────────────────────────

test("[TRF-01] transfer via quick menu → POST /transfers", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  const dialog = await openTransferSheet(page);
  await createTransfer(page, dialog);

  await expectJournal(id, "POST", "/transfers", 200);
  assertNoUndeclaredFailures(guard);
});

// ── TRF-02 ──────────────────────────────────────────────────────────────────

test("[TRF-02] recorded transfer carries description, amount, origin and destination", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  const dialog = await openTransferSheet(page);
  await createTransfer(page, dialog);
  await expectJournal(id, "POST", "/transfers", 200);

  await expect
    .poll(async () => {
      const entries = await getJournal(id);
      return (
        entries.find((e) => e.method === "POST" && e.path === "/transfers")?.body as Record<string, unknown> | undefined
      );
    })
    .toMatchObject({
      description: "Reserva mensal",
      amountCents: 25000,
      fromAccountId: "acc-1",
      toAccountId: "acc-2",
    });

  assertNoUndeclaredFailures(guard);
});
