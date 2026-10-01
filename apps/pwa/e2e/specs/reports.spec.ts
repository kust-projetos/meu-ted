/**
 * Reports E2E — server-driven filters (H-10).
 * Aggregate math belongs to the authoritative API tests; this browser suite
 * verifies the PWA filter controls and the query scope sent to `/analytics/*`.
 */

import { test, expect } from "@playwright/test";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import { prepareSpec, authenticate } from "../support/harness";
import { harnessOrigin } from "../support/ports";

const MOCK_CORS_HEADERS = {
  "Access-Control-Allow-Origin": harnessOrigin(),
  "Access-Control-Allow-Credentials": "true",
};

type AnalyticsRequest = { path: string; params: URLSearchParams };

const EMPTY_PERIOD = { from: "2026-06-18", to: "2026-07-17" };
const ANALYTICS_RESPONSES: Record<string, unknown> = {
  "/analytics/kpis": {
    period: EMPTY_PERIOD,
    previousPeriod: { from: "2026-05-19", to: "2026-06-17" },
    netLiquidBalanceCents: 0,
    accountsTotalCents: 0,
    dueSoonCents: 0,
    openInvoices: { committedCents: 0, limitCents: 0, utilizationPct: null },
    savingsRatePct: null,
    savingsRateTargetPct: 20,
    previousSavingsRatePct: null,
    fixedVsDiscretionary: {
      scope: "household",
      fixedCents: 0,
      discretionaryCents: 0,
      fixedPctOfIncome: null,
      subscriptionsCents: 0,
    },
    incomeCents: 0,
    expenseCents: 0,
    previousIncomeCents: 0,
    previousExpenseCents: 0,
    netWorthCents: 0,
  },
  "/analytics/cashflow-series": { period: EMPTY_PERIOD, current: [], previous: [] },
  "/analytics/category-breakdown": { period: EMPTY_PERIOD, kind: "expense", totalCents: 0, slices: [] },
  "/analytics/budget-consumption": { items: [] },
  "/analytics/daily-heatmap": { endDate: "2026-07-17", weeks: [] },
  "/analytics/net-worth-history": { months: [] },
};

let counter = 0;
function tid(): string {
  counter += 1;
  return `rep-${counter}`;
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

async function init(page: import("@playwright/test").Page, id: string) {
  const guard = await prepareSpec(page, id, {
    baselineAllows: false,
    allow: [{ message: "reading 'waiting'", reason: "SW blocked" }],
  });

  const analyticsRequests: AnalyticsRequest[] = [];
  await page.route("**/analytics/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    analyticsRequests.push({ path: url.pathname, params: url.searchParams });
    const response = ANALYTICS_RESPONSES[url.pathname];
    if (response === undefined) {
      await route.fulfill({ status: 404, headers: MOCK_CORS_HEADERS, body: "Not found" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify(response),
    });
  });

  await page.goto("/hub/relatorios");
  await authenticate(page);
  await expect(page.getByRole("heading", { name: "Relatórios" })).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("reports-analytics-zone")).toBeVisible();
  return { guard, analyticsRequests };
}

const periodButton = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /^Período:/ });

async function choosePeriod(page: import("@playwright/test").Page, label: string): Promise<void> {
  await periodButton(page).click();
  await page.getByRole("dialog", { name: "Escolher período" }).getByRole("button", { name: label }).click();
}

// ── REP-01 ─────────────────────────────────────────────────────────────────

test("[REP-01] period filter selects this year and scopes analytics requests", async ({ page }) => {
  const { guard, analyticsRequests } = await init(page, tid());

  await expect(periodButton(page)).toHaveAccessibleName("Período: Últimos 30 dias");
  await choosePeriod(page, "Este Ano");
  await expect(periodButton(page)).toHaveAccessibleName("Período: Este Ano");
  await expect.poll(() => analyticsRequests.some(
    (request) => request.path === "/analytics/kpis" && request.params.get("period") === "thisYear",
  )).toBe(true);

  assertNoUndeclaredFailures(guard);
});

// ── REP-02 ─────────────────────────────────────────────────────────────────

test("[REP-02] period filter selects the previous month", async ({ page }) => {
  const { guard, analyticsRequests } = await init(page, tid());

  await choosePeriod(page, "Mês Passado");
  await expect(periodButton(page)).toHaveAccessibleName("Período: Mês Passado");
  await expect.poll(() => analyticsRequests.some(
    (request) => request.path === "/analytics/kpis" && request.params.get("period") === "lastMonth",
  )).toBe(true);

  assertNoUndeclaredFailures(guard);
});

// ── REP-03 ─────────────────────────────────────────────────────────────────

test("[REP-03] custom date filter forwards its range to analytics", async ({ page }) => {
  const { guard, analyticsRequests } = await init(page, tid());

  await periodButton(page).click();
  const picker = page.getByRole("dialog", { name: "Escolher período" });
  await picker.getByRole("button", { name: "Personalizado" }).click();
  await picker.getByLabel("Data inicial personalizada").fill("2026-07-01");
  await picker.getByLabel("Data final personalizada").fill("2026-07-17");
  await picker.getByRole("button", { name: "OK" }).click();
  await expect(periodButton(page)).toHaveAccessibleName("Período: 2026-07-01 a 2026-07-17");
  await expect.poll(() => analyticsRequests.some(
    (request) =>
      request.path === "/analytics/kpis" &&
      request.params.get("period") === "custom" &&
      request.params.get("from") === "2026-07-01" &&
      request.params.get("to") === "2026-07-17",
  )).toBe(true);

  assertNoUndeclaredFailures(guard);
});

// ── REP-04 ─────────────────────────────────────────────────────────────────

test("[REP-04] account filter forwards the account scope to analytics", async ({ page }) => {
  const { guard, analyticsRequests } = await init(page, tid());

  await page.getByRole("button", { name: "Conta: Todas" }).click();
  await page.getByRole("dialog", { name: "Escolher conta" }).getByRole("button", { name: "Conta Corrente" }).click();
  await expect(page.getByRole("button", { name: "Conta: Conta Corrente" })).toBeVisible();
  await expect.poll(() => analyticsRequests.some(
    (request) => request.path === "/analytics/kpis" && request.params.get("accountId") === "acc-1",
  )).toBe(true);

  assertNoUndeclaredFailures(guard);
});
