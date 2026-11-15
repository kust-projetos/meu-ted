/**
 * Viewport-agnostic "new transaction" opener for E2E specs.
 *
 * Mobile (functional-mobile, 390px): the BottomNav FAB ("Novo lançamento")
 * opens a `group` "Novo lançamento" with plain BUTTONS (Despesa, Receita,
 * Transferência, Ler Comprovante). Desktop (functional-desktop, 1440px):
 * the BottomNav is `lg:hidden` and the SidebarRail CTA ("Novo lançamento",
 * `hidden lg:flex`) opens the sheet directly in "new" mode with in-sheet
 * tabs (Despesa / Receita / Transferência).
 *
 * `openNewTransaction(page, kind)` clicks the correct entry point for the
 * current viewport and selects the requested kind, returning the sheet
 * dialog. No force clicks, no viewport skips.
 */

import { expect, type Locator, type Page } from "@playwright/test";

export type NewTransactionKind = "expense" | "income" | "transfer";

const KIND_LABEL: Record<NewTransactionKind, string> = {
  expense: "Despesa",
  income: "Receita",
  transfer: "Transferência",
};

/** Desktop shell shows the SidebarRail CTA at `lg` (1024px+). */
export function isDesktopViewport(page: Page): boolean {
  const size = page.viewportSize();
  if (size) return size.width >= 1024;
  return false;
}

/**
 * The SidebarRail CTA. Scoped to the rail (`complementary`) because some
 * pages (e.g. /registros) render their own "Novo lançamento" button in the
 * main content — an unscoped lookup trips strict mode there.
 */
function desktopCta(page: Page): Locator {
  return page
    .getByRole("complementary")
    .getByRole("button", { name: "Novo lançamento" });
}

async function isDesktopCtaVisible(page: Page): Promise<boolean> {
  if (await desktopCta(page).isVisible().catch(() => false)) return true;
  // Fallback for shells without the rail landmark: only resolves when the
  // generic lookup is unambiguous (strict violations count as not visible).
  try {
    return await page
      .getByRole("button", { name: "Novo lançamento", exact: true })
      .isVisible();
  } catch {
    return false;
  }
}

export async function openNewTransaction(
  page: Page,
  kind: NewTransactionKind = "expense",
): Promise<Locator> {
  const label = KIND_LABEL[kind];
  const desktop = (await isDesktopCtaVisible(page)) || isDesktopViewport(page);

  if (desktop) {
    const cta = (await desktopCta(page).isVisible().catch(() => false))
      ? desktopCta(page)
      : page.getByRole("button", { name: "Novo lançamento", exact: true });
    await cta.first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // "new" mode hosts the kind as an in-sheet tab. The draft is empty at
    // open, so (re-)selecting the tab is a harmless no-op for the default
    // expense kind and the required switch for income/transfer.
    const tab = dialog.getByRole("button", { name: label, exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    if (kind === "transfer") {
      await expect(
        dialog.getByRole("button", { name: /^Transferir$/ }),
      ).toBeVisible();
    } else {
      await expect(dialog.getByPlaceholder("0,00")).toBeVisible();
    }
    return dialog;
  }

  await page.locator('nav[data-nav="bottom"]').getByRole("button", { name: "Novo lançamento" }).click();
  const group = page.getByLabel("Novo lançamento");
  await expect(group).toBeVisible();
  await group.getByRole("button", { name: label }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}
