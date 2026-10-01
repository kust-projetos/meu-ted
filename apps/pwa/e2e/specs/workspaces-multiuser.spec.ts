/**
 * Multi-user Workspace, Invites & Ownership Transfer E2E Tests
 *
 * Scenarios:
 * 1. Owner & Member control isolation in shared workspace
 * 2. Revoked/expired invite rejection & UI error recovery
 * 3. Ownership transfer acceptance exclusively by authenticated target member
 *
 * Auth note (WAVE11-CODER-E2EB): the suite runs with the legacy bearer compat
 * window CLOSED (run-ci.sh exports NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off), so
 * a localStorage `pi-finance:token` never authenticates — the token-store
 * drops the read entirely. Every test therefore establishes a REAL cookie
 * session via the harness authenticate() (fixture sign-in) BEFORE navigating
 * to /workspaces; the route mocks below only shape the workspace API answers
 * (strict, schema-adherent) and never the session itself.
 *
 * Mock strictness: only the endpoints listed here are stubbed (workspace,
 * members, invites, ownership transfers + schema-shaped bootstrap empties).
 * There is deliberately NO generic `/api/** → 200 {}` fallback — an
 * unexpected call must reach the fixture (or fail loudly), never pass with a
 * permissive shape that would turn the test falsely green. Owner/member
 * isolation is enforced per-role in the mocks (member sees no invites).
 */

import { test, expect } from "@playwright/test";
import { prepareSpec, authenticate, rewriteCspForFixture } from "../support/harness";
import { assertNoUndeclaredFailures } from "../support/failure-guard";
import { harnessOrigin } from "../support/ports";

// Cross-origin mocked API responses must carry CORS headers: the app calls
// the absolute fixture origin with credentials:include, so a fulfill without
// ACAO + ACA-Credentials is rejected by the browser (Failed to fetch).
const MOCK_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": harnessOrigin(),
  "Access-Control-Allow-Credentials": "true",
};

let counter = 0;
function tid(): string {
  counter += 1;
  return `ws-multi-${counter}`;
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

type ApiMockConfig = {
  sharedWsId: string;
  getRole: () => "owner" | "member";
  invites?: Array<{ id: string; householdId: string; email: string; role: "owner" | "member"; expiresAt: string }>;
  ownershipTransfers?: Array<{ id: string; householdId: string; fromUserId: string; toUserId: string; status: string; createdAt: string }>;
  onRevokeInvite?: (inviteId: string) => { status: number; body: Record<string, unknown> };
  onAcceptTransfer?: (transferId: string) => { status: number; body: Record<string, unknown> };
};

/**
 * Discrete workspace-API mocks, registered AFTER prepareSpec so each pattern
 * wins over the harness catch-all ONLY for its own URLs. Documents, session
 * auth (fixture sign-in + cookie probe) and all bootstrap data keep flowing
 * through the harness handler + the real fixture (populated seed) untouched —
 * a broad star-star-slash-star catch-all here would shadow the harness CSP
 * rewrite and break the login it is supposed to precede.
 */
async function setupMockApi(page: import("@playwright/test").Page, config: ApiMockConfig) {
  const handleWorkspaces = async (route: import("@playwright/test").Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;

    // The patterns above also match the /workspaces page navigation itself —
    // a document must NEVER be answered with JSON. Fetch through with the
    // fixture-widened CSP (same redirect handling as support/harness.ts).
    if (req.resourceType() === "document") {
      try {
        const response = await route.fetch({ maxRedirects: 0 });
        if (response.status() >= 300 && response.status() < 400) {
          const location = response.headers()["location"];
          if (location) {
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
      return;
    }

    // Workspaces endpoints (strict, schema-adherent shapes only)
    if (pathname.includes(`/workspaces/${config.sharedWsId}/members`) && req.method() === "GET") {
      const isOwner = config.getRole() === "owner";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          items: [
            { userId: "usr-owner-1", name: "Alice Owner", email: "owner@example.test", role: isOwner ? "owner" : "member" },
            { userId: "usr-member-2", name: "Bob Member", email: "bob@example.test", role: isOwner ? "member" : "owner" },
          ],
          total: 2,
        }),
      });
    }

    // Revoke invite DELETE route
    if (pathname.includes(`/workspaces/${config.sharedWsId}/invites/`) && req.method() === "DELETE") {
      const inviteId = pathname.split("/").pop() ?? "";
      if (config.onRevokeInvite) {
        const res = config.onRevokeInvite(inviteId);
        return route.fulfill({
          status: res.status,
          contentType: "application/json",
          headers: MOCK_CORS_HEADERS,
          body: JSON.stringify(res.body),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ success: true, inviteId }),
      });
    }

    if (pathname.includes(`/workspaces/${config.sharedWsId}/invites`) && req.method() === "GET") {
      // Isolation: only the owner lists invites — a member answer is
      // authoritatively empty, never the owner set.
      const items = config.getRole() === "owner" ? (config.invites ?? []) : [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ items, total: items.length }),
      });
    }

    // Accept transfer POST route
    if (pathname.includes(`/workspaces/${config.sharedWsId}/ownership-transfers/`) && pathname.endsWith("/accept") && req.method() === "POST") {
      const parts = pathname.split("/");
      const transferId = parts[parts.length - 2] ?? "";
      if (config.onAcceptTransfer) {
        const res = config.onAcceptTransfer(transferId);
        return route.fulfill({
          status: res.status,
          contentType: "application/json",
          headers: MOCK_CORS_HEADERS,
          body: JSON.stringify(res.body),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ id: transferId, status: "accepted" }),
      });
    }

    if (pathname.includes(`/workspaces/${config.sharedWsId}/ownership-transfers`) && req.method() === "GET") {
      const items = config.ownershipTransfers ?? [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ items, total: items.length }),
      });
    }

    if (pathname.endsWith("/workspaces") && req.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({
          items: [
            { id: config.sharedWsId, name: "Empresa Compartilhada", kind: "shared", role: config.getRole(), status: "active" },
          ],
          total: 1,
        }),
      });
    }

    // Anything else under /workspaces* is not part of this flow — let it
    // reach the fixture instead of inventing a permissive shape.
    return route.continue();
  };
  // Both the list endpoint (/workspaces) and every nested route below it.
  await page.route("**/workspaces", handleWorkspaces);
  await page.route("**/workspaces/**", handleWorkspaces);

  await page.route("**/auth/devices/me", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({ deviceId: "dev-1", householdId: config.sharedWsId }),
    });
  });

  await page.route("**/auth/agent-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({ token: "mock-token", expiresIn: 90 }),
    });
  });
}

/**
 * Authenticate against the fixture (real cookie session) and land on
 * /workspaces with the mocks above shaping the workspace API answers.
 */
async function gotoWorkspacesAuthenticated(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await authenticate(page);
  await page.goto("/workspaces");
  await page.waitForLoadState("networkidle");
}

test.describe("Multi-user Workspaces, Invites & Ownership Transfers", () => {
  test("isolates administrative controls between Owner and Member in shared workspace", async ({ page }) => {
    const id = tid();
    const guard = await prepareSpec(page, id, {
      baselineAllows: true,
      allow: [
        { message: "reading 'waiting'", reason: "SW blocked" },
        { message: "Content Security Policy", reason: "addInitScript CSP inline" },
        { message: "net::ERR_ABORTED", reason: "Reload abort" },
      ],
    });

    const SHARED_WS_ID = "ws-shared-1";
    let userRole: "owner" | "member" = "owner";

    await setupMockApi(page, {
      sharedWsId: SHARED_WS_ID,
      getRole: () => userRole,
      invites: [
        {
          id: "inv-e2e-1",
          householdId: SHARED_WS_ID,
          email: "novo-membro@example.test",
          role: "member",
          expiresAt: "2026-09-10T12:00:00.000Z",
        },
      ],
    });

    await gotoWorkspacesAuthenticated(page);

    // Owner checks: Sees pending invite, without any raw token or hash leakage
    await expect(page.getByRole("heading", { name: /convites pendentes/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("novo-membro@example.test")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/token/i)).not.toBeVisible();
    await expect(page.getByText(/hash/i)).not.toBeVisible();

    // Owner checks: Sees transfer ownership initiation dropdown & button
    await expect(page.getByRole("heading", { name: /transferir titularidade/i })).toBeVisible();
    await expect(page.getByLabel(/novo titular/i)).toBeVisible();

    // 2. Switch role context to Member view: member must not see administrative controls
    userRole = "member";
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Member checks: Administrative cards are hidden
    await expect(page.getByRole("heading", { name: /convites pendentes/i })).not.toBeVisible();
    await expect(page.getByLabel(/novo titular/i)).not.toBeVisible();

    assertNoUndeclaredFailures(guard);
  });

  test("handles invite resend/revoke failures with accessible and recoverable UI error state", async ({ page }) => {
    const id = tid();
    const guard = await prepareSpec(page, id, {
      baselineAllows: true,
      allow: [
        { message: "reading 'waiting'", reason: "SW blocked" },
        { message: "Content Security Policy", reason: "addInitScript CSP inline" },
        { message: "net::ERR_ABORTED", reason: "Reload abort" },
        { message: "403", reason: "Simulated 403 revocation console error" },
        { message: "Forbidden", reason: "Simulated 403 Forbidden" },
        { status: 403, reason: "Simulated revocation failure" },
      ],
    });

    const SHARED_WS_ID = "ws-shared-1";

    await setupMockApi(page, {
      sharedWsId: SHARED_WS_ID,
      getRole: () => "owner",
      invites: [
        {
          id: "inv-err-1",
          householdId: SHARED_WS_ID,
          email: "convidado-expirado@example.test",
          role: "member",
          expiresAt: "2026-09-01T12:00:00.000Z",
        },
      ],
      onRevokeInvite: () => ({
        status: 403,
        body: {
          code: "auth.invite_forbidden",
          message: "Convite revogado ou expirado.",
        },
      }),
    });

    await gotoWorkspacesAuthenticated(page);

    // Click revogar and confirm
    await page.getByRole("button", { name: /revogar convite para convidado-expirado@example.test/i }).click();
    const dialog = page.getByRole("dialog", { name: /revogar convite/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /revogar convite/i }).click();

    // Close dialog
    await dialog.getByRole("button", { name: /cancelar/i }).click();
    await expect(dialog).not.toBeVisible();

    // Verify recoverable error message displayed (filter specifically for the danger alert card)
    const errorAlert = page.getByRole("alert").filter({ hasText: /convite|não foi possível/i });
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText(/não foi possível revogar|convite revogado ou expirado/i);

    // Dismiss error
    await page.getByRole("button", { name: /fechar erro/i }).click();
    await expect(errorAlert).not.toBeVisible();

    assertNoUndeclaredFailures(guard);
  });

  test("allows authenticated target member to view proposal and accept ownership transfer", async ({ page }) => {
    const id = tid();
    const guard = await prepareSpec(page, id, {
      baselineAllows: true,
      allow: [
        { message: "reading 'waiting'", reason: "SW blocked" },
        { message: "Content Security Policy", reason: "addInitScript CSP inline" },
        { message: "net::ERR_ABORTED", reason: "Reload abort" },
      ],
    });

    const SHARED_WS_ID = "ws-shared-1";
    const TRANSFER_ID = "tr-e2e-1";
    let isOwner = false;

    await setupMockApi(page, {
      sharedWsId: SHARED_WS_ID,
      getRole: () => (isOwner ? "owner" : "member"),
      ownershipTransfers: [
        {
          id: TRANSFER_ID,
          householdId: SHARED_WS_ID,
          fromUserId: "usr-owner-1",
          toUserId: "usr-member-2",
          status: "pending",
          createdAt: "2026-08-30T10:00:00.000Z",
        },
      ],
      onAcceptTransfer: () => {
        isOwner = true;
        return {
          status: 200,
          body: {
            id: TRANSFER_ID,
            household_id: SHARED_WS_ID,
            from_user_id: "usr-owner-1",
            to_user_id: "usr-member-2",
            status: "accepted",
            accepted_at: "2026-08-31T10:00:00.000Z",
          },
        };
      },
    });

    await gotoWorkspacesAuthenticated(page);

    // Member sees proposal card
    await expect(page.getByRole("heading", { name: /proposta de titularidade/i })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: /aceitar titularidade/i }).click();

    // Confirm acceptance in dialog
    const dialog = page.getByRole("dialog", { name: /aceitar titularidade do workspace/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /confirmar aceitação/i }).click();

    // After acceptance, proposal is gone and member is now Owner (administrative cards appear)
    await expect(page.getByRole("heading", { name: /proposta de titularidade/i })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: /transferir titularidade/i })).toBeVisible();

    assertNoUndeclaredFailures(guard);
  });
});
