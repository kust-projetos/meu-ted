// P2D synthetic integration read — full bounded chain over loopback only.
//
// Exercised chain (exact):
//   PWA proxy `POST`/`GET` in `route.ts` (B branch, `TED_OPENCODE_GATEWAY_ORIGIN`
//   loopback) + PWA client `fetchAgentHistory` ─▶ loopback TED gateway real
//   (`createGatewayServer`, child process) ─▶ real OpenCode SDK 2.2.4 prompt
//   loop (`session.prompt` in a Node24 child) ─▶ LOCAL scripted
//   OpenAI-compatible stub (loopback, dummy apiKey, zero paid/external
//   inference) ─▶ actual read-only finance tool (`get_month_summary`) ─▶ real
//   `HttpFinanceTransport` ─▶ actual Fastify `buildTestApp` handlers with
//   synthetic in-memory data (June-2026 ledger) ─▶ runtime DTO ─▶ PWA
//   proxy/client.
//
// What is asserted:
//   1. Successful synthetic read with the strict expected DTO/output
//      (output === scripted final text; finance read hit
//      `/dashboard/month-summary` with `yearMonth=2026-06` and returned the
//      June oracle for household A).
//   2. Route/client history reload returns stable same IDs/output with zero
//      new `session.prompt` and zero new transport calls.
//   3. Two synthetic actors/workspaces are isolated (cross-scope denied,
//      never empty fabrication).
//   4. Injected provider error + repeat of the SAME intention: no second
//      `session.prompt`, replayed genuine output (no false success); a NEW
//      intention under failure closes with a typed error and no output.
//   5. API journal: zero POST/PUT/PATCH/DELETE on financial routes.
//
// Seams (test-only, no application edits):
// - Better-Auth identities are SYNTHETIC (`memoryAdapter`, throwaway
//   sign-ups) + real device registration against the in-memory API — the
//   gateway runs the REAL `resolveGatewayIdentity` (no identity seam).
// - `fetchAgentConnectionToken`/`getActiveDeviceToken` mocked for the client
//   (mint is not Better-Auth real); `getCloudflareContext` rejected.
// - The model is a scripted stub (canned SSE tool_call + final text): this is
//   NOT an external-model proof and `READ_SLICE_PASS` remains NOT ACHIEVED.
// - Route/client-level reload is NOT browser-rendered Playwright page reload;
//   browser page reload remains NOT_PROVEN.
// - Egress posture (narrow, honest): the configured provider endpoint is the
//   local loopback stub only (dummy apiKey); unexpected non-loopback fetch
//   calls are intercepted and blocked pre-socket; stub request remotes are
//   asserted loopback. This is NOT a general OS-level egress sandbox — raw
//   `node:http`/`net`/`tls` sockets are not intercepted — and no
//   external/paid inference was configured or called.
// - SDK SQLite lives under the approved temp root.
// - Serial on purpose: ONE `it` executes the whole chain in order
//   (`--pool=forks --maxWorkers=1` style, single flow).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(),
}));

// Workspace scope for the mounted TedChat (component-remount phase): the same
// synthetic household A used by the route-level chain (literal duplicated
// because vi.mock factories cannot reference top-level imports).
const wsState = vi.hoisted(() => ({ id: "00000000-0000-4000-8000-00000000000a" }));

vi.mock("@/lib/auth/workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace-context")>();
  const mockWs = {
    workspaces: [{ id: wsState.id, name: "Casa", kind: "shared" as const, role: "owner" as const }],
    activeWorkspace: { id: wsState.id, name: "Casa", kind: "shared" as const, role: "owner" as const },
    members: [],
    loading: false,
    membersLoading: false,
    error: null,
    selectWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
    refreshMembers: vi.fn(),
    createWorkspace: vi.fn(),
    inviteWorkspace: vi.fn(),
    acceptInvite: vi.fn(),
    removeMember: vi.fn(),
    leave: vi.fn(),
  };
  return {
    ...actual,
    useWorkspace: () => mockWs,
    useWorkspaceSafe: () => mockWs,
  };
});

// Synthetic seam mirror (test-only): the device read by the client after the
// mocked mint. Switched per actor before each client call.
const deviceState = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("@/lib/api/agent-auth", () => ({
  fetchAgentConnectionToken: vi.fn(async () => "conn-p2d-test-only"),
  clearAgentConnectionTokenCache: vi.fn(),
  getActiveDeviceToken: vi.fn(() => deviceState.current),
  trackAgentConnection: vi.fn((external?: AbortSignal | null) => {
    const controller = new AbortController();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return { signal: controller.signal, release: () => undefined };
  }),
}));

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { EXPECTED_AGENT_ORIGIN } from "@/proxy-utils";
import { GET, POST } from "./route";
import { fetchAgentHistory } from "@/lib/api/agent-client";
import { clearTedRuntimeViews, getTedRuntimeView } from "@/lib/api/ted-runtime-view";
import { render, screen } from "@/lib/test-utils";
import userEvent from "@testing-library/user-event";
import { TedChat } from "@/features/ted/TedChat";
// NOTE: `better-auth/adapters/memory` is an API-workspace dependency (not a
// PWA dep), so the adapter is resolved from API context via createRequire and
// imported by file URL. Test-local only; no dependency or config change.
const PWA_ROOT_EARLY = process.cwd();
const API_TEST_APP = path.resolve(PWA_ROOT_EARLY, "../api/tests/test-app.ts");
if (!fs.existsSync(API_TEST_APP)) {
  throw new Error(`p2d: API test-app not found (cwd=${PWA_ROOT_EARLY}): ${API_TEST_APP}`);
}
const apiRequire = createRequire(API_TEST_APP);
const memoryAdapterPath: string = apiRequire.resolve("better-auth/adapters/memory");
const { memoryAdapter } = (await import(pathToFileURL(memoryAdapterPath).href)) as unknown as {
  memoryAdapter: (options: Record<string, unknown[]>) => unknown;
};
type AuthConfig = Parameters<typeof createBetterAuth>[0];
import { createBetterAuth } from "../../../../../../api/src/auth/better-auth.js";
import { buildTestApp } from "../../../../../../api/tests/test-app.js";
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  ACCOUNT_B1,
  CATEGORY_FOOD_A,
  CATEGORY_FOOD_B,
  CATEGORY_RENT_A,
  CATEGORY_SALARY_A,
  HOUSEHOLD_A,
  HOUSEHOLD_B,
  TRANSACTIONS,
} from "../../../../../../api/tests/fixtures/seed.js";

const PWA_ROOT = PWA_ROOT_EARLY;
const HERE = path.resolve(PWA_ROOT, "src/app/api/agent/[...path]");
const PROBE = path.resolve(HERE, "p2d-synthetic-read-probe.mjs");
const TED_RUNTIME_DIR = path.resolve(PWA_ROOT, "../ted-runtime");

// Strict expected finance oracle (same as the API read-slice test).
const ORACLE_A = {
  incomeCents: 1_200_000,
  expenseCents: 288_050,
  balanceCents: 911_950,
  transactionCount: 4,
};

// Scripted stub final text is NOT hardcoded: it is derived by the probe from
// the ACTUAL `get_month_summary` tool-result DTO observed in the SDK's
// follow-up provider request (income/expense/balance/count validated against
// ORACLE_A). The test recomputes the same derivation INDEPENDENTLY here, so
// equality proves DTO → provider-context → PWA output instead of a canned
// string. Byte-identical formatters on both sides by construction.
function formatCentsBRL(cents: number): string {
  const [whole, decimals] = (cents / 100).toFixed(2).split(".");
  return `R$ ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimals}`;
}
const EXPECTED_FINAL_TEXT =
  `SINTESE SINTETICA P2D junho 2026 — gastos ${formatCentsBRL(ORACLE_A.expenseCents)}` +
  ` em ${ORACLE_A.transactionCount} transacoes (receitas ${formatCentsBRL(ORACLE_A.incomeCents)}` +
  `, saldo ${formatCentsBRL(ORACLE_A.balanceCents)}) — sem inferencia externa, sem rede`;
const CHAT_TEXT = "qual foi meu gasto em junho?";
const COMPONENT_TEXT = "componente: quanto gastei em junho?";
const INTENTION_1 = "p2d-intention-read-01";
const INTENTION_2 = "p2d-intention-fail-02";
const INTENTION_3 = "p2d-intention-recover-03";

const CHILD_TIMEOUT_MS = 180000;
const SECRET = "test-secret-that-is-at-least-32-characters";

function probeNode(): string {
  return process.env.TED_PROBE_NODE || process.execPath;
}

function approvedTmpRoot(prefix: string): string {
  const base =
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "Temp", "opencode")
      : os.tmpdir();
  try {
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, `${prefix}-`));
  } catch {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  }
}

type JsonRecord = Record<string, unknown>;

class ServeProc {
  child: ChildProcess;
  stdout = "";
  stderr = "";
  lines: string[] = [];
  ready: JsonRecord = {};
  exited = false;
  exitCode: unknown = null;

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.on("data", (d) => {
      const s = String(d);
      this.stdout += s;
      for (const line of s.split("\n")) {
        if (line.trim()) this.lines.push(line);
      }
    });
    child.stderr?.on("data", (d) => { this.stderr += String(d); });
    child.on("close", (code, signal) => {
      this.exited = true;
      this.exitCode = signal ? `signal:${signal}` : code;
    });
  }

  static async start(env: Record<string, string>, timeoutMs = CHILD_TIMEOUT_MS): Promise<ServeProc> {
    const child = spawn(probeNode(), [PROBE, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const proc = new ServeProc(child);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ready = proc.lines.map((l) => {
        try { return JSON.parse(l) as JsonRecord; } catch { return null; }
      }).find((j) => j && j["phase"] === "serve-ready");
      if (ready) {
        proc.ready = ready;
        return proc;
      }
      if (proc.exited) {
        throw new Error(`serve encerrou antes do ready (exit=${proc.exitCode}): ${proc.stderr.slice(-2000)}`);
      }
      if (Date.now() > deadline) {
        try { child.kill("SIGKILL"); } catch { /* noop */ }
        throw new Error(`serve sem ready em ${timeoutMs}ms: ${proc.stderr.slice(-2000)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async waitForLine(predicate: (j: JsonRecord) => boolean, from: number, timeoutMs: number): Promise<JsonRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = from; i < this.lines.length; i++) {
        try {
          const j = JSON.parse(this.lines[i]) as JsonRecord;
          if (predicate(j)) return j;
        } catch { /* linha não-JSON: ignora */ }
      }
      if (this.exited) throw new Error(`serve encerrou durante comando (exit=${this.exitCode}): ${this.stderr.slice(-2000)}`);
      if (Date.now() > deadline) throw new Error(`serve sem resposta em ${timeoutMs}ms (comando sem ack)`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async cmd(line: string, timeoutMs = 60000): Promise<JsonRecord> {
    const from = this.lines.length;
    const phase = line === "stats" ? "serve-stats" : line === "close" ? "serve-closed" : "serve-ctl";
    const pending = this.waitForLine((j) => j["phase"] === phase, from, timeoutMs);
    this.child.stdin?.write(`${line}\n`);
    return pending;
  }
}

function setCookiesOf(res: Response): string[] {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(res.headers);
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function firstCookieSegment(setCookie: string | null): string {
  const raw = String(setCookie ?? "");
  const first = raw.split(",").map((s) => s.trim()).find((s) => s.length > 0) ?? "";
  return first.split(";")[0]?.trim() ?? "";
}

beforeEach(() => {
  vi.mocked(getCloudflareContext).mockRejectedValue(new Error("no ctx"));
  clearTedRuntimeViews();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearTedRuntimeViews();
});

describe("P2D synthetic read: PWA proxy/client → loopback gateway → real SDK → stub provider → real finance tool → real API", () => {
  it("chat → history reload → isolation → provider-fault replay → component remount → journal", async () => {
    const root = approvedTmpRoot("ted-pwa-p2dread");

    // 1. Real Fastify API (synthetic in-memory ledger) + synthetic Better-Auth.
    const memberships = new Map<string, "owner" | "member">();
    const workspaceAccess = {
      resolve: async (authUserId: string, householdId: string) => {
        if (householdId !== HOUSEHOLD_A && householdId !== HOUSEHOLD_B) return undefined;
        const role = memberships.get(`${authUserId}:${householdId}`);
        if (!role) return undefined;
        return { userId: authUserId, householdId, role, kind: "shared" as const };
      },
    };
    const auth = createBetterAuth({
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }) as AuthConfig["database"],
      disableSignUp: false,
      transaction: false,
      secret: SECRET,
      baseURL: "http://localhost:3001",
      trustedOrigins: ["http://localhost:3000"],
    });
    const built = buildTestApp(
      {
        accounts: [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1],
        categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_SALARY_A, CATEGORY_FOOD_B],
        transactions: TRANSACTIONS,
      },
      auth,
      workspaceAccess,
      false,
    );
    const journal: Array<{ method: string; url: string }> = [];
    built.app.addHook("onRequest", async (req) => {
      journal.push({ method: String(req.method), url: String(req.url).split("?")[0] });
    });
    await built.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = built.app.server.address() as { port: number };
    const apiBase = `http://127.0.0.1:${addr.port}`;

    const closeApi = async (): Promise<void> => {
      await built.app.close().catch(() => {});
      await auth.close().catch(() => {});
    };

    try {
      // 2. Synthetic actors: throwaway sign-ups + real device registration.
      const signUpA = await auth.api.signUpEmail({
        body: { email: "ted-a-p2d@example.test", password: "test-password-123", name: "Ted P2D A" },
        headers: new Headers({ origin: "http://localhost:3000" }),
        asResponse: true,
      });
      expect(signUpA.status).toBe(200);
      const cookieA = firstCookieSegment(signUpA.headers.get("set-cookie"));
      expect(cookieA.length).toBeGreaterThan(0);
      const signUpB = await auth.api.signUpEmail({
        body: { email: "ted-b-p2d@example.test", password: "test-password-123", name: "Ted P2D B" },
        headers: new Headers({ origin: "http://localhost:3000" }),
        asResponse: true,
      });
      expect(signUpB.status).toBe(200);
      const cookieB = firstCookieSegment(signUpB.headers.get("set-cookie"));
      expect(cookieB.length).toBeGreaterThan(0);
      const sessionA = await auth.api.getSession({ headers: new Headers({ cookie: cookieA }) });
      const sessionB = await auth.api.getSession({ headers: new Headers({ cookie: cookieB }) });
      const userA = String(sessionA?.user.id ?? "");
      const userB = String(sessionB?.user.id ?? "");
      expect(userA.length).toBeGreaterThan(0);
      expect(userB.length).toBeGreaterThan(0);
      expect(userB).not.toBe(userA);
      memberships.set(`${userA}:${HOUSEHOLD_A}`, "owner");
      memberships.set(`${userB}:${HOUSEHOLD_B}`, "owner");

      const registerDevice = async (cookie: string, ws: string, name: string) => {
        const res = await fetch(`${apiBase}/auth/devices/register`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, "x-workspace-id": ws },
          body: JSON.stringify({ deviceName: name }),
        });
        expect(res.status).toBe(201);
        return (await res.json()) as { token: string; deviceId: string; householdId: string };
      };
      const regA = await registerDevice(cookieA, HOUSEHOLD_A, "synth device p2d a");
      const regB = await registerDevice(cookieB, HOUSEHOLD_B, "synth device p2d b");
      expect(regA.householdId).toBe(HOUSEHOLD_A);
      expect(regB.householdId).toBe(HOUSEHOLD_B);

      // 3. Child: real gateway + real SDK loop + scripted stub + real transport.
      const serve = await ServeProc.start({
        P2D_CONFIG_JSON: JSON.stringify({
          root,
          identity: "p2d",
          apiBaseUrl: apiBase,
          tedRuntimeDir: TED_RUNTIME_DIR,
          stub: {
            toolName: "get_month_summary",
            toolArgs: { yearMonth: "2026-06" },
            expectedOracle: { yearMonth: "2026-06", ...ORACLE_A },
          },
        }),
      });
      const base = String(serve.ready["base"]);
      expect(base.startsWith("http://127.0.0.1:")).toBe(true);

      const closeServe = async (): Promise<JsonRecord | null> => {
        try {
          return await serve.cmd("close", 60000);
        } catch {
          try { serve.child.kill("SIGKILL"); } catch { /* noop */ }
          return null;
        }
      };

      try {
        vi.stubEnv("NODE_ENV", "test");
        vi.stubEnv("ALLOW_LOCAL_ORIGIN", "1");
        vi.stubEnv("TED_OPENCODE_RUNTIME_ENABLED", "1");
        vi.stubEnv("TED_OPENCODE_GATEWAY_ORIGIN", base);

        const chatPath = (ws: string) => ["agents", "finance-chat-agent", ws, "rpc", "chat"];
        const sessionNewPath = (ws: string) => ["agents", "finance-chat-agent", ws, "rpc", "session", "new"];
        const historyPath = (ws: string) => ["agents", "finance-chat-agent", ws, "rpc", "history"];
        const rpcUrl = (segs: string[]) =>
          `http://localhost:3000/api/agent/${segs.map(encodeURIComponent).join("/")}`;
        const headersFor = (cookie: string, deviceToken: string, ws: string, pin?: string): Record<string, string> => ({
          cookie: pin ? `${cookie}; ${pin}` : cookie,
          "x-device-token": deviceToken,
          "x-workspace-id": ws,
        });
        const postViaRoute = (segs: string[], body: unknown, headers: Record<string, string>): Promise<Response> =>
          POST(
            new Request(rpcUrl(segs), {
              method: "POST",
              headers: { "content-type": "application/json", ...headers },
              body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ path: segs }) },
          );
        const getViaRoute = (segs: string[], headers: Record<string, string>): Promise<Response> =>
          GET(
            new Request(rpcUrl(segs), { method: "GET", headers }),
            { params: Promise.resolve({ path: segs }) },
          );
        // Single-level client fetch interceptor (no nesting, no cycles):
        // relative `/api/agent/*` goes to the REAL PWA route handlers with a
        // test cookie jar (session cookie + harvested B pin + device scope —
        // the browser jar emulation, bounded and explicit); the legacy A0
        // upstream origin is stubbed benign (never networked); everything
        // else (loopback gateway/API) uses the true fetch.
        const installClientFetch = (opts: { sessionCookie: string; deviceToken: string; ws: string; initialPin?: string }): (() => void) => {
          const trueFetch = globalThis.fetch.bind(globalThis);
          let jarPin: string | null = opts.initialPin ?? null;
          const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
            const s = String(url);
            if (s.startsWith("/api/agent/")) {
              const noQuery = s.split("?")[0];
              const segments = noQuery.replace(/^\/api\/agent\//, "").split("/").map(decodeURIComponent);
              const incoming = new Headers((init?.headers as HeadersInit | undefined) ?? {});
              // Browser-jar emulation (documented): the component never
              // forges identity — cookie, device credential and workspace
              // scope ALWAYS come from the test jar, even when the caller set
              // its own values (the mocked getActiveDeviceToken returns a
              // device id, not the token; the real browser sends the token).
              incoming.set("cookie", opts.sessionCookie + (jarPin ? `; ${jarPin}` : ""));
              incoming.set("x-device-token", opts.deviceToken);
              incoming.set("x-workspace-id", opts.ws);
              const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
              const req = new Request(`http://localhost:3000${s}`, {
                method,
                headers: incoming,
                body: (init as RequestInit | undefined)?.body ?? undefined,
              });
              const res = method === "POST"
                ? await POST(req, { params: Promise.resolve({ path: segments }) })
                : await GET(req, { params: Promise.resolve({ path: segments }) });
              for (const sc of setCookiesOf(res)) {
                const seg = firstCookieSegment(sc);
                if (seg.startsWith("ted-runtime-conversation=opencode.")) jarPin = seg;
              }
              return res;
            }
            if (s.startsWith(EXPECTED_AGENT_ORIGIN)) {
              return new Response(JSON.stringify({ items: [], total: 0 }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return trueFetch(url, init);
          });
          return () => fetchSpy.mockRestore();
        };

        // 4. session/new (actor A): B pin opaco + runtime revelado.
        const newRes = await postViaRoute(sessionNewPath(HOUSEHOLD_A), {}, headersFor(cookieA, regA.token, HOUSEHOLD_A));
        expect(newRes.status).toBe(200);
        expect(newRes.headers.get("x-ted-runtime")).toBe("opencode");
        const newBody = (await newRes.json()) as { ok?: boolean; sessionId?: string };
        expect(newBody.ok).toBe(true);
        expect(typeof newBody.sessionId).toBe("string");
        const pin = setCookiesOf(newRes).find((c) => c.includes("ted-runtime-conversation=opencode."));
        expect(pin).toBeDefined();
        const pinCookie = firstCookieSegment(pin ?? null);
        expect(pinCookie.startsWith("ted-runtime-conversation=opencode.")).toBe(true);

        // 5. Successful synthetic READ via the full chain (PWA proxy POST →
        // gateway → SDK prompt → stub tool_call → transport → API handlers).
        const chatRes = await postViaRoute(
          chatPath(HOUSEHOLD_A),
          { text: CHAT_TEXT, intentionId: INTENTION_1 },
          headersFor(cookieA, regA.token, HOUSEHOLD_A, pinCookie),
        );
        expect(chatRes.status).toBe(200);
        expect(chatRes.headers.get("x-ted-runtime")).toBe("opencode");
        const chatBody = (await chatRes.json()) as {
          turnId?: string; intentionId?: string; status?: string; output?: string;
        };
        expect(chatBody.status).toBe("completed");
        expect(chatBody.intentionId).toBe(INTENTION_1);
        expect(typeof chatBody.turnId).toBe("string");
        expect(chatBody.output).toBe(EXPECTED_FINAL_TEXT);

        let stats = await serve.cmd("stats");
        expect(stats["promptCalls"]).toBe(1);
        expect(stats["transportCalls"]).toBe(1);
        // Zero stub/DTO mismatches: every final text was derived from a
        // validated tool-result DTO, never a canned string.
        expect(stats["stubMismatches"]).toEqual([]);
        expect(Number(stats["messageLists"])).toBeGreaterThan(0);
        // Exactly 2 local provider requests for the success turn: the
        // tool-call turn + the tool-result/final-answer turn. No hidden
        // SDK/provider retry is possible without moving this counter.
        expect(stats["stubTurns"]).toBe(2);
        expect(stats["stubUrlCounts"]).toEqual({ "/v1/chat/completions": 2 });
        const offered = stats["offeredTools"];
        expect(Array.isArray(offered) && (offered as string[]).includes("get_month_summary")).toBe(true);
        const reads = stats["financeReads"] as Array<{
          route?: string; method?: string; statusCode?: number; body?: Record<string, unknown>;
        }>;
        expect(reads.length).toBe(1);
        expect(reads[0].route).toContain("/dashboard/month-summary");
        expect(reads[0].route).toContain("2026-06");
        expect(reads[0].statusCode).toBe(200);
        expect(reads[0].body).toMatchObject({ yearMonth: "2026-06", ...ORACLE_A });
        for (const hit of ((stats["stubRemotes"] as string[] | undefined) ?? [])) {
          expect(hit).toBe("127.0.0.1");
        }
        // Egress posture (narrow, honest): the configured provider endpoint is
        // the local loopback stub only (dummy apiKey); unexpected non-loopback
        // fetch calls are intercepted and blocked pre-socket (see probe
        // guard); stub request remotes above are asserted loopback. This is
        // NOT a general OS-level egress sandbox — raw `node:http`/`net`/`tls`
        // sockets are not intercepted — and no external/paid inference was
        // configured or called. Blocked-fetch telemetry is fixed safe
        // counters only (no URL/host text anywhere).
        expect(stats["fetchBlockedUnexpected"]).toBe(0);
        expect(Number(stats["fetchBlockedCatalog"])).toBeGreaterThanOrEqual(0);
        expect(Number(stats["fetchAllowedLoopback"])).toBeGreaterThan(0);

        // 6. History via route GET + via PWA client, then reload: stable IDs,
        // zero new prompt, zero new transport.
        const histRes = await getViaRoute(historyPath(HOUSEHOLD_A), headersFor(cookieA, regA.token, HOUSEHOLD_A, pinCookie));
        expect(histRes.status).toBe(200);
        const histText = await histRes.text();
        expect(histText.includes(EXPECTED_FINAL_TEXT)).toBe(true);

        deviceState.current = regA.deviceId;
        const restoreClientFetch = installClientFetch({ sessionCookie: cookieA, deviceToken: regA.token, ws: HOUSEHOLD_A, initialPin: pinCookie });
        let viaClient: Array<{ id: string; content: string; isOwn: boolean }>;
        try {
          viaClient = await fetchAgentHistory(HOUSEHOLD_A);
        } finally {
          restoreClientFetch();
        }
        expect(viaClient.length).toBeGreaterThanOrEqual(2);
        expect(viaClient[0].content).toBe(CHAT_TEXT);
        expect(viaClient[0].isOwn).toBe(true);
        const assistantItem = viaClient.find((i) => !i.isOwn && i.content === EXPECTED_FINAL_TEXT);
        expect(assistantItem).toBeDefined();
        expect(getTedRuntimeView(HOUSEHOLD_A)).toBe("opencode");

        const reloadRes = await getViaRoute(historyPath(HOUSEHOLD_A), headersFor(cookieA, regA.token, HOUSEHOLD_A, pinCookie));
        expect(reloadRes.status).toBe(200);
        expect(await reloadRes.text()).toBe(histText);
        // Route/history reload via the client returns the SAME DTO — no silent
        // errors swallowed: any client/history failure fails the test here.
        const reloadRestore = installClientFetch({ sessionCookie: cookieA, deviceToken: regA.token, ws: HOUSEHOLD_A, initialPin: pinCookie });
        try {
          const reloadClient = await fetchAgentHistory(HOUSEHOLD_A);
          expect(reloadClient.map((i) => i.id)).toEqual(viaClient.map((i) => i.id));
          expect(reloadClient.map((i) => i.content)).toEqual(viaClient.map((i) => i.content));
        } finally {
          reloadRestore();
        }
        stats = await serve.cmd("stats");
        expect(stats["promptCalls"]).toBe(1);
        expect(stats["transportCalls"]).toBe(1);

        // 7. Isolation: actor B on workspace A is denied (never 200, never
        // fabricated output), and no prompt runs for the denied scope.
        const crossRes = await postViaRoute(
          chatPath(HOUSEHOLD_A),
          { text: CHAT_TEXT, intentionId: "p2d-intention-cross-09" },
          headersFor(cookieB, regB.token, HOUSEHOLD_A),
        );
        expect(crossRes.status).not.toBe(200);
        const crossBody = (await crossRes.json()) as { code?: string; output?: string; items?: unknown };
        expect(typeof (crossBody.code ?? "")).toBe("string");
        expect(crossBody.output).toBeUndefined();
        expect(crossBody.items).toBeUndefined();
        stats = await serve.cmd("stats");
        expect(stats["promptCalls"]).toBe(1);
        expect(stats["transportCalls"]).toBe(1);

        // 8. Injected provider fault + SAME intention repeat: replayed genuine
        // output, no second prompt, no new transport, no false success — and
        // zero additional local provider requests (native-history replay).
        const failed = await serve.cmd("fail-provider");
        expect(failed["failProvider"]).toBe(true);
        const preReplay = await serve.cmd("stats");
        const replayRes = await postViaRoute(
          chatPath(HOUSEHOLD_A),
          { text: CHAT_TEXT, intentionId: INTENTION_1 },
          headersFor(cookieA, regA.token, HOUSEHOLD_A, pinCookie),
        );
        expect(replayRes.status).toBe(200);
        const replayBody = (await replayRes.json()) as { status?: string; output?: string; intentionId?: string };
        expect(replayBody.status).toBe("completed");
        expect(replayBody.intentionId).toBe(INTENTION_1);
        expect(replayBody.output).toBe(EXPECTED_FINAL_TEXT);
        stats = await serve.cmd("stats");
        expect(stats["promptCalls"]).toBe(1);
        expect(stats["transportCalls"]).toBe(1);
        expect(stats["stubTurns"]).toBe(preReplay["stubTurns"]);

        // 9. NEW intention under the fault: typed fail-closed error, no output
        // (exactly one prompt attempt, then the fault surfaces).
        const preFault = await serve.cmd("stats");
        const faultRes = await postViaRoute(
          chatPath(HOUSEHOLD_A),
          { text: CHAT_TEXT, intentionId: INTENTION_2 },
          headersFor(cookieA, regA.token, HOUSEHOLD_A, pinCookie),
        );
        expect(faultRes.status).not.toBe(200);
        const faultBody = (await faultRes.json()) as { code?: string; output?: string; status?: string };
        expect(typeof (faultBody.code ?? "")).toBe("string");
        expect(faultBody.output === undefined || faultBody.output === "").toBe(true);
        stats = await serve.cmd("stats");
        expect(stats["promptCalls"]).toBe(2);
        // EXACT provider-request count for the HTTP-500 failure: exactly ONE
        // POST to /v1/chat/completions inside ONE adapter-level prompt
        // attempt. Enforced by the proven runtime hook policy
        // (PR290-RETRY-HOOK: the product plugin vetoes native retries for
        // agent `ted` via `session.hook('retry')` → `{ retry: false }`;
        // runtime proof `tests/retry-no-repeat.test.mjs`, 1 POST per prompt).
        // promptCalls proves the single prompt; stubTurns proves no
        // provider-layer retry. Any change in either counter fails.
        expect(stats["stubTurns"]).toBe(Number(preFault["stubTurns"]) + 1);
        expect(stats["stubUrlCounts"]).toEqual({ "/v1/chat/completions": Number(stats["stubTurns"]) });
        const faultRetry = await postViaRoute(
          chatPath(HOUSEHOLD_A),
          { text: CHAT_TEXT, intentionId: INTENTION_2 },
          headersFor(cookieA, regA.token, HOUSEHOLD_A, pinCookie),
        );
        expect(faultRetry.status).not.toBe(200);
        const faultRetryBody = (await faultRetry.json()) as { code?: string; output?: string };
        expect(typeof (faultRetryBody.code ?? "")).toBe("string");
        expect(faultRetryBody.output === undefined || faultRetryBody.output === "").toBe(true);
        stats = await serve.cmd("stats");
        expect(stats["promptCalls"]).toBe(2);
        // The same failed intention retry issues no prompt and therefore zero
        // additional provider requests (count frozen at the single fault POST).
        expect(stats["stubTurns"]).toBe(Number(preFault["stubTurns"]) + 1);

        // 10. Recovery: new intention succeeds again through the full chain.
        const healed = await serve.cmd("recover-provider");
        expect(healed["failProvider"]).toBe(false);
        const recoverRes = await postViaRoute(
          chatPath(HOUSEHOLD_A),
          { text: CHAT_TEXT, intentionId: INTENTION_3 },
          headersFor(cookieA, regA.token, HOUSEHOLD_A, pinCookie),
        );
        expect(recoverRes.status).toBe(200);
        expect(((await recoverRes.json()) as { output?: string }).output).toBe(EXPECTED_FINAL_TEXT);
        stats = await serve.cmd("stats");
        expect(stats["promptCalls"]).toBe(3);
        expect(stats["transportCalls"]).toBe(2);
        // Recovery re-exercises the full loop: tool-call turn + final-answer
        // turn, exactly 2 more local provider requests (1 fault POST + 2).
        expect(stats["stubTurns"]).toBe(Number(preFault["stubTurns"]) + 3);
        const postRecoveryTurns = Number(stats["stubTurns"]);

        // 10b. Component remount (NOT browser navigation): the REAL TedChat
        // sends through the REAL agent-client + real PWA route (fresh
        // browser-like jar: pinless history bootstrap, then chat on the
        // harvested pin), then unmount/remount rehydrates the same answer
        // from server history with zero new prompt and zero new transport.
        // A real browser navigation (Playwright page reload) remains
        // NOT_PROVEN — this proves route/history refresh rehydration only.
        {
          deviceState.current = regA.deviceId;
          const restoreComponentFetch = installClientFetch({ sessionCookie: cookieA, deviceToken: regA.token, ws: HOUSEHOLD_A });
          try {
            const user = userEvent.setup();
            const view = render(<TedChat />);
            const input = await screen.findByPlaceholderText(
              "Pergunte sobre gastos, metas ou pagamentos…",
              undefined,
              { timeout: 60000 },
            );
            await user.type(input, COMPONENT_TEXT);
            await user.click(screen.getByRole("button", { name: /enviar mensagem/i }));
            // Exact DTO-derived text on screen: proves DTO → provider context
            // → PWA output instead of a canned string.
            await screen.findByText(EXPECTED_FINAL_TEXT, undefined, { timeout: 180000 });
            stats = await serve.cmd("stats");
            expect(stats["promptCalls"]).toBe(4);
            expect(stats["transportCalls"]).toBe(3);
            expect(stats["stubMismatches"]).toEqual([]);
            // The component send is one full loop: tool-call + final-answer.
            expect(stats["stubTurns"]).toBe(postRecoveryTurns + 2);
            const readsAfterSend = stats["financeReads"] as Array<{
              route?: string; method?: string; statusCode?: number; body?: Record<string, unknown>;
            }>;
            expect(readsAfterSend.length).toBe(3);
            expect(readsAfterSend[2].route).toContain("/dashboard/month-summary");
            expect(readsAfterSend[2].body).toMatchObject({ yearMonth: "2026-06", ...ORACLE_A });

            view.unmount();
            const beforeRemount = await serve.cmd("stats");
            render(<TedChat />);
            await screen.findByText(EXPECTED_FINAL_TEXT, undefined, { timeout: 120000 });
            expect(screen.getByText(COMPONENT_TEXT)).toBeInTheDocument();
            const afterRemount = await serve.cmd("stats");
            expect(afterRemount["promptCalls"]).toBe(beforeRemount["promptCalls"]);
            expect(afterRemount["transportCalls"]).toBe(beforeRemount["transportCalls"]);
            // Remount rehydrates from history: zero new provider requests.
            expect(afterRemount["stubTurns"]).toBe(beforeRemount["stubTurns"]);
          } finally {
            restoreComponentFetch();
          }
        }

        // 11. API journal: zero financial writes — only GET on finance reads.
        const FINANCIAL_PREFIXES = ["/accounts", "/dashboard", "/categories", "/transactions", "/cards", "/payables", "/budgets", "/goals", "/subscriptions"];
        const financial = journal.filter((j) => FINANCIAL_PREFIXES.some((p) => j.url === p || j.url.startsWith(`${p}/`)));
        expect(financial.length).toBeGreaterThan(0);
        for (const entry of financial) {
          expect(entry.method).toBe("GET");
        }
        const financialWrites = financial.filter((j) => j.method !== "GET");
        expect(financialWrites).toEqual([]);

        const closed = await closeServe();
        expect(closed?.["promptCalls"]).toBe(4);
        expect(closed?.["stubTurns"]).toBe(postRecoveryTurns + 2);
        expect(closed?.["stubMismatches"]).toEqual([]);
      } catch (e) {
        await closeServe();
        throw e;
      }
    } finally {
      await closeApi();
    }
  }, 300000);
});
