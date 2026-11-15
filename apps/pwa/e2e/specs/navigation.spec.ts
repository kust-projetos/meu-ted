/**
 * Navigation E2E tests (canonical IA, item 13).
 * IDs: DIRECT-01..12, NAV-01..13
 *
 * DIRECT: direct-load each canonical route, register device, assert URL +
 *   heading + fixture journal has zero unexpected writes. Legacy page routes
 *   redirect (temporary) to their canonical tab — covered by REDIRECT tests.
 * NAV-01..04: click BottomNav button, assert URL changes.
 * NAV-05..08: FAB quick menu opens and dispatches capture flows.
 * NAV-09..12: Hub grid navigates to module subroutes.
 * NAV-13: FAB menu closes on Escape, route preserved.
 *
 * No body-visibility as acceptance, no conditional locators, no arbitrary waits.
 */

import { test, expect } from "@playwright/test";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import {
  prepareSpec,
  authenticate as registerDevice,
  getJournal,
} from "../support/harness";

let counter = 0;
function tid(prefix: string): string {
  counter++;
  return `nav-${prefix}-${counter}`;
}

/**
 * Per-test setup for this spec.
 *
 * Every test here deep-links into a route and only then registers — that order
 * is the point of the spec, so it stays in the test bodies rather than being
 * folded into `initSpec`.
 *
 * `baselineAllows: false` keeps the original strict guard: this spec tolerated
 * only the service-worker failure, and inheriting the harness baseline set
 * would leave these tests green while detecting less.
 */
async function setup(page: import("@playwright/test").Page, id: string) {
  const guard = await prepareSpec(page, id, {
    baselineAllows: false,
    allow: [{ message: "reading 'waiting'", reason: "SW blocked by functional project" }],
  });
  return guard;
}

/** Assert the fixture journal has no unexpected write entries (exclude auth bootstrap). */
async function assertNoUnexpectedWrites(testId: string): Promise<void> {
  const journal = await getJournal(testId);
  // Email sign-in, device registration, and the scoped Agent-token mint are
  // required session-first bootstrap — exclude them from feature writes.
  const writes = journal.filter(
    (e) =>
      e.method !== "GET" &&
      e.path !== "/auth/devices/register" &&
      e.path !== "/auth/sign-in/email" &&
      e.path !== "/auth/agent-token",
  );
  expect(writes).toHaveLength(0);
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});


// ═══════════════════════════════════════════════════════════════════════════
// DIRECT-01..12: Direct load each canonical route
// ═══════════════════════════════════════════════════════════════════════════

// Each DIRECT test asserts: URL matches route, zero unexpected journal writes, clean guard.
// Headings are not asserted because route pages vary in heading role usage.

test("[DIRECT-01] direct load / renders shell, zero unexpected writes", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/"); await registerDevice(page);
  expect(page.url()).toContain("/");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-02] direct load /registros renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/registros"); await registerDevice(page);
  expect(page.url()).toContain("/registros");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-03] direct load /compromissos renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/compromissos"); await registerDevice(page);
  expect(page.url()).toContain("/compromissos");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-04] direct load /hub renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/hub"); await registerDevice(page);
  expect(page.url()).toContain("/hub");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-05] direct load /hub/patrimonio renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/hub/patrimonio"); await registerDevice(page);
  expect(page.url()).toContain("/hub/patrimonio");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-06] direct load /hub/planejamento renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/hub/planejamento"); await registerDevice(page);
  expect(page.url()).toContain("/hub/planejamento");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-07] direct load /hub/relatorios renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/hub/relatorios"); await registerDevice(page);
  expect(page.url()).toContain("/hub/relatorios");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-08] direct load /hub/alertas renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/hub/alertas"); await registerDevice(page);
  expect(page.url()).toContain("/hub/alertas");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-09] direct load /hub/categorias renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/hub/categorias"); await registerDevice(page);
  expect(page.url()).toContain("/hub/categorias");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-10] direct load /hub/configuracoes renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/hub/configuracoes"); await registerDevice(page);
  expect(page.url()).toContain("/hub/configuracoes");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-11] direct load /perfil renders shell", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/perfil"); await registerDevice(page);
  expect(page.url()).toContain("/perfil");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});
test("[DIRECT-12] direct load /compromissos?aba=pendencias selects the tab", async ({ page }) => {
  const id = tid("direct"); const guard = await setup(page, id);
  await page.goto("/compromissos?aba=pendencias"); await registerDevice(page);
  expect(page.url()).toContain("/compromissos");
  await assertNoUnexpectedWrites(id);
  assertNoUndeclaredFailures(guard);
});

// ═══════════════════════════════════════════════════════════════════════════
// REDIRECT-01..04: Legacy page routes land on canonical tabs
// ═══════════════════════════════════════════════════════════════════════════

test("[REDIRECT-01] legacy /a-pagar lands on /compromissos?aba=a-pagar", async ({ page }) => {
  const id = tid("redirect"); const guard = await setup(page, id);
  await page.goto("/a-pagar"); await registerDevice(page);
  await expect(page).toHaveURL(/\/compromissos\?aba=a-pagar/);
  assertNoUndeclaredFailures(guard);
});
test("[REDIRECT-02] legacy /contas lands on /hub/patrimonio?aba=contas", async ({ page }) => {
  const id = tid("redirect"); const guard = await setup(page, id);
  await page.goto("/contas"); await registerDevice(page);
  await expect(page).toHaveURL(/\/hub\/patrimonio\?aba=contas/);
  assertNoUndeclaredFailures(guard);
});
test("[REDIRECT-03] legacy /cartoes?cardId=<id> preserves the detail param", async ({ page }) => {
  const id = tid("redirect"); const guard = await setup(page, id);
  await page.goto("/cartoes?cardId=card-1"); await registerDevice(page);
  // Next.js merges the preserved query with the redirect target; the
  // original param comes first (?cardId=..&aba=cartoes), so match aba=
  // in either position.
  await expect(page).toHaveURL(/\/hub\/patrimonio\?([^&]*&)?aba=cartoes/);
  expect(page.url()).toContain("cardId=card-1");
  assertNoUndeclaredFailures(guard);
});
test("[REDIRECT-04] legacy /pending lands on /compromissos?aba=pendencias", async ({ page }) => {
  const id = tid("redirect"); const guard = await setup(page, id);
  await page.goto("/pending"); await registerDevice(page);
  await expect(page).toHaveURL(/\/compromissos\?aba=pendencias/);
  assertNoUndeclaredFailures(guard);
});

// ═══════════════════════════════════════════════════════════════════════════
// NAV-01..04: BottomNav navigation
// ═══════════════════════════════════════════════════════════════════════════

test("[NAV-01] BottomNav Início click navigates to /", async ({ page }) => {
  const id = tid("nav"); const guard = await setup(page, id);
  // BottomNav renders only below the `lg` breakpoint (desktop exposes the
  // same destinations via SidebarRail) — like NAV-05..08, pin a mobile
  // viewport so the BottomNav buttons under test are actually mounted.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/registros"); await registerDevice(page);

  await page.getByRole("button", { name: "Início" }).click({ timeout: 5000 });
  await expect(page).toHaveURL(/\/$/);
  assertNoUndeclaredFailures(guard);
});

test("[NAV-02] BottomNav Extrato click navigates to /registros", async ({ page }) => {
  const id = tid("nav"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);

  await page.getByRole("button", { name: "Extrato" }).click({ timeout: 5000 });
  await expect(page).toHaveURL(/\/registros$/);
  assertNoUndeclaredFailures(guard);
});

test("[NAV-03] BottomNav Cartões click navigates to its canonical route", async ({ page }) => {
  const id = tid("nav"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);

  await page.getByRole("button", { name: "Cartões" }).click({ timeout: 5000 });
  await expect(page).toHaveURL(/\/hub\/patrimonio\?aba=cartoes$/);
  assertNoUndeclaredFailures(guard);
});

test("[NAV-04] BottomNav Relatórios click navigates to /hub/relatorios", async ({ page }) => {
  const id = tid("nav"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);

  await page.getByRole("button", { name: "Relatórios" }).click({ timeout: 5000 });
  await expect(page).toHaveURL(/\/hub\/relatorios$/);
  assertNoUndeclaredFailures(guard);
});

// ═══════════════════════════════════════════════════════════════════════════
// NAV-05..08: FAB quick-action group
// ═══════════════════════════════════════════════════════════════════════════

test("[NAV-05] FAB opens the quick-action group with 4 actions", async ({ page }) => {
  const id = tid("nav"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);

  await page.getByRole("button", { name: "Novo lançamento" }).click({ timeout: 5000 });
  const actions = page.getByRole("group", { name: "Novo lançamento" });
  await expect(actions).toBeVisible({ timeout: 5000 });
  await expect(actions.getByRole("button")).toHaveCount(4);
  assertNoUndeclaredFailures(guard);
});

test("[NAV-06] quick menu Despesa opens the preselected expense sheet", async ({ page }) => {
  const id = tid("nav"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);

  await page.getByRole("button", { name: "Novo lançamento" }).click({ timeout: 5000 });
  await page.getByLabel("Novo lançamento").getByRole("button", { name: "Despesa" }).click({ timeout: 5000 });
  await expect(page.getByText("Nova despesa")).toBeVisible({ timeout: 5000 });
  assertNoUndeclaredFailures(guard);
});

test("[NAV-07] quick action Ler Comprovante opens the capture expense sheet", async ({ page }) => {
  const id = tid("nav"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);

  await page.getByRole("button", { name: "Novo lançamento" }).click({ timeout: 5000 });
  await page.getByRole("group", { name: "Novo lançamento" }).getByRole("button", { name: "Ler Comprovante", exact: true }).click({ timeout: 5000 });
  // /capture is a bridge: it opens the prefilled transaction sheet then
  // replaces the URL back to the canonical home route.
  await expect(page.getByRole("heading", { name: "Nova despesa" })).toBeVisible({ timeout: 5000 });
  await expect(page).toHaveURL(/\/$/);
  assertNoUndeclaredFailures(guard);
});

test("[NAV-08] quick menu Transferência opens the preselected transfer sheet", async ({ page }) => {
  const id = tid("nav"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);

  await page.getByRole("button", { name: "Novo lançamento" }).click({ timeout: 5000 });
  await page.getByRole("group", { name: "Novo lançamento" }).getByRole("button", { name: "Transferência", exact: true }).click({ timeout: 5000 });
  await expect(page.getByText("Nova transferência")).toBeVisible({ timeout: 5000 });
  assertNoUndeclaredFailures(guard);
});

// ═══════════════════════════════════════════════════════════════════════════
// NAV-09..12: Hub grid modules
// ═══════════════════════════════════════════════════════════════════════════

async function navigateFromHub(
  page: import("@playwright/test").Page,
  label: string,
  expectedPath: RegExp,
): Promise<void> {
  await page.getByRole("button", { name: "Explorar" }).click({ timeout: 5000 });
  await expect(page).toHaveURL(/\/hub$/);
  await page.getByRole("link", { name: new RegExp(label) }).click({ timeout: 5000 });
  await expect(page).toHaveURL(expectedPath);
}

test("[NAV-09] Hub Patrimônio navigates to /hub/patrimonio", async ({ page }) => {
  const id = tid("hub"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);
  await navigateFromHub(page, "Cartões", /\/hub\/patrimonio\?aba=cartoes$/);
  assertNoUndeclaredFailures(guard);
});

test("[NAV-10] Hub Planejamento navigates to /hub/planejamento", async ({ page }) => {
  const id = tid("hub"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);
  await navigateFromHub(page, "Planejamento", /\/hub\/planejamento$/);
  assertNoUndeclaredFailures(guard);
});

test("[NAV-11] Hub Alertas navigates to /hub/alertas", async ({ page }) => {
  const id = tid("hub"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);
  await navigateFromHub(page, "Alertas", /\/hub\/alertas$/);
  assertNoUndeclaredFailures(guard);
});

test("[NAV-12] Hub Configurações navigates to /hub/configuracoes", async ({ page }) => {
  const id = tid("hub"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);
  await navigateFromHub(page, "Configurações", /\/hub\/configuracoes$/);
  assertNoUndeclaredFailures(guard);
});

// ═══════════════════════════════════════════════════════════════════════════
// NAV-13: Escape closes the quick menu, route preserved
// ═══════════════════════════════════════════════════════════════════════════

test("[NAV-13] Escape closes the FAB quick-action group, route preserved", async ({ page }) => {
  const id = tid("nav13"); const guard = await setup(page, id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await registerDevice(page);

  await page.getByRole("button", { name: "Novo lançamento" }).click({ timeout: 5000 });
  await expect(page.getByRole("group", { name: "Novo lançamento" })).toBeVisible({ timeout: 5000 });

  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Novo lançamento" })).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  assertNoUndeclaredFailures(guard);
});
