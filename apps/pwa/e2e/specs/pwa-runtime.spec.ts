/**
 * PWA runtime E2E — PWA-01..06
 *
 * Harness origin http://127.0.0.1:3000 → Next :3001; switchable /sw.js.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { applyCspRewrite, resetFixture, authenticate } from "../support/harness";
import { harnessOrigin } from "../support/ports";

const FIXED_CLOCK = "2026-07-17T12:00:00.000Z";
// Page origin of the SW harness (opt-in E2E_HARNESS_PORT, default :3000).
const HARNESS_ORIGIN = harnessOrigin();


test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});


async function deploySw(
  context: BrowserContext,
  version: "legacy" | "current",
): Promise<void> {
  const res = await context.request.post(`${HARNESS_ORIGIN}/__e2e/sw/deploy`, {
    data: { version },
  });
  expect(res.ok()).toBeTruthy();
}

async function waitForController(page: Page, timeout = 25000) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout,
  });
}

async function forceUpdate(page: Page) {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  });
}

async function registerAndHome(page: Page, testId: string) {
  await applyCspRewrite(page);
  await resetFixture(testId);
  await page.clock.setFixedTime(FIXED_CLOCK);
  await page.context().setExtraHTTPHeaders({ "x-e2e-test-id": testId });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // 20s: SW activation makes this slower than the harness default.
  await authenticate(page, { timeout: 20000 });
}

async function dirtifyExpenseSheet(page: Page) {
  await page.getByLabel("Nova transação").click();
  // The FAB opens the quick-action group first (NAV-05..08 pattern) — pick
  // Despesa to open the preselected expense sheet (dialog).
  await page.getByLabel("Novo lançamento").getByRole("button", { name: "Despesa" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const amount = dialog.getByPlaceholder("0,00");
  await amount.click();
  await amount.pressSequentially("4242", { delay: 15 });
  await expect(amount).not.toHaveValue("");
}

// ── PWA-01 ─────────────────────────────────────────────────────────────────

test("[PWA-01] install SW → offline shell renders on network failure", async ({
  page,
  context,
}) => {
  const id = "pwa-01";
  await deploySw(context, "current");
  await registerAndHome(page, id);
  await waitForController(page);

  // Readiness gate (not a timeout bump): the offline fallback the SW itself
  // serves must be precached before the network is cut. On a cold boot the
  // first offline navigation otherwise races precache completion and the
  // browser — not the SW — fails the navigation (chrome-error page).
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const hit = await caches.match("/offline-shell.html", {
            ignoreSearch: true,
          });
          return hit !== undefined && hit !== null;
        }),
      { timeout: 25000 },
    )
    .toBe(true);

  await context.setOffline(true);
  await page.goto("/registros", { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await expect
    .poll(async () => page.title(), { timeout: 15000 })
    .toMatch(/Offline|Pi Financeiro/i);
  await context.setOffline(false);
});

// ── PWA-02 ─────────────────────────────────────────────────────────────────

test("[PWA-02] legacy pi-finance-shell cache deleted → no cached response used", async ({
  page,
  context,
}) => {
  const id = "pwa-02";
  await deploySw(context, "legacy");
  await registerAndHome(page, id);
  await waitForController(page);

  await page.evaluate(async () => {
    const c = await caches.open("pi-finance-shell");
    await c.put("/registros", new Response("legacy-shell-body", { status: 200 }));
  });

  await deploySw(context, "current");
  await forceUpdate(page);

  // Nudge waiting worker; CLEAN_UPDATE causes controllerchange + reload
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.waiting) {
        reg.waiting.postMessage({ type: "CLEAN_UPDATE" });
        reg.waiting.postMessage({ action: "CLEAN_UPDATE" });
      }
    }),
  ]).catch(() => undefined);

  // After reload, controller is current SW which deleted legacy shell on activate
  await page.waitForLoadState("domcontentloaded");
  await waitForController(page);

  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(async () => {
            const keys = await caches.keys();
            return keys.filter(
              (k) =>
                k === "pi-finance-shell" || k.startsWith("pi-finance-shell"),
            );
          });
        } catch {
          return ["pending-nav"];
        }
      },
      { timeout: 20000 },
    )
    .toEqual([]);

  const legacyBody = await page.evaluate(async () => {
    const keys = await caches.keys();
    if (!keys.includes("pi-finance-shell")) return null;
    const c = await caches.open("pi-finance-shell");
    const r = await c.match("/registros");
    return r ? await r.text() : null;
  });
  expect(legacyBody).toBeNull();
});

// ── PWA-03 ─────────────────────────────────────────────────────────────────

test("[PWA-03] route HTML and _rsc never enter CacheStorage after activation", async ({
  page,
  context,
}) => {
  const id = "pwa-03";
  await deploySw(context, "current");
  await registerAndHome(page, id);
  await waitForController(page);

  await page.goto("/registros", { waitUntil: "domcontentloaded" });
  await page.goto("/hub/patrimonio?aba=contas", { waitUntil: "domcontentloaded" });

  const banned = await page.evaluate(async () => {
    const names = await caches.keys();
    const hits: string[] = [];
    for (const name of names) {
      if (name.includes("offline") || name.includes("precache")) {
        // offline-shell precache is allowed — skip non-route entries
      }
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const u = new URL(req.url);
        if (u.searchParams.has("_rsc")) {
          hits.push(`${name}:${u.pathname}?_rsc`);
        }
        if (
          (u.pathname === "/" ||
            u.pathname === "/registros" ||
            u.pathname === "/hub/patrimonio") &&
          !u.pathname.includes("offline-shell")
        ) {
          hits.push(`${name}:${u.pathname}`);
        }
      }
    }
    return hits;
  });

  expect(banned).toEqual([]);
});

// ── PWA-04 ─────────────────────────────────────────────────────────────────

test("[PWA-04] clean form triggers waiting worker → activates once and reloads", async ({
  page,
  context,
}) => {
  const id = "pwa-04";
  await deploySw(context, "legacy");
  await registerAndHome(page, id);
  await waitForController(page);

  // Clock-independent reload proof: page.clock.setFixedTime freezes
  // performance.timeOrigin, so a document identity marker (a window property
  // that dies with the document) is the only reliable reload signal. The
  // controllerchange flag persists in localStorage across the reload, so
  // observing both proves the activation caused the reload.
  await page.evaluate(() => {
    localStorage.removeItem("pwa04-cc");
    (window as unknown as { __pwa04doc?: string }).__pwa04doc =
      crypto.randomUUID();
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      localStorage.setItem("pwa04-cc", "1");
    });
  });
  const docBefore = await page.evaluate(
    () => (window as unknown as { __pwa04doc?: string }).__pwa04doc ?? "",
  );
  expect(docBefore.length).toBeGreaterThan(0);

  await deploySw(context, "current");
  await forceUpdate(page);

  // Clean page: the coordinator posts CLEAN_UPDATE to the waiting worker →
  // skipWaiting → controllerchange → exactly one reload. Both the activation
  // signal (persisted across the reload) and the reload itself (document
  // identity lost) must be real — a vacuous predicate here would pass
  // without any update. Callbacks tolerate the reload navigation in flight
  // (evaluate rejects with "Execution context was destroyed" while the new
  // document loads).
  await expect
    .poll(
      async () =>
        page
          .evaluate(() => localStorage.getItem("pwa04-cc"))
          .catch(() => "navigating"),
      { timeout: 35000 },
    )
    .toBe("1");
  await expect
    .poll(
      async () =>
        page
          .evaluate(
            () => (window as unknown as { __pwa04doc?: string }).__pwa04doc ?? null,
          )
          .catch(() => docBefore),
      { timeout: 35000 },
    )
    .not.toBe(docBefore);

  const after = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return {
      hasActive: !!reg?.active,
      hasWaiting: !!reg?.waiting,
      controller: !!navigator.serviceWorker.controller,
    };
  });
  expect(after.hasActive).toBe(true);
  expect(after.hasWaiting).toBe(false);
  expect(after.controller).toBe(true);

  // Exactly one reload: mark the new document, then prove it stays current —
  // a second reload would wipe the fresh marker.
  const docAfter = await page.evaluate(() => {
    const id = crypto.randomUUID();
    (window as unknown as { __pwa04doc2?: string }).__pwa04doc2 = id;
    return id;
  });
  await page.waitForTimeout(3000);
  await expect
    .poll(
      async () =>
        page
          .evaluate(
            () => (window as unknown as { __pwa04doc2?: string }).__pwa04doc2 ?? null,
          )
          .catch(() => "navigating"),
      { timeout: 10000 },
    )
    .toBe(docAfter);
});

// ── PWA-05 ─────────────────────────────────────────────────────────────────

test("[PWA-05] reload with active SW → offline shell still renders on network failure", async ({
  page,
  context,
}) => {
  const id = "pwa-05";
  await deploySw(context, "current");
  await registerAndHome(page, id);
  await waitForController(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForController(page);

  await context.setOffline(true);
  await page.goto("/compromissos", { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await expect
    .poll(async () => page.title(), { timeout: 15000 })
    .toMatch(/Offline|Pi Financeiro/i);
  await context.setOffline(false);
});

// ── PWA-06 ─────────────────────────────────────────────────────────────────

test("[PWA-06] dirty form retains waiting worker → no activation on dirty", async ({
  page,
  context,
}) => {
  const id = "pwa-06";
  await deploySw(context, "legacy");
  await registerAndHome(page, id);
  await waitForController(page);

  const controllerBefore = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL ?? "",
  );

  // Dirty the transaction sheet (real interaction)
  await dirtifyExpenseSheet(page);

  await deploySw(context, "current");
  await forceUpdate(page);

  // Allow coordinator to observe waiting + dirty
  await page.waitForTimeout(2000);

  const state = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return {
      waiting: !!reg?.waiting,
      controller: navigator.serviceWorker.controller?.scriptURL ?? "",
    };
  });

  // Controller must not have swapped due to CLEAN_UPDATE while dirty
  expect(state.controller).toBe(controllerBefore);
  // Prefer waiting worker retained (current SW does not skipWaiting on install)
  expect(state.waiting).toBe(true);
});
