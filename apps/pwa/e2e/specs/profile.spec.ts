/**
 * Profile page E2E tests — PROF-01..06
 *
 * Matrix:
 * PROF-01 save profile name → PATCH /profile
 * PROF-02 save avatar → PATCH /profile
 * PROF-03 save greeting → PATCH /profile
 * PROF-04 tap notification opens item / target
 * PROF-05 dismiss notification → state update
 * PROF-06 logout clears token/snapshot → register screen
 *
 * Fixed clock 2026-07-17 → Internet payable overdue → notification items exist.
 */

import { test, expect } from "@playwright/test";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import { prepareSpec, authenticate, getJournal } from "../support/harness";
import { FIXTURE_URL } from "../support/reset";

const TOKEN_KEY = "pi-finance:token";

let counter = 0;
function tid(): string {
  counter += 1;
  return `prof-${counter}`;
}


test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});



async function expectJournalPatchProfile(
  testId: string,
  partial: Record<string, unknown>,
): Promise<void> {
  await expect
    .poll(async () => {
      const entries = await getJournal(testId);
      return entries.filter(
        (e) => e.method === "PATCH" && e.path === "/profile" && e.status === 200,
      );
    })
    .not.toHaveLength(0);

  const entries = await getJournal(testId);
  const patch = entries
    .filter((e) => e.method === "PATCH" && e.path === "/profile" && e.status === 200)
    .at(-1);
  expect(patch).toBeDefined();
  expect(patch!.body).toMatchObject(partial);
}


async function init(page: import("@playwright/test").Page, id: string) {
  // `prepareSpec`, not `initSpec`: the init script must be registered before
  // the first navigation, and this spec deep-links into /perfil before
  // registering — both orders are load-bearing.
  const guard = await prepareSpec(page, id, {
    baselineAllows: false,
    allow: [
      { message: "reading 'waiting'", reason: "SW blocked" },
    ],
  });
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("pi-finance:notifications-dismissed");
    } catch {
      /* noop */
    }
  });
  await page.goto("/perfil");
  await authenticate(page);
  await expect(page.getByRole("heading", { name: "Perfil" })).toBeVisible({
    timeout: 10000,
  });
  return guard;
}

async function openEditSheet(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Editar perfil" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Editar perfil" })).toBeVisible();
  return dialog;
}

/** Type into a controlled React textbox and assert the value stuck. */
async function setTextbox(
  locator: import("@playwright/test").Locator,
  value: string,
) {
  await locator.click();
  await locator.fill("");
  await locator.pressSequentially(value, { delay: 15 });
  await expect(locator).toHaveValue(value);
}

// ── PROF-01 ────────────────────────────────────────────────────────────────

test("[PROF-01] save profile name → PATCH /profile", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  const dialog = await openEditSheet(page);
  // Name is the first textbox in the edit sheet
  const nameInput = dialog.getByRole("textbox").first();
  await setTextbox(nameInput, "Marina E2E");
  await dialog.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(dialog).toBeHidden();
  await expectJournalPatchProfile(id, { name: "Marina E2E" });
  await expect(page.getByText("Marina E2E")).toBeVisible();
  assertNoUndeclaredFailures(guard);
});

// ── PROF-02 ────────────────────────────────────────────────────────────────

test("[PROF-02] save avatar → PATCH /profile", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  const dialog = await openEditSheet(page);
  await dialog.getByRole("button", { name: "Cor #EC7000" }).click();
  // Force a dirty name touch so save is unambiguously intentional
  await expect(dialog.getByRole("button", { name: "Cor #EC7000" })).toBeVisible();
  await dialog.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(dialog).toBeHidden();
  await expectJournalPatchProfile(id, { avatarColor: "#EC7000" });
  assertNoUndeclaredFailures(guard);
});

// ── PROF-03 ────────────────────────────────────────────────────────────────

test("[PROF-03] save greeting → PATCH /profile", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  const dialog = await openEditSheet(page);
  await dialog.getByRole("button", { name: "Detalhada" }).click();
  await expect(dialog.getByRole("button", { name: "Detalhada" })).toBeVisible();
  await dialog.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(dialog).toBeHidden();
  await expectJournalPatchProfile(id, { greetingStyle: "verbose" });
  assertNoUndeclaredFailures(guard);
});

// ── PROF-04 ────────────────────────────────────────────────────────────────

test("[PROF-04] tap notification opens item / target state", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  await page.getByRole("button", { name: "Notificações" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Notificações" })).toBeVisible();

  const item = dialog.getByTestId("notification-item").first();
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Abrir" }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/compromissos\?aba=a-pagar/);
  assertNoUndeclaredFailures(guard);
});

// ── PROF-05 ────────────────────────────────────────────────────────────────

test("[PROF-05] dismiss notification → state update", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);

  await page.getByRole("button", { name: "Notificações" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const items = dialog.getByTestId("notification-item");
  const before = await items.count();
  expect(before).toBeGreaterThan(0);

  await items.first().getByRole("button", { name: "Dispensar" }).click();
  await expect(items).toHaveCount(before - 1);

  // Dismissed set persisted
  const dismissed = await page.evaluate(() =>
    localStorage.getItem("pi-finance:notifications-dismissed"),
  );
  expect(dismissed).toBeTruthy();
  expect(JSON.parse(dismissed as string).length).toBeGreaterThan(0);
  assertNoUndeclaredFailures(guard);
});

// ── PROF-06 ────────────────────────────────────────────────────────────────

test("[PROF-06] cookie-only logout revokes the session → login gate, no reauth on reload", async ({ page }) => {
  const id = tid();
  const guard = await init(page, id);
  // Initial session works: the canonical cookie probe confirmed the user.
  await expect
    .poll(async () => {
      const entries = await getJournal(id);
      return entries.filter(
        (e) => e.method === "GET" && e.path === "/auth/session" && e.status === 200,
      );
    }, { timeout: 10000 })
    .not.toHaveLength(0);

  // Cookie-only profile (NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off): the session
  // bearer never persists. T04: the device token persists in this profile —
  // persistence is independent of the legacy bearer window.
  const tokenBefore = await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY);
  expect(tokenBefore).not.toBeNull();
  const sessionTokenBefore = await page.evaluate(() => localStorage.getItem("pi-finance:session-token"));
  expect(sessionTokenBefore).toBeNull();

  // Capture the HttpOnly session cookie before logout (invisible to
  // document.cookie — the CDP jar is the only faithful handle).
  const jarBefore = await page.context().cookies();
  const sessionCookie = jarBefore.find((c) => c.name === "better-auth.session_token");
  expect(sessionCookie?.value).toBeTruthy();
  const revokedCookie = `better-auth.session_token=${sessionCookie!.value}`;

  await page.getByRole("button", { name: "Sair da conta" }).click();

  // Back to login gate
  await expect(page.getByRole("button", { name: /Entrar|Registrar/i })).toBeVisible({
    timeout: 15000,
  });
  await expect(page).toHaveURL(/\/$/);

  // The PWA itself revoked server-side: its own POST /auth/sign-out is
  // recorded as success. No manual sign-out call here — driving the
  // revocation from Node would mask a UI that never revoked the session.
  await expect
    .poll(async () => {
      const entries = await getJournal(id);
      return entries.filter(
        (e) => e.method === "POST" && e.path === "/auth/sign-out" && e.status === 200,
      );
    }, { timeout: 10000 })
    .not.toHaveLength(0);

  // Boolean cookie evidence only: the server saw the session cookie on the
  // app's sign-out request and revoked exactly that session (never the raw
  // value, never another testId's session).
  const signOutEntries = await getJournal(id);
  const signOutEntry = signOutEntries
    .filter((e) => e.method === "POST" && e.path === "/auth/sign-out" && e.status === 200)
    .at(-1);
  expect(signOutEntry).toBeDefined();
  expect(signOutEntry!.body).toEqual({ hadCookie: true, revoked: true });

  // The fixture session cookie is gone from the browser jar — the sign-out
  // response cleared it (expired attributes). An empty remnant counts as
  // cleared: it authenticates nothing.
  await expect
    .poll(async () => {
      const jar = await page.context().cookies();
      const stale = jar.find((c) => c.name === "better-auth.session_token");
      return stale?.value ? stale.value : null;
    }, { timeout: 10000 })
    .toBeNull();

  // The pre-logout cookie cannot authenticate, even when replayed verbatim.
  const replayRes = await fetch(`${FIXTURE_URL}/auth/session`, {
    headers: { "x-e2e-test-id": id, Cookie: revokedCookie },
  });
  expect(replayRes.status).toBe(401);

  // Reload does not reauthenticate: no session cookie survives, the probe
  // rejects, and the login gate stays put. Capture the rejected-probe count
  // first so the post-reload assertion below proves a FRESH browser
  // GET /auth/session 401 landed in the journal (not a pre-logout entry).
  const probesBefore = await getJournal(id);
  const rejectedProbesBefore = probesBefore.filter(
    (e) => e.method === "GET" && e.path === "/auth/session" && e.status === 401,
  ).length;

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: /Entrar|Registrar/i })).toBeVisible({
    timeout: 15000,
  });

  await expect
    .poll(async () => {
      const entries = await getJournal(id);
      return entries.filter(
        (e) => e.method === "GET" && e.path === "/auth/session" && e.status === 401,
      ).length;
    }, { timeout: 10000 })
    .toBeGreaterThan(rejectedProbesBefore);

  const tokenAfter = await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY);
  expect(tokenAfter).toBeNull();
  const sessionTokenAfter = await page.evaluate(() => localStorage.getItem("pi-finance:session-token"));
  expect(sessionTokenAfter).toBeNull();
  assertNoUndeclaredFailures(guard);
});
