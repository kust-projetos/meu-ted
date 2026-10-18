/**
 * Auth E2E tests — IDs AUTH-01, AUTH-02.
 *
 * AUTH-01: cookie-first email login → session confirmation + device registration,
 * no bearer persistence, authenticated home.
 *
 * AUTH-02: reject the cookie session with 401 and assert sensitive state is cleared
 * and the login screen returns.
 */

import { test, expect } from "@playwright/test";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import { FIXTURE_URL } from "../support/reset";
import { getJournal, prepareSpec, authenticate } from "../support/harness";

const TOKEN_KEY = "pi-finance:token";
let counter = 0;
function tid(): string { counter++; return `auth-${counter}`; }




async function addScenario(testId: string, method: string, pathname: string, status: number): Promise<void> {
  await fetch(`${FIXTURE_URL}/__e2e/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-e2e-test-id": testId },
    body: JSON.stringify({ testId, method, pathname, status, once: true }),
  });
}

// ── AUTH-01: Session-first login + device registration ──────────────────────

test("[AUTH-01] cookie-first login confirms session and registers a device", async ({ page }) => {
  const id = tid();
  const guard = await prepareSpec(page, id);

  await page.goto("/");
  await authenticate(page);

  // Session cookie is the authority; the candidate build closes the legacy
  // bearer window (the session bearer never persists). T04: the device token
  // persists independently of that window, avoiding the re-registration storm.
  const journal = await getJournal(id);
  const signInEntry = journal.find((e) => e.method === "POST" && e.path === "/auth/sign-in/email");
  const regEntry = journal.find((e) => e.method === "POST" && e.path === "/auth/devices/register");
  const sessionEntry = journal.find((e) => e.method === "GET" && e.path === "/auth/session" && e.status === 200);
  expect(signInEntry).toBeDefined();
  expect(signInEntry!.status).toBe(200);
  expect(regEntry).toBeDefined();
  expect(regEntry!.status).toBe(200);
  expect(sessionEntry).toBeDefined();

  // The session bearer is never persisted; the device token persists (T04).
  const token = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
  const sessionToken = await page.evaluate(() => localStorage.getItem("pi-finance:session-token"));
  expect(token).not.toBeNull();
  expect(sessionToken).toBeNull();

  // Authenticated home
  await expect(page.getByRole("button", { name: /abrir perfil/i })).toBeVisible({ timeout: 10000 });

  assertNoUndeclaredFailures(guard);
});

// ── AUTH-02: Explicit session rejection ─────────────────────────────────────

test("[AUTH-02] session 401 clears sensitive state and returns to login", async ({ page }) => {
  const id = tid();
  const guard = await prepareSpec(page, id);

  await page.goto("/");
  await authenticate(page);
  await addScenario(id, "GET", "/auth/session", 401);
  await page.reload();
  await page.waitForLoadState("networkidle");

  // An explicit cookie-session rejection purges identity and returns to login.
  const journal = await getJournal(id);
  const rejectedSession = journal.find((e) => e.method === "GET" && e.path === "/auth/session" && e.status === 401);
  expect(rejectedSession).toBeDefined();

  // Cookie-only auth retains zero SESSION bearer identity. T04: a session
  // rejection is not device revocation — the device token survives so the
  // next login reuses the registered device instead of minting a new one.
  const tokenAfter = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
  expect(tokenAfter).not.toBeNull();
  const sessionTokenAfter = await page.evaluate(() => localStorage.getItem("pi-finance:session-token"));
  expect(sessionTokenAfter).toBeNull();

  // Login screen must be visible
  const loginOrRegBtn = page.getByRole("button", { name: /Entrar|Registrar/i });
  await expect(loginOrRegBtn).toBeVisible({ timeout: 15000 });

  assertNoUndeclaredFailures(guard);
});
