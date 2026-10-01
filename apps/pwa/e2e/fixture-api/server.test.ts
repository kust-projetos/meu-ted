// @vitest-environment node

/**
 * Protocol tests for the fixture API server.
 * Tests run against an in-memory server instance (port 0 = OS-assigned).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer } from "./server";
import type { SeedData } from "./store";

// ─── Test helpers (typed request) ────────────────────────────────────────────

interface HttpResponse {
  status: number;
  data: unknown;
  headers: Record<string, string | string[] | undefined>;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const opts: http.RequestOptions = {
      method,
      path,
      hostname: "127.0.0.1",
      port,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let data: unknown = undefined;
        try {
          data = raw ? JSON.parse(raw) : undefined;
        } catch {
          data = raw;
        }
        resolve({
          status: res.statusCode ?? 0,
          data,
          headers: res.headers,
        });
      });
    });
    req.on("error", (err) => {
      // Expected for offline/abort scenarios
      reject(err);
    });
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Extract JSON response data with type safety
function responseData<T>(res: HttpResponse): T {
  return res.data as T;
}

const SIGN_IN_CREDENTIALS = { email: "test@example.com", password: "password123" };

/** Sign in a testId and return the `name=value` session cookie it was issued. */
async function signInCookie(server: http.Server, testId: string): Promise<string> {
  const res = await request(server, "POST", "/auth/sign-in/email", SIGN_IN_CREDENTIALS, {
    "x-e2e-test-id": testId,
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = first?.split(";", 1)[0] ?? "";
  expect(cookie).toMatch(/^better-auth\.session_token=.+/);
  return cookie;
}

function sessionTokenOf(cookie: string): string {
  return cookie.split("=", 2)[1] ?? "";
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

describe("Fixture API protocol", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── Health (no auth, no journal) ──────────────────────────────────────────

  it("GET /__e2e/health returns {ok:true} without X-E2E-Test-ID", async () => {
    const res = await request(server, "GET", "/__e2e/health");
    expect(res.status).toBe(200);
    expect(responseData<{ ok: boolean }>(res)).toEqual({ ok: true });
  });

  it("health does not create a journal entry", async () => {
    // Health should NOT require or affect journal
    await request(server, "GET", "/__e2e/health");

    // GET /__e2e/journal without a testId should 400 (not valid for journal)
    const res = await request(server, "GET", "/__e2e/journal?testId=any");
    expect(res.status).toBe(400);
  });

  // ── Missing X-E2E-Test-ID ─────────────────────────────────────────────────

  it("returns 400 for missing X-E2E-Test-ID on fixture routes", async () => {
    const res = await request(server, "GET", "/accounts");
    expect(res.status).toBe(400);
    expect(responseData<{ error: string }>(res).error).toContain("Missing X-E2E-Test-ID");
  });

  it("returns 400 for missing X-E2E-Test-ID on /__e2e/seed", async () => {
    const res = await request(server, "GET", "/__e2e/seed?testId=no-header");
    expect(res.status).toBe(400);
    expect(responseData<{ error: string }>(res).error).toContain("Missing X-E2E-Test-ID");
  });

  it("returns 400 for missing X-E2E-Test-ID on /__e2e/reset without body testId", async () => {
    const res = await request(server, "POST", "/__e2e/reset", { seed: "populated" });
    expect(res.status).toBe(400);
    expect(responseData<{ error: string }>(res).error).toContain("Missing X-E2E-Test-ID");
  });

  // ── Reset isolation ───────────────────────────────────────────────────────

  it("reset creates isolated store for testId", async () => {
    const res = await request(server, "POST", "/__e2e/reset",
      { testId: "iso-a", seed: "populated" },
      { "x-e2e-test-id": "iso-a" },
    );
    expect(res.status).toBe(200);
  });

  it("reset returns ok with testId and seed name", async () => {
    const res = await request(server, "POST", "/__e2e/reset",
      { testId: "info-test", seed: "empty" },
      { "x-e2e-test-id": "info-test" },
    );
    expect(res.status).toBe(200);
    const data = responseData<{ ok: boolean; testId: string; seed: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.testId).toBe("info-test");
    expect(data.seed).toBe("empty");
  });

  it("resets only the requested test store", async () => {
    await request(server, "POST", "/__e2e/reset", { testId: "a", seed: "populated" }, { "x-e2e-test-id": "a" });
    await request(server, "POST", "/__e2e/reset", { testId: "b", seed: "empty" }, { "x-e2e-test-id": "b" });

    const seedA = responseData<SeedData>(await request(server, "GET", "/__e2e/seed?testId=a", undefined, { "x-e2e-test-id": "a" }));
    const seedB = responseData<SeedData>(await request(server, "GET", "/__e2e/seed?testId=b", undefined, { "x-e2e-test-id": "b" }));

    expect(seedA.accounts.length).toBeGreaterThan(0);
    expect(seedB.accounts).toEqual([]);
  });

  it("reset clears journal for that store only", async () => {
    const testId = "journal-clear";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });

    // Make some requests
    await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });
    await request(server, "GET", "/categories", undefined, { "x-e2e-test-id": testId });

    const journalBefore = responseData<Array<unknown>>(
      await request(server, "GET", "/__e2e/journal?testId=journal-clear", undefined, { "x-e2e-test-id": testId }),
    );
    expect(journalBefore.length).toBe(2);

    // Reset
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });

    const journalAfter = responseData<Array<unknown>>(
      await request(server, "GET", "/__e2e/journal?testId=journal-clear", undefined, { "x-e2e-test-id": testId }),
    );
    expect(journalAfter.length).toBe(0);
  });

  it("seed persists between resets (independent stores)", async () => {
    await request(server, "POST", "/__e2e/reset", { testId: "seed-a", seed: "populated" }, { "x-e2e-test-id": "seed-a" });
    await request(server, "POST", "/__e2e/reset", { testId: "seed-b", seed: "empty" }, { "x-e2e-test-id": "seed-b" });

    // Re-reset seed-a with populated
    await request(server, "POST", "/__e2e/reset", { testId: "seed-a", seed: "populated" }, { "x-e2e-test-id": "seed-a" });

    const seedA = responseData<SeedData>(
      await request(server, "GET", "/__e2e/seed?testId=seed-a", undefined, { "x-e2e-test-id": "seed-a" }),
    );
    expect(seedA.accounts.length).toBeGreaterThan(0);
  });

  // ── CORS and preflight ────────────────────────────────────────────────────

  it("CORS headers are set on response", async () => {
    const res = await request(server, "GET", "/__e2e/health");
    expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3000");
    expect(res.headers["access-control-allow-methods"]).toBe("GET,POST,PATCH,DELETE,OPTIONS");
    expect(res.headers["access-control-allow-headers"]).toBe("content-type,authorization,x-e2e-test-id,x-device-token,x-workspace-id,idempotency-key");
  });

  it("OPTIONS preflight returns 204 with proper CORS headers", async () => {
    const port = (server.address() as { port: number }).port;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        method: "OPTIONS",
        path: "/__e2e/health",
        hostname: "127.0.0.1",
        port,
        headers: {
          origin: "http://127.0.0.1:3000",
          "access-control-request-method": "POST",
        },
      }, (response) => resolve(response));
      req.on("error", reject);
      req.end();
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3000");
    expect(res.headers["access-control-allow-methods"]).toBe("GET,POST,PATCH,DELETE,OPTIONS");
  });

  // ── Scenario: status codes (401, 422, 500) ────────────────────────────────

  it("scenario with status 422 returns that status and error shape", async () => {
    const testId = "s-422";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "POST", pathname: "/transactions/expense", status: 422,
    }, { "x-e2e-test-id": testId });

    const res = await request(server, "POST", "/transactions/expense",
      { description: "x", amountCents: 0, categoryId: "", accountId: "", date: "2026-07-17" },
      { "x-e2e-test-id": testId },
    );
    expect(res.status).toBe(422);
    const data = responseData<Record<string, unknown>>(res);
    expect(data.error).toBeDefined();
    expect(data.code).toBe("scenario.error");
  });

  it("scenario with status 401 returns 401", async () => {
    const testId = "s-401";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/accounts", status: 401,
    }, { "x-e2e-test-id": testId });

    const res = await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });
    expect(res.status).toBe(401);
  });

  it("scenario with status 500 returns 500", async () => {
    const testId = "s-500";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/categories", status: 500,
    }, { "x-e2e-test-id": testId });

    const res = await request(server, "GET", "/categories", undefined, { "x-e2e-test-id": testId });
    expect(res.status).toBe(500);
  });

  // ── Scenario: delay ───────────────────────────────────────────────────────

  it("scenario with delayMs waits before responding", async () => {
    const testId = "delay";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/accounts", delayMs: 100,
    }, { "x-e2e-test-id": testId });

    const start = Date.now();
    await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  // ── Scenario: offline (socket abort) ─────────────────────────────────────

  it("scenario with offline destroys socket (no response)", async () => {
    const testId = "offline";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/accounts", offline: true,
    }, { "x-e2e-test-id": testId });

    // Expect connection to be destroyed (request fails)
    await expect(
      request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId }),
    ).rejects.toThrow();
  });

  // ── Scenario: once (single-use) ──────────────────────────────────────────

  it("scenario with once is used only once then falls through to fixture data", async () => {
    const testId = "once";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/accounts", status: 500, once: true,
    }, { "x-e2e-test-id": testId });

    // First request matches scenario → 500
    const r1 = await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });
    expect(r1.status).toBe(500);

    // Second request falls through to fixture → 200 with items
    const r2 = await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });
    expect(r2.status).toBe(200);
    expect(responseData<{ items: unknown[] }>(r2).items).toBeDefined();
  });

  it("non-once scenario matches every request", async () => {
    const testId = "repeat";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/accounts", status: 422,
    }, { "x-e2e-test-id": testId });

    const r1 = await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });
    expect(r1.status).toBe(422);

    const r2 = await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });
    expect(r2.status).toBe(422);
  });

  // ── Scenario: normalized pathname + search ────────────────────────────────

  it("scenario matches pathname with trailing slash stripped", async () => {
    const testId = "trailing";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    // Scenario pathname without trailing slash
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/accounts", status: 418,
    }, { "x-e2e-test-id": testId });

    // Request with trailing slash should still match
    const res = await request(server, "GET", "/accounts/", undefined, { "x-e2e-test-id": testId });
    expect(res.status).toBe(418);
  });

  it("scenario matches pathname from rule with trailing slash stripped", async () => {
    const testId = "trailing-rule";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    // Scenario pathname WITH trailing slash
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/categories/", status: 418,
    }, { "x-e2e-test-id": testId });

    // Request without trailing slash should still match
    const res = await request(server, "GET", "/categories", undefined, { "x-e2e-test-id": testId });
    expect(res.status).toBe(418);
  });

  it("scenario matches exact search params", async () => {
    const testId = "search";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/transactions", search: "limit=10", status: 500,
    }, { "x-e2e-test-id": testId });

    // Request with matching search should hit scenario
    const res1 = await request(server, "GET", "/transactions?limit=10", undefined, { "x-e2e-test-id": testId });
    expect(res1.status).toBe(500);

    // Request without search should not match scenario
    const res2 = await request(server, "GET", "/transactions", undefined, { "x-e2e-test-id": testId });
    expect(res2.status).toBe(200);
  });

  it("scenario without search matches any search params", async () => {
    const testId = "no-search";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/payables", status: 422,
    }, { "x-e2e-test-id": testId });

    const res = await request(server, "GET", "/payables?status=pending", undefined, { "x-e2e-test-id": testId });
    expect(res.status).toBe(422);
  });

  // ── Journal exactness ──────────────────────────────────────────────────────

  it("journal records method, path, body and status for each request", async () => {
    const testId = "journal-exact";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });

    await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });
    await request(server, "GET", "/categories", undefined, { "x-e2e-test-id": testId });
    await request(server, "POST", "/transactions/expense",
      { description: "JournalTest", amountCents: 1000, date: "2026-07-17", categoryId: "cat-1", accountId: "acc-1" },
      { "x-e2e-test-id": testId },
    );

    const journal = responseData<Array<{ method: string; path: string; body: unknown; status: number }>>(
      await request(server, "GET", "/__e2e/journal?testId=journal-exact", undefined, { "x-e2e-test-id": testId }),
    );

    expect(journal.length).toBe(3);
    expect(journal[0]).toMatchObject({ method: "GET", path: "/accounts", status: 200 });
    expect(journal[1]).toMatchObject({ method: "GET", path: "/categories", status: 200 });
    expect(journal[2]).toMatchObject({ method: "POST", path: "/transactions/expense", status: 200 });
    // Body should be recorded (may be parsed JSON)
    expect(journal[2].body).toBeDefined();
  });

  it("journal records the idempotency-key header on scenario and fixture writes", async () => {
    const testId = "journal-idem";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "POST", pathname: "/transactions/expense", status: 500,
    }, { "x-e2e-test-id": testId });

    const forced = await request(server, "POST", "/transactions/expense",
      { description: "retry", amountCents: 100, date: "2026-07-17", categoryId: "cat-1", accountId: "acc-1" },
      { "x-e2e-test-id": testId, "idempotency-key": "cmd-123" },
    );
    expect(forced.status).toBe(500);

    const ok = await request(server, "POST", "/transactions/income",
      { description: "ok", amountCents: 100, date: "2026-07-17", categoryId: "cat-3", accountId: "acc-1" },
      { "x-e2e-test-id": testId, "idempotency-key": "cmd-456" },
    );
    expect(ok.status).toBe(200);

    const journal = responseData<Array<{ method: string; path: string; status: number; idempotencyKey?: string | null }>>(
      await request(server, "GET", "/__e2e/journal?testId=journal-idem", undefined, { "x-e2e-test-id": testId }),
    );
    const expense = journal.find((e) => e.method === "POST" && e.path === "/transactions/expense");
    const income = journal.find((e) => e.method === "POST" && e.path === "/transactions/income");
    expect(expense).toMatchObject({ status: 500, idempotencyKey: "cmd-123" });
    expect(income).toMatchObject({ status: 200, idempotencyKey: "cmd-456" });
  });

  it("journal is scoped per testId", async () => {
    await request(server, "POST", "/__e2e/reset", { testId: "j-a", seed: "populated" }, { "x-e2e-test-id": "j-a" });
    await request(server, "POST", "/__e2e/reset", { testId: "j-b", seed: "populated" }, { "x-e2e-test-id": "j-b" });

    await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": "j-a" });
    await request(server, "GET", "/categories", undefined, { "x-e2e-test-id": "j-b" });

    const journalA = responseData<Array<unknown>>(
      await request(server, "GET", "/__e2e/journal?testId=j-a", undefined, { "x-e2e-test-id": "j-a" }),
    );
    const journalB = responseData<Array<unknown>>(
      await request(server, "GET", "/__e2e/journal?testId=j-b", undefined, { "x-e2e-test-id": "j-b" }),
    );

    expect(journalA.length).toBe(1);
    expect(journalB.length).toBe(1);
    expect(journalA).not.toEqual(journalB);
  });

  // ── Scenario records journal entry ─────────────────────────────────────────

  it("scenario response is recorded in journal", async () => {
    const testId = "s-journal";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/scenario", {
      testId, method: "GET", pathname: "/accounts", status: 503,
    }, { "x-e2e-test-id": testId });

    await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });

    const journal = responseData<Array<{ method: string; path: string; status: number }>>(
      await request(server, "GET", "/__e2e/journal?testId=s-journal", undefined, { "x-e2e-test-id": testId }),
    );
    expect(journal.length).toBe(1);
    expect(journal[0].method).toBe("GET");
    expect(journal[0].path).toBe("/accounts");
    expect(journal[0].status).toBe(503);
  });

  // ── Fixture responses ──────────────────────────────────────────────────────

  it("GET /accounts returns {items, total} with populated seed", async () => {
    const testId = "list";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });

    const res = await request(server, "GET", "/accounts", undefined, { "x-e2e-test-id": testId });
    expect(res.status).toBe(200);
    const data = responseData<{ items: unknown[]; total: number }>(res);
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe("number");
    expect(data.items.length).toBe(2);
  });

  it("DELETE /transactions/:id returns 204 No Content", async () => {
    const testId = "del";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });

    const res = await request(server, "DELETE", "/transactions/tx-1", undefined, { "x-e2e-test-id": testId });
    expect(res.status).toBe(204);
    expect(res.data).toBeUndefined();
  });

  it("POST /auth/sign-in/email issues a distinct unpredictable HttpOnly session cookie per testId", async () => {
    await request(server, "POST", "/__e2e/reset", { testId: "cookie-a", seed: "empty" }, { "x-e2e-test-id": "cookie-a" });
    await request(server, "POST", "/__e2e/reset", { testId: "cookie-b", seed: "empty" }, { "x-e2e-test-id": "cookie-b" });

    const raw = await request(
      server,
      "POST",
      "/auth/sign-in/email",
      SIGN_IN_CREDENTIALS,
      { "x-e2e-test-id": "cookie-a" },
    );
    expect(raw.status).toBe(200);
    const rawCookies = raw.headers["set-cookie"];
    const rawHeader = Array.isArray(rawCookies) ? rawCookies.join("; ") : rawCookies ?? "";
    expect(rawHeader).toMatch(/better-auth\.session_token=[^;]+/);
    expect(rawHeader).toMatch(/HttpOnly/i);
    expect(rawHeader).toMatch(/SameSite=Lax/i);

    const cookieA = await signInCookie(server, "cookie-a");
    const cookieB = await signInCookie(server, "cookie-b");
    const tokenA = sessionTokenOf(cookieA);
    const tokenB = sessionTokenOf(cookieB);
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    expect(tokenA).not.toBe("e2e-session-1");
    expect(tokenA).not.toBe(tokenB);
  });

  it("GET /auth/session requires the issued cookie and resolves the signed-in user", async () => {
    const testId = "auth-session";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });

    const anonymous = await request(server, "GET", "/auth/session", undefined, { "x-e2e-test-id": testId });
    expect(anonymous.status).toBe(401);

    const cookie = await signInCookie(server, testId);
    const token = sessionTokenOf(cookie);

    const authenticated = await request(
      server,
      "GET",
      "/auth/session",
      undefined,
      { "x-e2e-test-id": testId, cookie },
    );
    expect(authenticated.status).toBe(200);
    expect(responseData<{ user: { id: string; email: string }; session: { id: string } }>(authenticated)).toMatchObject({
      user: { id: "e2e-user-1", email: "test@example.com" },
      session: { id: token },
    });
  });

  it("POST /auth/agent-token requires a fixture session and binds the token response to the workspace", async () => {
    const testId = "auth-agent-token";
    const workspaceId = "e2e-household-001";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });

    const anonymous = await request(
      server,
      "POST",
      "/auth/agent-token",
      undefined,
      { "x-e2e-test-id": testId, "x-workspace-id": workspaceId },
    );
    expect(anonymous.status).toBe(401);

    const cookie = await signInCookie(server, testId);

    const authenticated = await request(
      server,
      "POST",
      "/auth/agent-token",
      undefined,
      { "x-e2e-test-id": testId, "x-workspace-id": workspaceId, cookie },
    );
    expect(authenticated.status).toBe(200);
    expect(responseData<{ token: string; expiresIn: number; workspace: string; role: string }>(authenticated)).toEqual({
      token: "e2e-agent-connection-token",
      expiresIn: 120,
      workspace: workspaceId,
      role: "owner",
    });
  });

  it("GET /auth/session rejects foreign cookies with no sign-in (testId-scoped activation)", async () => {
    const testId = "auth-session-inactive";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });

    // Neither the legacy static value nor a random token authenticates
    // a testId that never signed in.
    for (const cookie of [
      "better-auth.session_token=e2e-session-1",
      "better-auth.session_token=00000000-0000-4000-8000-000000000000",
    ]) {
      const res = await request(server, "GET", "/auth/session", undefined, {
        "x-e2e-test-id": testId,
        cookie,
      });
      expect(res.status).toBe(401);
    }
  });

  it("POST /auth/sign-out revokes the testId session, clears the cookie, and the old cookie gets 401", async () => {
    const testId = "auth-sign-out";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    const cookie = await signInCookie(server, testId);
    const token = sessionTokenOf(cookie);

    const before = await request(server, "GET", "/auth/session", undefined, {
      "x-e2e-test-id": testId,
      cookie,
    });
    expect(before.status).toBe(200);

    const signOut = await request(server, "POST", "/auth/sign-out", undefined, {
      "x-e2e-test-id": testId,
      cookie,
    });
    expect(signOut.status).toBe(200);
    expect(responseData<{ success: boolean }>(signOut)).toEqual({ success: true });
    const cookies = signOut.headers["set-cookie"];
    const clearedCookie = Array.isArray(cookies) ? cookies.join("; ") : cookies ?? "";
    expect(clearedCookie).toMatch(/better-auth\.session_token=/i);
    expect(clearedCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);

    const after = await request(server, "GET", "/auth/session", undefined, {
      "x-e2e-test-id": testId,
      cookie,
    });
    expect(after.status).toBe(401);

    // The revocation is journaled as success with boolean cookie evidence
    // only — never the raw cookie or token value.
    const journal = responseData<Array<{ method: string; path: string; status: number; body: unknown }>>(
      await request(server, "GET", "/__e2e/journal?testId=auth-sign-out", undefined, { "x-e2e-test-id": testId }),
    );
    const entry = journal.find((e) => e.method === "POST" && e.path === "/auth/sign-out");
    expect(entry).toMatchObject({ status: 200, body: { hadCookie: true, revoked: true } });
    expect(JSON.stringify(journal)).not.toContain(token);
  });

  it("POST /auth/sign-out with a foreign or missing cookie never revokes the active session", async () => {
    const testId = "auth-sign-out-foreign";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    const cookie = await signInCookie(server, testId);

    const foreign = await request(server, "POST", "/auth/sign-out", undefined, {
      "x-e2e-test-id": testId,
      cookie: "better-auth.session_token=00000000-0000-4000-8000-000000000000",
    });
    expect(foreign.status).toBe(200);

    const missing = await request(server, "POST", "/auth/sign-out", undefined, {
      "x-e2e-test-id": testId,
    });
    expect(missing.status).toBe(200);

    // The active session survives both attempts.
    const intact = await request(server, "GET", "/auth/session", undefined, {
      "x-e2e-test-id": testId,
      cookie,
    });
    expect(intact.status).toBe(200);

    const journal = responseData<Array<{ method: string; path: string; status: number; body: unknown }>>(
      await request(server, "GET", "/__e2e/journal?testId=auth-sign-out-foreign", undefined, { "x-e2e-test-id": testId }),
    );
    const entries = journal.filter((e) => e.method === "POST" && e.path === "/auth/sign-out");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ status: 200, body: { hadCookie: true, revoked: false } });
    expect(entries[1]).toMatchObject({ status: 200, body: { hadCookie: false, revoked: false } });
  });

  it("a testId cookie is rejected under another testId; signing out A leaves B authenticated", async () => {
    await request(server, "POST", "/__e2e/reset", { testId: "rev-a", seed: "empty" }, { "x-e2e-test-id": "rev-a" });
    await request(server, "POST", "/__e2e/reset", { testId: "rev-b", seed: "empty" }, { "x-e2e-test-id": "rev-b" });
    const cookieA = await signInCookie(server, "rev-a");
    const cookieB = await signInCookie(server, "rev-b");
    expect(sessionTokenOf(cookieA)).not.toBe(sessionTokenOf(cookieB));

    // Cross-testId replay authenticates nothing, both directions.
    for (const [tid, cookie] of [["rev-a", cookieB], ["rev-b", cookieA]] as const) {
      const crossed = await request(server, "GET", "/auth/session", undefined, {
        "x-e2e-test-id": tid,
        cookie,
      });
      expect(crossed.status).toBe(401);
    }

    await request(server, "POST", "/auth/sign-out", undefined, {
      "x-e2e-test-id": "rev-a",
      cookie: cookieA,
    });

    const revoked = await request(server, "GET", "/auth/session", undefined, {
      "x-e2e-test-id": "rev-a",
      cookie: cookieA,
    });
    expect(revoked.status).toBe(401);

    const untouched = await request(server, "GET", "/auth/session", undefined, {
      "x-e2e-test-id": "rev-b",
      cookie: cookieB,
    });
    expect(untouched.status).toBe(200);
  });

  it("sign-in after sign-out rotates the token: old cookie rejected, new cookie works", async () => {
    const testId = "auth-resign";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });

    const cookie1 = await signInCookie(server, testId);
    await request(server, "POST", "/auth/sign-out", undefined, {
      "x-e2e-test-id": testId,
      cookie: cookie1,
    });
    const revoked = await request(server, "GET", "/auth/session", undefined, {
      "x-e2e-test-id": testId,
      cookie: cookie1,
    });
    expect(revoked.status).toBe(401);

    const cookie2 = await signInCookie(server, testId);
    expect(sessionTokenOf(cookie2)).not.toBe(sessionTokenOf(cookie1));
    const reactivated = await request(server, "GET", "/auth/session", undefined, {
      "x-e2e-test-id": testId,
      cookie: cookie2,
    });
    expect(reactivated.status).toBe(200);

    const stale = await request(server, "GET", "/auth/session", undefined, {
      "x-e2e-test-id": testId,
      cookie: cookie1,
    });
    expect(stale.status).toBe(401);
  });

  it("POST /auth/agent-token rejects a revoked fixture session", async () => {
    const testId = "auth-agent-revoked";
    const workspaceId = "e2e-household-001";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });
    const cookie = await signInCookie(server, testId);

    await request(server, "POST", "/auth/sign-out", undefined, {
      "x-e2e-test-id": testId,
      cookie,
    });

    const res = await request(server, "POST", "/auth/agent-token", undefined, {
      "x-e2e-test-id": testId,
      "x-workspace-id": workspaceId,
      cookie,
    });
    expect(res.status).toBe(401);
  });

  it("POST /auth/devices/register returns {token,deviceId,householdId}", async () => {
    const testId = "auth-reg";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });

    const res = await request(server, "POST", "/auth/devices/register",
      { deviceName: "e2e-test" },
      { "x-e2e-test-id": testId },
    );
    expect(res.status).toBe(200);
    const data = responseData<{ token: string; deviceId: string; householdId: string }>(res);
    expect(typeof data.token).toBe("string");
    expect(data.token.length).toBeGreaterThan(0);
    expect(typeof data.deviceId).toBe("string");
    expect(typeof data.householdId).toBe("string");
  });

  // ── 404 on unknown fixture route ──────────────────────────────────────────

  it("unknown fixture route returns 404", async () => {
    const testId = "notfound";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "empty" }, { "x-e2e-test-id": testId });

    const res = await request(server, "GET", "/nonexistent/route", undefined, { "x-e2e-test-id": testId });
    expect(res.status).toBe(404);
    expect(responseData<{ error: string }>(res).error).toBe("Not found");
  });

  // ── Agent stub (TED pending operations, deterministic) ────────────────────

  async function agentJournal(testId: string): Promise<Array<{ method: string; path: string; status: number; body: unknown }>> {
    const res = await request(server, "GET", `/__e2e/journal?testId=${testId}`, undefined, { "x-e2e-test-id": testId });
    return responseData<Array<{ method: string; path: string; status: number; body: unknown }>>(res);
  }

  it("chat without a script answers a deterministic default turn and journals the intentionId", async () => {
    const testId = "agent-chat-default";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });

    const res = await request(
      server, "POST", "/agents/finance-chat-agent/e2e-household-001/rpc/chat",
      { text: "quanto gastei?", intentionId: "msg-1" },
      { "x-e2e-test-id": testId },
    );
    expect(res.status).toBe(200);
    const turn = responseData<{ turnId: string; status: string; output: string }>(res);
    expect(turn.turnId).toBe("turn-fixture-default");
    expect(turn.status).toBe("completed");
    expect(typeof turn.output).toBe("string");

    const entries = (await agentJournal(testId)).filter((e) => e.path.endsWith("/rpc/chat"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      method: "POST",
      status: 200,
      body: { text: "quanto gastei?", intentionId: "msg-1" },
    });
  });

  it("agent-script programs the chat queue FIFO: 429 then 200, then the default again", async () => {
    const testId = "agent-chat-queue";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });
    const scripted = await request(server, "POST", "/__e2e/agent-script", {
      testId,
      chat: [
        { status: 429, body: { code: "agent.primary_unavailable", message: "primário indisponível" } },
        { status: 200, body: { turnId: "turn-fallback", status: "completed", output: "via fallback" } },
      ],
    }, { "x-e2e-test-id": testId });
    expect(scripted.status).toBe(200);

    const chatPath = "/agents/finance-chat-agent/e2e-household-001/rpc/chat";
    const first = await request(server, "POST", chatPath, { intentionId: "m" }, { "x-e2e-test-id": testId });
    expect(first.status).toBe(429);
    expect(responseData<{ code: string }>(first)).toMatchObject({ code: "agent.primary_unavailable" });

    const second = await request(server, "POST", chatPath, { intentionId: "m" }, { "x-e2e-test-id": testId });
    expect(second.status).toBe(200);
    expect(responseData<{ turnId: string }>(second).turnId).toBe("turn-fallback");

    const third = await request(server, "POST", chatPath, { intentionId: "m" }, { "x-e2e-test-id": testId });
    expect(third.status).toBe(200);
    expect(responseData<{ turnId: string }>(third).turnId).toBe("turn-fixture-default");

    const entries = (await agentJournal(testId)).filter((e) => e.path.endsWith("/rpc/chat"));
    expect(entries.map((e) => e.status)).toEqual([429, 200, 200]);
  });

  it("agent-script rejects malformed programs with 400 and keeps the previous script", async () => {
    const testId = "agent-script-bad";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });

    for (const bad of [
      { chat: "nope" },
      { chat: [{ status: "429", body: {} }] },
      { chat: [{ status: 200, body: [] }] },
      { decisions: [] },
      { decisions: { "op:confirm": null } },
      { active: {} },
    ]) {
      const res = await request(server, "POST", "/__e2e/agent-script", { testId, ...bad }, { "x-e2e-test-id": testId });
      expect(res.status).toBe(400);
    }

    // Nothing was stored: chat still answers the default.
    const chatPath = "/agents/finance-chat-agent/e2e-household-001/rpc/chat";
    const res = await request(server, "POST", chatPath, {}, { "x-e2e-test-id": testId });
    expect(res.status).toBe(200);
    expect(responseData<{ turnId: string }>(res).turnId).toBe("turn-fixture-default");
  });

  it("decision defaults: confirm/retry succeed with a receipt, cancel cancels, unknown is 422", async () => {
    const testId = "agent-decision-defaults";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });
    const decisionPath = (op: string): string =>
      `/agents/finance-chat-agent/e2e-household-001/rpc/pending-operations/${op}/decision`;
    type Receipt = {
      mutationId?: unknown;
      mutationKind?: unknown;
      status?: unknown;
      affectedTargets?: unknown;
      operationId?: unknown;
      entity?: { type?: unknown; id?: unknown };
    };
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Canonical receipt binding (strict PWA client contract: operationId names
    // the pending op; receipt.operationId matches it; entity { type:
    // 'transaction', id } names the NEW transaction id — never the pending id).
    const expectCanonicalReceipt = (body: Record<string, unknown>, op: string): string => {
      expect(body.operationId).toBe(op);
      expect(body.status).toBe("succeeded");
      const receipt = body.receipt as Receipt;
      expect(receipt.mutationId).toEqual(expect.any(String));
      expect(receipt.operationId).toBe(op);
      expect(receipt.entity?.type).toBe("transaction");
      expect(typeof receipt.entity?.id).toBe("string");
      expect(receipt.entity?.id as string).toMatch(UUID_RE);
      expect(receipt.entity?.id).not.toBe(op);
      return receipt.entity?.id as string;
    };

    const confirm = await request(server, "POST", decisionPath("op-1"), { decision: "confirm", requestId: "r1" }, { "x-e2e-test-id": testId });
    expect(confirm.status).toBe(200);
    expect(responseData<Record<string, unknown>>(confirm)).toMatchObject({
      operationId: "op-1",
      status: "succeeded",
      receipt: {
        mutationId: "rcpt-op-1",
        mutationKind: "transactions.expense.create",
        status: "succeeded",
        affectedTargets: ["transactions"],
        operationId: "op-1",
      },
    });
    const confirmEntityId = expectCanonicalReceipt(responseData<Record<string, unknown>>(confirm), "op-1");

    const retry = await request(server, "POST", decisionPath("op-2"), { decision: "retry", requestId: "r2" }, { "x-e2e-test-id": testId });
    expect(responseData<Record<string, unknown>>(retry)).toMatchObject({ operationId: "op-2", status: "succeeded" });
    const retryEntityId = expectCanonicalReceipt(responseData<Record<string, unknown>>(retry), "op-2");
    // Keyed per operation: distinct ops mint distinct transaction ids.
    expect(retryEntityId).not.toBe(confirmEntityId);

    // Stable: repeating the same decision replays the same transaction id.
    const confirmAgain = await request(server, "POST", decisionPath("op-1"), { decision: "confirm", requestId: "r1b" }, { "x-e2e-test-id": testId });
    expect(expectCanonicalReceipt(responseData<Record<string, unknown>>(confirmAgain), "op-1")).toBe(confirmEntityId);

    // Keyed per test: the same op in another test mints another id (no cross-test binding).
    const otherTestId = "agent-decision-defaults-other";
    await request(server, "POST", "/__e2e/reset", { testId: otherTestId, seed: "populated" }, { "x-e2e-test-id": otherTestId });
    const other = await request(server, "POST", decisionPath("op-1"), { decision: "confirm", requestId: "r1" }, { "x-e2e-test-id": otherTestId });
    expect(expectCanonicalReceipt(responseData<Record<string, unknown>>(other), "op-1")).not.toBe(confirmEntityId);

    const cancel = await request(server, "POST", decisionPath("op-3"), { decision: "cancel", requestId: "r3" }, { "x-e2e-test-id": testId });
    expect(responseData<Record<string, unknown>>(cancel)).toEqual({ operationId: "op-3", status: "cancelled" });

    const unknown = await request(server, "POST", decisionPath("op-4"), { decision: "approve", requestId: "r4" }, { "x-e2e-test-id": testId });
    expect(unknown.status).toBe(422);
    expect(responseData<{ code: string }>(unknown).code).toBe("agent.unknown_decision");

    const entries = (await agentJournal(testId)).filter((e) => e.path.endsWith("/decision"));
    expect(entries.map((e) => (e.body as { decision: string }).decision)).toEqual(["confirm", "retry", "confirm", "cancel", "approve"]);
    expect(entries.map((e) => e.status)).toEqual([200, 200, 200, 200, 422]);
  });

  it("scripted decisions override the defaults by <opId>:<decision> key", async () => {
    const testId = "agent-decision-scripted";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });
    await request(server, "POST", "/__e2e/agent-script", {
      testId,
      decisions: {
        "op-9:confirm": { status: 200, body: { operationId: "op-9", status: "failed", retryable: true } },
      },
    }, { "x-e2e-test-id": testId });

    const path = "/agents/finance-chat-agent/e2e-household-001/rpc/pending-operations/op-9/decision";
    const res = await request(server, "POST", path, { decision: "confirm", requestId: "r" }, { "x-e2e-test-id": testId });
    expect(res.status).toBe(200);
    expect(responseData<Record<string, unknown>>(res)).toEqual({ operationId: "op-9", status: "failed", retryable: true });

    // Other keys keep the defaults.
    const other = await request(server, "POST", path, { decision: "cancel", requestId: "r" }, { "x-e2e-test-id": testId });
    expect(responseData<Record<string, unknown>>(other)).toEqual({ operationId: "op-9", status: "cancelled" });
  });

  it("active list defaults to empty and serves the scripted ops verbatim", async () => {
    const testId = "agent-active";
    await request(server, "POST", "/__e2e/reset", { testId, seed: "populated" }, { "x-e2e-test-id": testId });
    const activePath = "/agents/finance-chat-agent/e2e-household-001/rpc/pending-operations/active";

    const empty = await request(server, "GET", activePath, undefined, { "x-e2e-test-id": testId });
    expect(empty.status).toBe(200);
    expect(responseData<{ items: unknown[]; total: number }>(empty)).toEqual({ items: [], total: 0 });

    const op = { id: "op-1", status: "proposed", tool: "transactions.expense.create", createdAt: "2026-07-17T12:00:00.000Z", expiresAt: "2026-07-18T12:00:00.000Z" };
    await request(server, "POST", "/__e2e/agent-script", { testId, active: [op] }, { "x-e2e-test-id": testId });
    const filled = await request(server, "GET", activePath, undefined, { "x-e2e-test-id": testId });
    expect(responseData<{ items: unknown[]; total: number }>(filled)).toEqual({ items: [op], total: 1 });
  });

  it("agent scripts are isolated per testId and cleared by reset", async () => {
    const chatPath = "/agents/finance-chat-agent/e2e-household-001/rpc/chat";
    await request(server, "POST", "/__e2e/reset", { testId: "agent-iso-a", seed: "populated" }, { "x-e2e-test-id": "agent-iso-a" });
    await request(server, "POST", "/__e2e/reset", { testId: "agent-iso-b", seed: "populated" }, { "x-e2e-test-id": "agent-iso-b" });
    await request(server, "POST", "/__e2e/agent-script", {
      testId: "agent-iso-a",
      chat: [{ status: 200, body: { turnId: "turn-a", status: "completed" } }],
    }, { "x-e2e-test-id": "agent-iso-a" });

    const a = await request(server, "POST", chatPath, {}, { "x-e2e-test-id": "agent-iso-a" });
    expect(responseData<{ turnId: string }>(a).turnId).toBe("turn-a");
    const b = await request(server, "POST", chatPath, {}, { "x-e2e-test-id": "agent-iso-b" });
    expect(responseData<{ turnId: string }>(b).turnId).toBe("turn-fixture-default");

    await request(server, "POST", "/__e2e/reset", { testId: "agent-iso-a", seed: "populated" }, { "x-e2e-test-id": "agent-iso-a" });
    const cleared = await request(server, "POST", chatPath, {}, { "x-e2e-test-id": "agent-iso-a" });
    expect(responseData<{ turnId: string }>(cleared).turnId).toBe("turn-fixture-default");
  });
});
