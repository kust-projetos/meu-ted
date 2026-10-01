/**
 * Single entry point for E2E test setup.
 *
 * Replaces the ~35 lines of helpers that were copy-pasted into every spec
 * (allowCsp, resetFixture, getJournal, expectJournal, registerDevice, init).
 *
 * AUTH BOUNDARY: `authenticate()` is the only place that knows how a session
 * is established. Phase 1 swaps device registration for user login by editing
 * that one function — no spec file changes.
 */

// Single source of truth for the fixture origin — reuse, do not redeclare.
// `support/reset.ts` already exports FIXTURE_URL; a second constant would drift.
import { FIXTURE_URL } from "./reset";

export { FIXTURE_URL };

/**
 * Rewrite a CSP header so the browser may reach the local fixture API
 * and evaluate the Next.js dev runtime.
 *
 * Returns the policy unchanged when neither directive is present.
 */
export function rewriteCspForFixture(csp: string): string {
  return (
    csp
      .replace(/connect-src\s+([^;]+)/, `connect-src ${FIXTURE_URL} $1`)
      // Test-only: drop the build's per-response nonce and allow inline
      // scripts. Since fix 5513482 the product stamps its inline theme
      // bootstrap with the per-request nonce (x-nonce), but a static rewrite
      // cannot mint that nonce, so the directive is still replaced wholesale
      // (browsers ignore 'unsafe-inline' when a nonce is present).
      .replace(/script-src\s+[^;]+/, "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:")
  );
}

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  createGuard,
  attachGuard,
  allowFailure,
  type GuardState,
} from "./failure-guard";

// Reused from ./reset — do not redeclare these values here.
import { FIXED_CLOCK, E2E_TEST_ID_HEADER } from "./reset";

export { FIXED_CLOCK, E2E_TEST_ID_HEADER };

/** Failures every spec tolerates. Previously redeclared in each spec file. */
const BASELINE_ALLOWED = [
  { message: "reading 'waiting'", reason: "SW blocked" },
  { url: "/profile", reason: "fixture has no /profile" },
  { url: "/pwa-control", reason: "fixture has no /pwa-control" },
] as const;

/**
 * Establish an authenticated session.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 1 AUTH SWAP HAPPENS HERE AND NOWHERE ELSE.
 * Today: email login via "Entrar" (sign-in, then the app itself calls
 * POST /auth/devices/register). There is no standalone "Registrar" button
 * in the product — do not click one. Rewrite this body only.
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function authenticate(
  page: Page,
  /** Service-worker specs need a longer wait than the default. */
  options: { timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 15000;
  // Authenticated-shell signal is viewport-dependent: the mobile shell shows
  // the BottomNav FAB ("Nova transação", hidden at `lg`), while the desktop
  // shell shows the SidebarRail CTA ("Novo lançamento", `hidden lg:flex`).
  // Either one proves a signed-in shell; neither is weakened (both only
  // render after AuthGate accepts the session — a rejected login still shows
  // the "Entrar" form and neither signal, so the final wait still fails).
  const mobileFab = page.getByLabel("Nova transação");
  // Scoped to the rail: some pages (e.g. /registros) render their own
  // "Novo lançamento" button in the main content, and an unscoped lookup
  // trips strict mode there (probe would read "no shell" forever).
  const desktopCta = page
    .getByRole("complementary")
    .getByRole("button", { name: "Novo lançamento" });
  // NOTE: do NOT join these with locator.or() — both nodes stay mounted in
  // the DOM at every viewport (one is CSS-hidden), so .or() resolves to 2
  // elements and trips strict mode. Visibility is probed per-locator below.
  const shellVisible = async (): Promise<boolean> =>
    (await mobileFab.isVisible().catch(() => false)) ||
    (await desktopCta.isVisible().catch(() => false));
  if (await shellVisible()) return;

  // Real product flow (AuthGate has only "Entrar"): fill the login form,
  // submit, and the app itself calls POST /auth/sign-in/email followed by
  // POST /auth/devices/register. There is no standalone "Registrar" button
  // in the product — clicking one would be a no-op that never hits the API.
  const emailInput = page.getByLabel("E-mail");
  const passwordInput = page.getByLabel("Senha");
  const loginBtn = page.getByRole("button", { name: "Entrar" });

  const loginFormVisible = await emailInput
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (loginFormVisible) {
    // Hydration gate: server-rendered inputs accept fill() before React
    // hydrates, but hydration then resets the uncontrolled DOM values to
    // React state (empty) and Entrar stays disabled forever (remote PWA-03 /
    // PWA-05: button stuck disabled for the full 20s while PWA-01/02/04/06
    // won the same race). The boot placeholder unmounts exactly at
    // hydration, so its absence proves React owns the inputs before we fill.
    await expect(page.getByTestId("root-boot-placeholder")).toHaveCount(0, { timeout });
    await emailInput.fill("test@example.com");
    await passwordInput.fill("password123");
    // Self-healing fill (same timeout budget, no weakening): under load the
    // login form can mount a second time AFTER the fill (proven locally
    // under CPU throttle: two LoginForm mounts, the second wipes the filled
    // values while React state stays empty → Entrar stuck disabled, remote
    // PWA-03/05 + push-02/03/04). Re-fill until the values stick and Entrar
    // enables; the click below still requires the enabled state, and the
    // final shell poll still proves the login.
    await expect
      .poll(
        async () => {
          if (await loginBtn.isEnabled().catch(() => false)) return true;
          await emailInput.fill("test@example.com").catch(() => undefined);
          await passwordInput.fill("password123").catch(() => undefined);
          return await loginBtn.isEnabled().catch(() => false);
        },
        { timeout },
      )
      .toBe(true);
    await loginBtn.click();
    await page.waitForLoadState("networkidle");
  }

  // After Entrar the fixture signs in and registers a device, storing the
  // token in localStorage; wait for the authenticated shell to appear in
  // whichever viewport this project uses (FAB on mobile, SidebarRail CTA on
  // desktop). expect.poll on the visibility probe keeps rigor (a rejected
  // login shows neither) without tripping strict mode on the two mounted
  // (one CSS-hidden) nodes.
  await expect.poll(shellVisible, { timeout }).toBe(true);
}

/**
 * Reset the fixture store for a test id.
 *
 * `seed` is explicit for auth specs, which reset to non-populated states to
 * exercise registration and token expiry.
 */
export async function resetFixture(testId: string, seed = "populated"): Promise<void> {
  const res = await fetch(`${FIXTURE_URL}/__e2e/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [E2E_TEST_ID_HEADER]: testId },
    body: JSON.stringify({ testId, seed }),
  });
  if (!res.ok) throw new Error(`Fixture reset failed: ${res.status}`);
}

export type JournalEntry = {
  method: string;
  path: string;
  status: number;
  /** Request payload, when the fixture recorded one. Asserted by profile specs. */
  body?: unknown;
  /** Value of the `idempotency-key` request header when the fixture captured one. */
  idempotencyKey?: string | null;
};

/** Read the fixture request journal for a test id. */
export async function getJournal(testId: string): Promise<JournalEntry[]> {
  const res = await fetch(`${FIXTURE_URL}/__e2e/journal?testId=${testId}`, {
    headers: { [E2E_TEST_ID_HEADER]: testId },
  });
  return res.ok ? res.json() : [];
}

/** Assert the journal eventually contains a matching request. */
export async function expectJournal(
  testId: string,
  method: string,
  path: string | RegExp,
  status: number,
  timeout = 8000,
): Promise<void> {
  const pathMatches = (entryPath: string): boolean => {
    if (typeof path === "string") return entryPath === path;
    // Strip stateful flags so repeated polling cannot alternate matches via
    // RegExp.lastIndex when callers pass /g or /y expressions.
    const matcher = new RegExp(path.source, path.flags.replace(/[gy]/g, ""));
    return matcher.test(entryPath);
  };
  await expect
    .poll(
      async () =>
        (await getJournal(testId)).some(
          (entry) => entry.method === method && entry.status === status && pathMatches(entry.path),
        ),
      { timeout },
    )
    .toBe(true);
}

export type InitOptions = {
  /** Path to navigate to after authenticating. Defaults to "/". */
  navigateTo?: string;
  /** Extra tolerated failures on top of BASELINE_ALLOWED. */
  allow?: ReadonlyArray<{ message?: string; url?: string; reason: string }>;
  /**
   * Apply BASELINE_ALLOWED. Defaults to true.
   *
   * Set false for specs that deliberately run a stricter guard — navigation.spec
   * tolerates only the service-worker failure, and silently widening it to the
   * baseline set would keep those 25 tests green while detecting less.
   */
  baselineAllows?: boolean;
};

/** Intercept every response and widen its CSP so the fixture API is reachable. */
export async function applyCspRewrite(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    try {
      const req = route.request();
      const isDocument = req.resourceType() === "document";
      // Fetch without following redirects for documents so server 307s
      // (legacy routes → canonical tabs, see CANONICAL_REDIRECTS in
      // src/lib/routes.ts) stay visible to the harness. route.fulfill()
      // serves responses directly and the browser does NOT process a
      // fulfilled 3xx as a navigation — fulfilling the 307 as-is would
      // swallow the redirect and strand the page on the legacy URL
      // (REDIRECT-01..04). Non-documents keep the default follow behavior.
      const response = isDocument
        ? await route.fetch({ maxRedirects: 0 })
        : await route.fetch();
      if (isDocument && response.status() >= 300 && response.status() < 400) {
        const location = response.headers()["location"];
        if (location) {
          // Re-issue the redirect client-side so the follow-up navigation
          // flows through interception again and gets its CSP rewritten.
          // (A natively-continued redirect chain bypasses route handlers for
          // the follow-up document, which would keep the server-original CSP
          // and block every fixture call — RDIAG5 2026-09-09.)
          const dest = new URL(location, req.url()).toString();
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            headers: {
              "content-security-policy": "script-src 'self' 'unsafe-inline'; connect-src 'self';",
            },
            body: `<!doctype html><html><head><meta charset="utf-8"><title>redirecting</title></head><body><script>location.replace(${JSON.stringify(dest)});</script></body></html>`,
          });
          return;
        }
      }
      const headers = { ...response.headers() };
      const csp = headers["content-security-policy"];
      if (csp) headers["content-security-policy"] = rewriteCspForFixture(csp);
      await route.fulfill({ response, headers });
    } catch {
      /* route already handled or page closed */
    }
  });
}

/**
 * Everything a spec needs *before* it navigates: guard, CSP rewrite, fixture
 * reset, fixed clock, test-id header, tolerated failures.
 *
 * Does NOT navigate and does NOT authenticate — the caller decides the order.
 * Specs that deep-link into a route and only then register (records REC-02..04,
 * every navigation spec) must use this instead of `initSpec`, because the order
 * `goto(route)` → `authenticate()` is exactly what those tests exercise.
 */
export async function prepareSpec(
  page: Page,
  testId: string,
  options: Pick<InitOptions, "allow" | "baselineAllows"> = {},
): Promise<GuardState> {
  const guard = createGuard();
  attachGuard(page, guard);
  // Every fresh browser context makes an anonymous cookie-session probe before
  // login. Allow only that exact 401 at the console and HTTP layers; all other
  // 401s remain visible to the failure guard.
  allowFailure(guard, {
    url: "/auth/session",
    status: 401,
    message: "401 (Unauthorized)",
    reason: "expected anonymous cookie-session probe before login",
  });

  await applyCspRewrite(page);
  // Local functional PWA E2E has no Worker/Agent runtime. Keep background
  // approval-count refreshes inside the browser fixture instead of allowing
  // the Next proxy to choose an upstream Agent origin.
  await page.route(
    /\/api\/agent\/agents\/finance-chat-agent\/[^/]+\/rpc\/pending-operations\/active(?:\?.*)?$/,
    async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    }),
  );
  await resetFixture(testId);
  await page.clock.setFixedTime(FIXED_CLOCK);
  await page.context().setExtraHTTPHeaders({ [E2E_TEST_ID_HEADER]: testId });

  if (options.baselineAllows !== false) {
    for (const entry of BASELINE_ALLOWED) allowFailure(guard, entry);
  }
  for (const entry of options.allow ?? []) allowFailure(guard, entry);

  return guard;
}

/**
 * Full per-test setup for the common case: prepare, land on "/", authenticate,
 * then navigate to the target route.
 *
 * Returns the guard so the spec can call assertNoUndeclaredFailures().
 */
export async function initSpec(
  page: Page,
  testId: string,
  options: InitOptions = {},
): Promise<GuardState> {
  const guard = await prepareSpec(page, testId, options);

  await page.goto("/");
  await authenticate(page);
  if (options.navigateTo && options.navigateTo !== "/") {
    await page.goto(options.navigateTo);
  }

  return guard;
}
