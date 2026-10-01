/**
 * Fixture API — deterministic HTTP server for PWA E2E tests.
 * Listens on configurable port (default 4010).
 *
 * CLI: tsx e2e/fixture-api/server.ts [--port 4010 | --port=4010]
 *
 * Endpoints (control, no auth required):
 *   GET  /__e2e/health          → {ok:true}  (no X-E2E-Test-ID needed)
 *   POST /__e2e/reset           → {testId,seed} reset store
 *   POST /__e2e/scenario        → {testId,method,pathname,search?,delayMs?,status?,offline?,once?}
 *   GET  /__e2e/journal?testId= → journal entries for that testId
 *   GET  /__e2e/seed?testId=    → current deterministic fixture state
 *   POST /__e2e/agent-script    → program deterministic Agent-stub replies
 *                                {testId?, chat?, decisions?, active?}
 *
 * Endpoints (fixture, require X-E2E-Test-ID):
 *   ALL  /*                     → fixture responses or scenario-matched behavior
 *
 * Agent stub (deterministic, loopback — no LLM, no external network):
 *   POST /agents/finance-chat-agent/:ws/rpc/chat
 *   POST /agents/finance-chat-agent/:ws/rpc/pending-operations/:op/decision
 *   GET  /agents/finance-chat-agent/:ws/rpc/pending-operations/active
 *
 * CORS: origin http://127.0.0.1:3000
 * Fixed clock: 2026-07-17T12:00:00.000Z
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { StoreManager, SEEDS, generateId, type JournalEntry, type ScenarioRule, type TestStore, type AgentStubChatResponse } from "./store";

function resolveHarnessPortForCors(): number {
  const raw = process.env.E2E_HARNESS_PORT;
  if (raw === undefined || raw === "") return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`[e2e-ports] invalid E2E_HARNESS_PORT=${JSON.stringify(raw)}`);
  }
  return n;
}
const ALLOWED_ORIGIN = `http://127.0.0.1:${resolveHarnessPortForCors()}`;
const ALLOWED_METHODS = "GET,POST,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "content-type,authorization,x-e2e-test-id,x-device-token,x-workspace-id,idempotency-key";
const SESSION_COOKIE_NAME = "better-auth.session_token";
const FIXTURE_USER = { id: "e2e-user-1", email: "test@example.com", name: "Test User" };
const E2E_VAPID_PUBLIC_KEY = "BP0vRqqie7zJbfocGhxpZlPf02CVjWkO20vRTtjsXkPaRmarPZtNuNI0h8ias5AbmMDaaVLIgnkHBwMp8MmPQ2s";
const stores = new StoreManager();

// ── CLI port parsing (supports both --port 4010 and --port=4010) ────────────

export function parseCliPort(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--port=")) {
      const val = Number(arg.split("=", 2)[1]);
      if (!Number.isFinite(val)) throw new Error(`Invalid --port value: ${arg}`);
      return val;
    }
    if (arg === "--port" && i + 1 < args.length) {
      const val = Number(args[i + 1]);
      if (!Number.isFinite(val)) throw new Error(`Invalid --port value: ${args[i + 1]}`);
      return val;
    }
  }
  return 4010; // default
}

// ── Shared helpers (no `any`) ───────────────────────────────────────────────

function getTestId(req: http.IncomingMessage): string | null {
  const header = req.headers["x-e2e-test-id"];
  if (Array.isArray(header)) return header[0] ?? null;
  return header ?? null;
}

/**
 * Extract the presented session token from the Cookie header (name match
 * only — the value is opaque). Returns null when the cookie is absent.
 */
function getSessionCookieToken(req: http.IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(idx + 1).trim();
      return value ? value : null;
    }
  }
  return null;
}

/**
 * Better Auth-modeled validity: the presented cookie only authenticates when
 * it equals this testId's active session token (minted at sign-in, cleared
 * at sign-out). A foreign, stale, or never-issued token is rejected like an
 * unknown or expired server session — the holder learns nothing beyond
 * rejection, and no testId can authenticate with another's cookie.
 */
function hasValidFixtureSession(req: http.IncomingMessage, store: TestStore): boolean {
  const presented = getSessionCookieToken(req);
  return store.sessionToken !== null && presented === store.sessionToken;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function getIdempotencyKey(req: http.IncomingMessage): string | null {
  const header = req.headers["idempotency-key"];
  if (Array.isArray(header)) return header[0] ?? null;
  if (typeof header === "string" && header.trim() !== "") return header;
  return null;
}

function journalPush(testId: string, method: string, path: string, body: unknown, status: number, idempotencyKey?: string | null): void {
  const store = stores.get(testId);
  if (store) {
    store.journal.push(
      idempotencyKey == null
        ? { method, path, body, status }
        : { method, path, body, status, idempotencyKey },
    );
  }
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

function handleCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  // Required: the PWA apiFetch always sends `credentials: "include"`. Without
  // this header the browser rejects every cross-origin fixture response
  // (net::ERR_FAILED) even though the server processed it — the journal fills
  // while the app sees "Failed to fetch" and AUTH-01 can never pass.
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// ── Scenario matching ───────────────────────────────────────────────────────

function matchScenario(
  store: { scenarios: ScenarioRule[] },
  method: string,
  pathname: string,
  search: string,
): ScenarioRule | undefined {
  for (const rule of store.scenarios) {
    if (rule.once && rule.used) continue;
    if (rule.method !== method) continue;

    // Normalize both paths: strip trailing slash
    const normalizedRulePath = rule.pathname.replace(/\/$/, "");
    const normalizedReqPath = pathname.replace(/\/$/, "");
    if (normalizedReqPath !== normalizedRulePath) continue;

    // If rule has search constraint, match exactly; otherwise any search matches
    if (rule.search !== undefined && rule.search !== search) continue;

    if (rule.once) rule.used = true;

    // Stop on first matching rule (priority by insertion order)
    return rule;
  }
  return undefined;
}

// ── E2E control routes (no testId required for health) ──────────────────────

function handleE2eRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  body: Record<string, unknown> | undefined,
): boolean {
  // Health — no testId required, no journal written
  if (pathname === "/__e2e/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return true;
  }

  // All other control routes require X-E2E-Test-ID
  const testId = getTestId(req);
  if (!testId) {
    sendJson(res, 400, { error: "Missing X-E2E-Test-ID header" });
    return true;
  }

  // Reset
  if (pathname === "/__e2e/reset" && req.method === "POST") {
    const seedName = (body?.seed as string | undefined) ?? "populated";
    const tid = (body?.testId as string | undefined) ?? testId;
    // Validate seed exists
    if (!(seedName in SEEDS)) {
      sendJson(res, 400, { error: `Unknown seed: ${seedName}` });
      return true;
    }
    stores.reset(tid, seedName as keyof typeof SEEDS);
    sendJson(res, 200, { ok: true, testId: tid, seed: seedName });
    return true;
  }

  // Scenario registration
  if (pathname === "/__e2e/scenario" && req.method === "POST") {
    const tid = (body?.testId as string | undefined) ?? testId;
    const store = stores.getOrCreate(tid);
    const method = (body?.method as string | undefined) ?? "GET";
    store.scenarios.push({
      method,
      pathname: body?.pathname as string,
      search: body?.search as string | undefined,
      delayMs: body?.delayMs as number | undefined,
      status: body?.status as number | undefined,
      offline: body?.offline as boolean | undefined,
      once: body?.once as boolean | undefined,
      used: false,
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  // Agent-stub script (TED pending-ops E2E): programs the deterministic
  // replies served by the /agents/finance-chat-agent/* fixture handlers.
  // Body: { testId?, chat?: [{status?, body?}], decisions?: { "<opId>:<decision>": {status?, body?} }, active?: [...] }.
  // Shapes are validated lightly (wrong types → 400); payloads are stored
  // verbatim and served FIFO (chat) or by key (decisions).
  if (pathname === "/__e2e/agent-script" && req.method === "POST") {
    const tid = (body?.testId as string | undefined) ?? testId;
    const store = stores.getOrCreate(tid);
    if (body && typeof body === "object") {
      const fail = (msg: string): boolean => {
        sendJson(res, 400, { error: msg });
        return true;
      };
      const asStubResponse = (value: unknown): AgentStubChatResponse | null => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const rec = value as Record<string, unknown>;
        const status = rec.status === undefined ? 200 : rec.status;
        const respBody = rec.body === undefined ? {} : rec.body;
        if (typeof status !== "number" || !Number.isInteger(status)) return null;
        if (!respBody || typeof respBody !== "object" || Array.isArray(respBody)) return null;
        return { status, body: respBody as Record<string, unknown> };
      };
      if (body.chat !== undefined) {
        if (!Array.isArray(body.chat)) return fail("agent-script: chat must be an array");
        const queue: AgentStubChatResponse[] = [];
        for (const entry of body.chat) {
          const parsed = asStubResponse(entry);
          if (!parsed) return fail("agent-script: chat entries must be {status?, body?}");
          queue.push(parsed);
        }
        store.agentStub.chatQueue = queue;
      }
      if (body.decisions !== undefined) {
        if (!body.decisions || typeof body.decisions !== "object" || Array.isArray(body.decisions)) {
          return fail("agent-script: decisions must be an object");
        }
        const mapped: Record<string, AgentStubChatResponse> = {};
        for (const [key, entry] of Object.entries(body.decisions as Record<string, unknown>)) {
          const parsed = asStubResponse(entry);
          if (!parsed) return fail("agent-script: decision entries must be {status?, body?}");
          mapped[key] = parsed;
        }
        store.agentStub.decisions = mapped;
      }
      if (body.active !== undefined) {
        if (!Array.isArray(body.active)) return fail("agent-script: active must be an array");
        store.agentStub.activeOps = structuredClone(body.active) as Array<Record<string, unknown>>;
      }
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // Journal read
  if (pathname === "/__e2e/journal" && req.method === "GET") {    const tid = testId;
    const store = stores.get(tid);
    const journal: JournalEntry[] = store?.journal ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(journal));
    return true;
  }

  // Seed read
  if (pathname === "/__e2e/seed" && req.method === "GET") {
    const tid = testId;
    const store = stores.get(tid);
    if (!store) {
      sendJson(res, 404, { error: "Test store not found" });
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(store.seed));
    return true;
  }

  return false;
}

// ── Fixture response helpers (fully typed, no `any`) ─────────────────────────

interface Identifiable {
  id: string;
}

function listResponse<T>(items: T[]): { items: T[]; total: number } {
  return { items, total: items.length };
}

function findById<T extends Identifiable>(items: T[], id: string): T | undefined {
  return items.find((i: T) => i.id === id);
}

function removeById<T extends Identifiable>(items: T[], id: string): T | undefined {
  const idx = items.findIndex((i: T) => i.id === id);
  if (idx === -1) return undefined;
  const removed = items[idx];
  items.splice(idx, 1);
  return removed;
}

function mutateById<T extends Identifiable>(items: T[], id: string, patch: Partial<T>): T | undefined {
  const item = items.find((i: T) => i.id === id);
  if (!item) return undefined;
  Object.assign(item, patch);
  return item;
}


// ── Fixture request handler ──────────────────────────────────────────────────

async function handleFixtureRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  body: Record<string, unknown> | undefined,
): Promise<void> {
  const method = req.method ?? "GET";
  const testId = getTestId(req);
  if (!testId) {
    sendJson(res, 400, { error: "Missing X-E2E-Test-ID header" });
    return;
  }

  const store = stores.getOrCreate(testId);

  // Check scenario matching first (before any fixture response)
  const url = new URL(req.url ?? "/", "http://localhost");
  const search = url.searchParams.toString();
  const scenario = matchScenario(store, method, pathname, search);
  if (scenario) {
    if (scenario.delayMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, scenario.delayMs));
    }
    if (scenario.offline) {
      res.destroy();
      return;
    }
    const scenarioStatus = scenario.status ?? 200;
    journalPush(testId, method, pathname, body, scenarioStatus, getIdempotencyKey(req));
    if (scenarioStatus >= 400) {
      sendJson(res, scenarioStatus, { error: "Scenario error", code: "scenario.error", message: "Forced error" });
    } else {
      sendJson(res, scenarioStatus, {});
    }
    return;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  if ((pathname === "/auth/sign-in/email" || pathname === "/auth/sign-in") && method === "POST") {
    // Every sign-in mints a distinct unpredictable token for this testId;
    // re-sign-in rotates (the previous token stops authenticating).
    const token = randomUUID();
    store.sessionToken = token;
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, {
      user: FIXTURE_USER,
      session: { id: token, userId: "e2e-user-1" },
    }, {
      "Set-Cookie": `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax`,
    });
    return;
  }

  if (pathname === "/auth/sign-out" && method === "POST") {
    // Better Auth contract: revocation always succeeds and the response
    // clears the session cookie (expired attributes), even when the caller
    // presented no cookie. Only the presented session is revoked: a foreign
    // or missing token leaves this testId's active session intact (and never
    // touches another testId's store). The journal records boolean cookie
    // evidence only — never the raw cookie or token value.
    const presented = getSessionCookieToken(req);
    const matched = presented !== null && store.sessionToken !== null && presented === store.sessionToken;
    if (matched) store.sessionToken = null;
    journalPush(testId, method, pathname, { hadCookie: presented !== null, revoked: matched }, 200);
    sendJson(res, 200, { success: true }, {
      "Set-Cookie": `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax`,
    });
    return;
  }

  if (pathname === "/auth/session" && method === "GET") {
    if (!hasValidFixtureSession(req, store)) {
      journalPush(testId, method, pathname, body, 401);
      sendJson(res, 401, { code: "auth.missing_session", message: "authenticated session required" });
      return;
    }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, {
      user: FIXTURE_USER,
      session: { id: store.sessionToken, userId: FIXTURE_USER.id },
    });
    return;
  }

  if (pathname === "/auth/agent-token" && method === "POST") {
    if (!hasValidFixtureSession(req, store)) {
      journalPush(testId, method, pathname, body, 401);
      sendJson(res, 401, { code: "auth.session_required", message: "Session required" });
      return;
    }
    const workspaceHeader = req.headers["x-workspace-id"];
    const workspaceId = (Array.isArray(workspaceHeader) ? workspaceHeader[0] : workspaceHeader)?.trim();
    if (!workspaceId) {
      journalPush(testId, method, pathname, body, 400);
      sendJson(res, 400, { code: "auth.workspace_required", message: "Workspace header required" });
      return;
    }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, {
      token: "e2e-agent-connection-token",
      expiresIn: 120,
      workspace: workspaceId,
      role: "owner",
    });
    return;
  }

  if (pathname === "/auth/devices/register" && method === "POST") {
    const registered = store.seed.authRegister ?? {
      token: "e2e-test-token-" + generateId(),
      deviceId: "e2e-device-" + generateId(),
      householdId: "e2e-household-" + generateId(),
    };
    if (!store.seed.authRegister) {
      store.seed.authRegister = registered;
    }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, registered as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/auth/devices/me" && method === "GET") {
    if (!store.seed.authRegister) {
      sendJson(res, 401, { code: "auth.error", message: "Token inválido" });
      return;
    }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, {
      deviceId: store.seed.authRegister.deviceId,
      householdId: store.seed.authRegister.householdId,
    });
    return;
  }

  if (pathname === "/auth/invites/pending-me" && method === "GET") {
    // Fixture has no invites; empty set keeps the home bootstrap quiet
    // (a 404 here logs a console error that trips the e2e failure guard).
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { items: [], total: 0 });
    return;
  }

  // ── Web Push (real-browser fixture boundary) ───────────────────────────────
  if (pathname === "/push/vapid-public-key" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { publicKey: E2E_VAPID_PUBLIC_KEY });
    return;
  }
  if (pathname === "/push/subscriptions" && method === "POST") {
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "https://push.example.test/invalid";
    journalPush(testId, method, pathname, body, 201);
    sendJson(res, 201, { id: "push-subscription-e2e", endpoint, active: true, updatedAt: "2026-07-17T12:00:00.000Z" });
    return;
  }
  if (pathname === "/push/subscriptions" && method === "DELETE") {
    journalPush(testId, method, pathname, body, 204);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  if (pathname === "/accounts" && method === "GET") {
    const accountsWithBalance = store.seed.accounts.map((a) => ({
      ...a,
      balanceCents: a.balanceCents ?? a.initialBalanceCents ?? 0,
    }));
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, listResponse(accountsWithBalance) as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/accounts" && method === "POST") {
    const id = "acc-" + generateId();
    const newAcc = {
      id,
      name: (body?.name as string) ?? "New Account",
      kind: ((body?.kind as string) ?? "bank") as "bank" | "cash" | "credit_card",
      initialBalanceCents: (body?.initialBalanceCents as number) ?? 0,
      balanceCents: (body?.balanceCents as number) ?? (body?.initialBalanceCents as number) ?? 0,
    };
    store.seed.accounts.push(newAcc);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, newAcc as unknown as Record<string, unknown>);
    return;
  }

  const accIdMatch = pathname.match(/^\/accounts\/([a-zA-Z0-9_-]+)$/);
  if (accIdMatch && method === "PATCH") {
    const accId = accIdMatch[1];
    const acc = mutateById(store.seed.accounts, accId, { name: (body?.name as string) ?? "" });
    if (!acc) { sendJson(res, 404, { error: "Account not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, acc as unknown as Record<string, unknown>);
    return;
  }

  const accDeactMatch = pathname.match(/^\/accounts\/([a-zA-Z0-9_-]+)\/deactivate$/);
  if (accDeactMatch && method === "POST") {
    const accId = accDeactMatch[1];
    const acc = findById(store.seed.accounts, accId);
    if (!acc) { sendJson(res, 404, { error: "Account not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { ...acc, status: "inactive" } as unknown as Record<string, unknown>);
    return;
  }

  // ── Categories ────────────────────────────────────────────────────────────

  if (pathname === "/categories" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, listResponse(store.seed.categories) as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/categories" && method === "POST") {
    const id = "cat-" + generateId();
    const newCat = {
      id,
      name: (body?.name as string) ?? "New Category",
      kind: ((body?.kind as string) ?? "expense") as "expense" | "income",
      parentId: body?.parentId as string | undefined,
    };
    store.seed.categories.push(newCat);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, newCat as unknown as Record<string, unknown>);
    return;
  }

  const catIdMatch = pathname.match(/^\/categories\/([a-zA-Z0-9_-]+)$/);
  if (catIdMatch && method === "PATCH") {
    const catId = catIdMatch[1];
    const cat = mutateById(store.seed.categories, catId, { name: (body?.name as string) ?? "" });
    if (!cat) { sendJson(res, 404, { error: "Category not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, cat as unknown as Record<string, unknown>);
    return;
  }

  const catDeactMatch = pathname.match(/^\/categories\/([a-zA-Z0-9_-]+)\/deactivate$/);
  if (catDeactMatch && method === "POST") {
    const catId = catDeactMatch[1];
    const cat = findById(store.seed.categories, catId);
    if (!cat) { sendJson(res, 404, { error: "Category not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { ...cat, status: "inactive" } as unknown as Record<string, unknown>);
    return;
  }

  // ── Transactions ─────────────────────────────────────────────────────────

  if (pathname === "/transactions" && method === "GET") {
    const u = new URL(req.url ?? "/", "http://localhost");
    const kind = u.searchParams.get("kind");
    const limit = u.searchParams.get("limit");
    const offset = u.searchParams.get("offset");
    let items = store.seed.transactions;
    if (kind) items = items.filter((t) => t.kind === kind);
    const total = items.length;
    if (offset) items = items.slice(Number(offset));
    if (limit) items = items.slice(0, Number(limit));
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { items, total } as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/transactions/expense" && method === "POST") {
    const id = "tx-" + generateId();
    const newTx = {
      id,
      description: (body?.description as string) ?? "Expense",
      amountCents: (body?.amountCents as number) ?? 0,
      date: (body?.date as string) ?? "2026-07-17",
      categoryId: (body?.categoryId as string) ?? "",
      accountId: (body?.accountId as string) ?? "",
      kind: "expense" as const,
    };
    store.seed.transactions.push(newTx);
    journalPush(testId, method, pathname, body, 200, getIdempotencyKey(req));
    sendJson(res, 200, newTx as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/transactions/income" && method === "POST") {
    const id = "tx-" + generateId();
    const newTx = {
      id,
      description: (body?.description as string) ?? "Income",
      amountCents: (body?.amountCents as number) ?? 0,
      date: (body?.date as string) ?? "2026-07-17",
      categoryId: (body?.categoryId as string) ?? "",
      accountId: (body?.accountId as string) ?? "",
      kind: "income" as const,
    };
    store.seed.transactions.push(newTx);
    journalPush(testId, method, pathname, body, 200, getIdempotencyKey(req));
    sendJson(res, 200, newTx as unknown as Record<string, unknown>);
    return;
  }

  const txIdMatch = pathname.match(/^\/transactions\/([a-zA-Z0-9_-]+)$/);
  if (txIdMatch) {
    const txId = txIdMatch[1];

    if (method === "PATCH") {
      const tx = mutateById(store.seed.transactions, txId, {
        description: body?.description as string | undefined,
        amountCents: body?.amountCents as number | undefined,
        date: body?.date as string | undefined,
        categoryId: body?.categoryId as string | undefined,
        accountId: body?.accountId as string | undefined,
      });
      if (!tx) { sendJson(res, 404, { error: "Transaction not found" }); return; }
      journalPush(testId, method, pathname, body, 200);
      sendJson(res, 200, tx as unknown as Record<string, unknown>);
      return;
    }

    if (method === "DELETE") {
      const tx = removeById(store.seed.transactions, txId);
      if (!tx) { sendJson(res, 404, { error: "Transaction not found" }); return; }
      journalPush(testId, method, pathname, body, 204);
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // ── Transfers ─────────────────────────────────────────────────────────────

  if (pathname === "/transfers" && method === "POST") {
    const fromAccountId = (body?.fromAccountId as string) ?? "";
    const toAccountId = (body?.toAccountId as string) ?? "";
    if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) {
      journalPush(testId, method, pathname, body, 422, getIdempotencyKey(req));
      sendJson(res, 422, {
        code: "validation_error",
        message: "Contas de origem e destino devem ser distintas",
      });
      return;
    }
    const id = "trf-" + generateId();
    const newTrf = {
      id,
      description: (body?.description as string) ?? "Transfer",
      amountCents: (body?.amountCents as number) ?? 0,
      date: (body?.date as string) ?? "2026-07-17",
      fromAccountId,
      toAccountId,
    };
    store.seed.transfers.push(newTrf);
    journalPush(testId, method, pathname, body, 200, getIdempotencyKey(req));
    sendJson(res, 200, newTrf as unknown as Record<string, unknown>);
    return;
  }

  // ── Cards ─────────────────────────────────────────────────────────────────

  if (pathname === "/cards" && method === "POST") {
    const id = "card-" + generateId();
    const newCard = {
      id,
      name: (body?.name as string) ?? "New Card",
      creditLimitCents: (body?.creditLimitCents as number) ?? 0,
      closingDay: (body?.closingDay as number) ?? 1,
      dueDay: (body?.dueDay as number) ?? 10,
      currentSpendCents: 0,
    };
    store.seed.cardAccounts.push(newCard);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, newCard as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/cards/accounts" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    const items = store.seed.cardAccounts.map((c) => {
      const stmts = (store.seed.cardStatements ?? []).filter((s) => s.accountId === c.id);
      const openOrNewest = stmts.find((s) => s.status === "open") ?? stmts[0];
      const spentCents = c.currentSpendCents ?? openOrNewest?.totalCents ?? 0;
      return {
        ...c,
        kind: "credit_card" as const,
        balanceCents: 0,
        status: "active",
        spentCents,
        pct: (spentCents / (c.creditLimitCents || 1)) * 100,
        purchases: openOrNewest?.purchases ?? [],
        currentStmtId: openOrNewest?.id,
      };
    });
    sendJson(res, 200, listResponse(items) as unknown as Record<string, unknown>);
    return;
  }

  const cardIdMatch = pathname.match(/^\/cards\/([a-zA-Z0-9_-]+)$/);
  if (cardIdMatch && method === "PATCH") {
    const cardId = cardIdMatch[1];
    const card = mutateById(store.seed.cardAccounts, cardId, {
      name: body?.name as string | undefined,
      creditLimitCents: body?.creditLimitCents as number | undefined,
      closingDay: body?.closingDay as number | undefined,
      dueDay: body?.dueDay as number | undefined,
    });
    if (!card) { sendJson(res, 404, { error: "Card not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, card as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/cards/statements" && method === "GET") {
    const u = new URL(req.url ?? "/", "http://localhost");
    const accountId = u.searchParams.get("accountId");
    let items = store.seed.cardStatements;
    if (accountId) items = items.filter((s) => s.accountId === accountId);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, listResponse(items) as unknown as Record<string, unknown>);
    return;
  }

  const stmtIdMatch = pathname.match(/^\/cards\/statements\/([a-zA-Z0-9_-]+)$/);
  if (stmtIdMatch && method === "GET") {
    const stmtId = stmtIdMatch[1];
    const stmt = findById(store.seed.cardStatements, stmtId);
    if (!stmt) { sendJson(res, 404, { error: "Statement not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, stmt as unknown as Record<string, unknown>);
    return;
  }

  const stmtPayMatch = pathname.match(/^\/cards\/statements\/([a-zA-Z0-9_-]+)\/pay$/);
  if (stmtPayMatch && method === "POST") {
    const stmtId = stmtPayMatch[1];
    const stmt = findById(store.seed.cardStatements, stmtId);
    if (!stmt) { sendJson(res, 404, { error: "Statement not found" }); return; }
    const paidAmount = (body?.amountCents as number | undefined) ?? stmt.totalCents;
    stmt.paidCents += paidAmount;
    stmt.status = stmt.paidCents >= stmt.totalCents ? "paid" : "partial";
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, stmt as unknown as Record<string, unknown>);
    return;
  }

  const purMatch = pathname.match(/^\/cards\/purchases\/([a-zA-Z0-9_-]+)$/);
  if (purMatch && method === "PATCH") {
    const purId = purMatch[1];
    for (const stmt of store.seed.cardStatements) {
      const pur = findById(stmt.purchases, purId);
      if (pur) {
        mutateById(stmt.purchases, purId, {
          description: body?.description as string | undefined,
          amountCents: body?.amountCents as number | undefined,
          date: body?.date as string | undefined,
          categoryId: body?.categoryId as string | undefined,
        });
        journalPush(testId, method, pathname, body, 200);
        sendJson(res, 200, stmt as unknown as Record<string, unknown>);
        return;
      }
    }
    sendJson(res, 404, { error: "Purchase not found" });
    return;
  }

  if (pathname === "/cards/installments" && method === "POST") {
    const totalAmount = (body?.totalAmountCents as number) ?? 0;
    const count = (body?.installmentsTotal as number) ?? 1;
    if (count < 2 || count > 48) {
      journalPush(testId, method, pathname, body, 422);
      sendJson(res, 422, {
        code: "validation_error",
        message: "Número de parcelas deve ser entre 2 e 48",
      });
      return;
    }
    const amountPerInstallment = count > 0 ? Math.round(totalAmount / count) : 0;
    const description = (body?.description as string) ?? "";
    const purchaseDate = (body?.purchaseDate as string) ?? "2026-07-17";
    const categoryId = (body?.categoryId as string) ?? "";
    const accountId = (body?.accountId as string) ?? "";
    const items = Array.from({ length: count }, (_, i) => ({
      id: "tx-inst-" + generateId(),
      description: description + ` (${i + 1}/${count})`,
      amountCents: amountPerInstallment,
      date: purchaseDate,
      categoryId,
      accountId,
      kind: "expense" as const,
    }));
    store.seed.transactions.push(...items);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { items } as unknown as Record<string, unknown>);
    return;
  }

  // ── Payables ──────────────────────────────────────────────────────────────

  if (pathname === "/payables" && method === "GET") {
    const u = new URL(req.url ?? "/", "http://localhost");
    const status = u.searchParams.get("status");
    let items = store.seed.payables;
    if (status) items = items.filter((p) => p.status === status);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, listResponse(items) as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/payables" && method === "POST") {
    const id = "pay-" + generateId();
    const newPay = {
      id,
      description: (body?.description as string) ?? "Payable",
      amountCents: (body?.amountCents as number) ?? 0,
      dueDate: (body?.dueDate as string) ?? "2026-07-20",
      status: "pending" as const,
      accountId: (body?.accountId as string) ?? "",
    };
    store.seed.payables.push(newPay);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, newPay as unknown as Record<string, unknown>);
    return;
  }

  const payIdMatch = pathname.match(/^\/payables\/([a-zA-Z0-9_-]+)$/);
  if (payIdMatch && method === "PATCH") {
    const payId = payIdMatch[1];
    const pay = mutateById(store.seed.payables, payId, {
      description: body?.description as string | undefined,
      amountCents: body?.amountCents as number | undefined,
      dueDate: body?.dueDate as string | undefined,
      accountId: body?.accountId as string | undefined,
    });
    if (!pay) { sendJson(res, 404, { error: "Payable not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, pay as unknown as Record<string, unknown>);
    return;
  }

  const payActionMatch = pathname.match(/^\/payables\/([a-zA-Z0-9_-]+)\/(pay|unpay|cancel)$/);
  if (payActionMatch && method === "POST") {
    const payId = payActionMatch[1];
    const action = payActionMatch[2];
    const pay = findById(store.seed.payables, payId);
    if (!pay) { sendJson(res, 404, { error: "Payable not found" }); return; }

    if (action === "pay") {
      pay.status = "paid";
      pay.paidDate = (body?.paidDate as string | undefined) ?? "2026-07-17";
    } else if (action === "unpay") {
      pay.status = "pending";
      pay.paidDate = undefined;
    } else if (action === "cancel") {
      pay.status = "cancelled";
    }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, pay as unknown as Record<string, unknown>);
    return;
  }

  // ── Budgets ───────────────────────────────────────────────────────────────

  if (pathname === "/budgets" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, listResponse(store.seed.budgets) as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/budgets" && method === "POST") {
    const id = "bud-" + generateId();
    const newBud = {
      id,
      name: (body?.name as string) ?? "Budget",
      amountCents: (body?.amountCents as number) ?? 0,
      categoryId: (body?.categoryId as string) ?? "",
      period: ((body?.period as string) ?? "monthly") as "monthly" | "quarterly" | "yearly",
      startDate: (body?.startDate as string) ?? "2026-07-01",
      spentCents: 0,
    };
    store.seed.budgets.push(newBud);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, newBud as unknown as Record<string, unknown>);
    return;
  }

  const budIdMatch = pathname.match(/^\/budgets\/([a-zA-Z0-9_-]+)$/);
  if (budIdMatch && method === "PATCH") {
    const budId = budIdMatch[1];
    const bud = mutateById(store.seed.budgets, budId, {
      amountCents: body?.amountCents as number | undefined,
    });
    if (!bud) { sendJson(res, 404, { error: "Budget not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, bud as unknown as Record<string, unknown>);
    return;
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  if (pathname === "/goals" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, listResponse(store.seed.goals) as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/goals" && method === "POST") {
    const id = "goal-" + generateId();
    const newGoal = {
      id,
      name: (body?.name as string) ?? "Goal",
      goalType: ((body?.goalType as string) ?? "savings") as "savings" | "purchase" | "debt_payoff" | "emergency_fund",
      targetAmountCents: (body?.targetAmountCents as number) ?? 0,
      currentAmountCents: 0,
      startDate: (body?.startDate as string) ?? "2026-07-01",
      status: "active" as const,
    };
    store.seed.goals.push(newGoal);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, newGoal as unknown as Record<string, unknown>);
    return;
  }

  const goalIdMatch = pathname.match(/^\/goals\/([a-zA-Z0-9_-]+)$/);
  if (goalIdMatch && method === "PATCH") {
    const goalId = goalIdMatch[1];
    const goal = mutateById(store.seed.goals, goalId, {
      name: body?.name as string | undefined,
      targetAmountCents: body?.targetAmountCents as number | undefined,
    });
    if (!goal) { sendJson(res, 404, { error: "Goal not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, goal as unknown as Record<string, unknown>);
    return;
  }

  const goalActionMatch = pathname.match(/^\/goals\/([a-zA-Z0-9_-]+)\/(contribute|cancel)$/);
  if (goalActionMatch && method === "POST") {
    const goalId = goalActionMatch[1];
    const action = goalActionMatch[2];
    const goal = findById(store.seed.goals, goalId);
    if (!goal) { sendJson(res, 404, { error: "Goal not found" }); return; }

    if (action === "contribute") {
      goal.currentAmountCents += (body?.amountCents as number) ?? 0;
    } else if (action === "cancel") {
      goal.status = "cancelled";
    }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, goal as unknown as Record<string, unknown>);
    return;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  if (pathname === "/subscriptions" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, listResponse(store.seed.subscriptions) as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/subscriptions" && method === "POST") {
    const id = "sub-" + generateId();
    const newSub = {
      id,
      name: (body?.name as string) ?? "Subscription",
      amountCents: (body?.amountCents as number) ?? 0,
      cycle: ((body?.cycle as string) ?? "monthly") as "monthly" | "yearly" | "weekly",
      day: (body?.day as number) ?? 1,
      paymentMethod: (body?.paymentMethod as string) ?? "credit_card",
      status: "active" as const,
    };
    store.seed.subscriptions.push(newSub);
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, newSub as unknown as Record<string, unknown>);
    return;
  }

  const subIdMatch = pathname.match(/^\/subscriptions\/([a-zA-Z0-9_-]+)$/);
  if (subIdMatch && method === "PATCH") {
    const subId = subIdMatch[1];
    const sub = mutateById(store.seed.subscriptions, subId, {
      name: body?.name as string | undefined,
      amountCents: body?.amountCents as number | undefined,
      cycle: body?.cycle as "monthly" | "yearly" | "weekly" | undefined,
      day: body?.day as number | undefined,
      paymentMethod: body?.paymentMethod as string | undefined,
    });
    if (!sub) { sendJson(res, 404, { error: "Subscription not found" }); return; }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, sub as unknown as Record<string, unknown>);
    return;
  }

  const subCancelMatch = pathname.match(/^\/subscriptions\/([a-zA-Z0-9_-]+)\/cancel$/);
  if (subCancelMatch && method === "POST") {
    const subId = subCancelMatch[1];
    const sub = findById(store.seed.subscriptions, subId);
    if (!sub) { sendJson(res, 404, { error: "Subscription not found" }); return; }
    sub.status = "cancelled";
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, sub as unknown as Record<string, unknown>);
    return;
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  if (pathname === "/profile" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    const profile = store.seed.profile;
    sendJson(res, 200, { profile } as Record<string, unknown>);
    return;
  }

  if (pathname === "/profile" && method === "PATCH") {
    if (!store.seed.profile) {
      store.seed.profile = {
        name: (body?.name as string) ?? "User",
        email: (body?.email as string) ?? "",
        avatarColor: (body?.avatarColor as string) ?? "#3B82F6",
        greetingStyle: (body?.greetingStyle as string) ?? "formal",
      };
    } else {
      if (body?.name !== undefined) store.seed.profile.name = body.name as string;
      if (body?.email !== undefined) store.seed.profile.email = body.email as string;
      if (body?.avatarColor !== undefined) store.seed.profile.avatarColor = body.avatarColor as string;
      if (body?.greetingStyle !== undefined) store.seed.profile.greetingStyle = body.greetingStyle as string;
    }
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { profile: store.seed.profile } as Record<string, unknown>);
    return;
  }

  // ── Insights ──────────────────────────────────────────────────────────────

  if (pathname === "/insights/quick" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { items: store.seed.quickInsights } as Record<string, unknown>);
    return;
  }

  // ── Dashboard summary ──────────────────────────────────────────────────────

  if (pathname === "/dashboard/summary" && method === "GET") {
    const accounts = store.seed.accounts ?? [];
    const txs = store.seed.transactions ?? [];
    const totalBalanceCents = accounts.reduce((sum, a) => sum + (a.initialBalanceCents ?? 0), 0);
    const monthExpenseCents = txs.reduce((sum, t) => (t.kind === "expense" ? sum + t.amountCents : sum), 0);
    const monthIncomeCents = txs.reduce((sum, t) => (t.kind === "income" ? sum + t.amountCents : sum), 0);
    const toCategoryLabel = (categoryId: string | undefined): string => {
      const cat = store.seed.categories?.find((c) => c.id === categoryId);
      return cat?.name ?? categoryId ?? "";
    };
    const summary = {
      householdId: store.seed.householdId ?? "e2e-household-001",
      generatedAt: new Date().toISOString(),
      totalBalanceCents,
      monthIncomeCents,
      monthExpenseCents,
      monthNetCents: monthIncomeCents - monthExpenseCents,
      cashFlowLast30DaysCents: 0,
      topExpenses: txs
        .filter((t) => t.kind === "expense")
        .slice(0, 5)
        .map((t) => ({
          transactionId: t.id,
          description: t.description,
          amountCents: t.amountCents,
          date: t.date,
          categoryName: toCategoryLabel(t.categoryId),
        })),
      topExpenseCategories: [],
      topIncomeCategories: [],
      monthOverMonth: {
        incomeChangePercent: null,
        expenseChangePercent: null,
        netChangeCents: 0,
      },
      alerts: [],
    };
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, summary as unknown as Record<string, unknown>);
    return;
  }

  // ── Observability / adoption ───────────────────────────────────────────────

  if (pathname === "/observability/adoption-funnel" && method === "GET") {
    const funnel = {
      from: "2026-06-01",
      to: "2026-07-31",
      delivered: 4,
      opened: 2,
      chatUsed: 1,
      capturesStarted: 1,
      capturesCompleted: 0,
      openRate: 0.5,
      chatRate: 0.25,
      captureStartRate: 0.25,
      captureCompletionRate: 0,
      captureDurationMedianMs: null,
      captureDurationP95Ms: null,
    };
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, funnel as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/observability/adoption-events" && method === "POST") {
    journalPush(testId, method, pathname, body, 201);
    sendJson(res, 201, { ok: true });
    return;
  }

  // ── Home bootstrap stubs ─────────────────────────────────────────────────
  // The authenticated home fires these on load. The fixture has no data for
  // them; empty-but-valid shapes keep the bootstrap quiet (a 404 here logs a
  // console error that trips the e2e failure guard).

  if (pathname === "/workspaces" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, {
      items: [
        {
          id: store.seed.householdId || "e2e-household-001",
          name: "Casa",
          kind: "personal",
          role: "owner",
          status: "active",
        },
      ],
      total: 1,
    } as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/pending-operations" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { items: [], total: 0 });
    return;
  }

  if (pathname === "/analytics/kpis" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, {
      period: { from: "2026-06-17", to: "2026-07-17" },
      previousPeriod: { from: "2026-05-18", to: "2026-06-16" },
      netLiquidBalanceCents: 520000,
      accountsTotalCents: 520000,
      dueSoonCents: 0,
      openInvoices: { committedCents: 0, limitCents: 500000, utilizationPct: 0 },
      savingsRatePct: null,
      savingsRateTargetPct: 20,
      previousSavingsRatePct: null,
      fixedVsDiscretionary: {
        scope: "household",
        fixedCents: 0,
        discretionaryCents: 17500,
        fixedPctOfIncome: null,
        subscriptionsCents: 5590,
      },
      incomeCents: 0,
      expenseCents: 17500,
      previousIncomeCents: 0,
      previousExpenseCents: 0,
      netWorthCents: 520000,
    } as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/analytics/cashflow-series" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, {
      period: { from: "2026-06-17", to: "2026-07-17" },
      current: [],
      previous: [],
    } as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/analytics/category-breakdown" && method === "GET") {
    const kindParam = new URL(req.url ?? "/", "http://localhost").searchParams.get("kind");
    const kind = kindParam === "income" ? "income" : "expense";
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, {
      period: { from: "2026-06-17", to: "2026-07-17" },
      kind,
      totalCents: 0,
      slices: [],
    } as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/analytics/budget-consumption" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { items: [] });
    return;
  }

  if (pathname === "/analytics/daily-heatmap" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { endDate: "2026-07-17", weeks: [] } as unknown as Record<string, unknown>);
    return;
  }

  if (pathname === "/analytics/net-worth-history" && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { months: [] });
    return;
  }

  if (pathname === "/transactions/detect-duplicate" && method === "POST") {
    // Duplicate detector: fixture has no duplicates; report none so the
    // save flow proceeds (a 404 here logs a console error that trips the
    // e2e failure guard in TX-02/TX-03).
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, { duplicate_detected: false });
    return;
  }

  // ── Agent stub (TED pending operations, deterministic) ────────────────────
  // Loopback stand-in for the Agent Worker behind the PWA /api/agent proxy.
  // The E2E spec forwards /api/agent/* here per testId and programs replies
  // via POST /__e2e/agent-script. No LLM, no external network: scripted
  // replies are served verbatim (FIFO for chat, by "<opId>:<decision>" key
  // for decisions); unscripted calls get deterministic defaults. Every call
  // is journaled with method+path+body+status for spec assertions.

  const agentChatMatch = pathname.match(/^\/agents\/finance-chat-agent\/([^/]+)\/rpc\/chat$/);
  if (agentChatMatch && method === "POST") {
    const next = store.agentStub.chatQueue.shift();
    const reply = next ?? {
      status: 200,
      body: {
        turnId: "turn-fixture-default",
        status: "completed",
        output: "Resposta determinística da fixture (sem LLM).",
      },
    };
    journalPush(testId, method, pathname, body, reply.status);
    sendJson(res, reply.status, reply.body);
    return;
  }

  const agentDecisionMatch = pathname.match(
    /^\/agents\/finance-chat-agent\/([^/]+)\/rpc\/pending-operations\/([^/]+)\/decision$/,
  );
  if (agentDecisionMatch && method === "POST") {
    const operationId = agentDecisionMatch[2];
    const decision = typeof body?.decision === "string" ? body.decision : "";
    const scripted = store.agentStub.decisions[`${operationId}:${decision}`];
    if (scripted) {
      journalPush(testId, method, pathname, body, scripted.status);
      sendJson(res, scripted.status, scripted.body);
      return;
    }
    if (decision === "cancel") {
      journalPush(testId, method, pathname, body, 200);
      sendJson(res, 200, { operationId, status: "cancelled" });
      return;
    }
    if (decision === "confirm" || decision === "retry") {
      journalPush(testId, method, pathname, body, 200);
      sendJson(res, 200, {
        operationId,
        status: "succeeded",
        receipt: {
          mutationId: `rcpt-${operationId}`,
          mutationKind: "transactions.expense.create",
          status: "succeeded",
          affectedTargets: ["transactions"],
          operationId,
        },
      });
      return;
    }
    journalPush(testId, method, pathname, body, 422);
    sendJson(res, 422, { code: "agent.unknown_decision", message: "Decisão desconhecida." });
    return;
  }

  const agentActiveMatch = pathname.match(
    /^\/agents\/finance-chat-agent\/([^/]+)\/rpc\/pending-operations\/active$/,
  );
  if (agentActiveMatch && method === "GET") {
    journalPush(testId, method, pathname, body, 200);
    sendJson(res, 200, {
      items: store.agentStub.activeOps,
      total: store.agentStub.activeOps.length,
    });
    return;
  }

  // ── Not found ─────────────────────────────────────────────────────────────

  sendJson(res, 404, { error: "Not found", path: pathname });
}

// ── Server factory ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createServer(port?: number): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS always applied first
    if (handleCors(req, res)) return;

    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    try {
      const body = await parseBody(req);

      // E2E control routes (health, reset, scenario, journal, seed)
      if (handleE2eRoute(req, res, pathname, body)) return;

      // Fixture data routes (auth, accounts, transactions, etc.)
      await handleFixtureRequest(req, res, pathname, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: "Internal fixture error", message });
    }
  });

  return server;
}

// ── CLI entry point ─────────────────────────────────────────────────────────

// When run directly via `tsx e2e/fixture-api/server.ts`
if (process.argv.length > 1 && process.argv[1]?.includes("server")) {
  const port = parseCliPort(process.argv.slice(2));
  const server = createServer(port);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Fixture API listening on http://127.0.0.1:${port}`);
  });
}
