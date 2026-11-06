// P2D browser stack — test-only local coordinator (loopback only).
//
// Run ONLY as a Playwright webServer entry (P2D_BROWSER=1):
//   pnpm exec tsx e2e/support/p2d-browser-stack.ts
//
// Boots, in THIS process:
//   1. Real Fastify `buildTestApp` API (synthetic in-memory ledger +
//      synthetic Better-Auth via memoryAdapter, fixed single workspace
//      Casa/HOUSEHOLD_A, journal of every request) on P2D_API_PORT.
//   2. The REAL gateway + REAL OpenCode SDK 2.2.4 prompt loop + LOCAL
//      scripted provider stub (loopback, dummy apiKey, zero paid/external
//      inference) as a DEDICATED OS child process
//      (`p2d-synthetic-read-probe.mjs serve`, same two-tool sequence as the
//      route-level proof) on P2D_GATEWAY_PORT with a persistent temp root.
//   3. A tiny loopback CONTROL server on P2D_CTL_PORT (Playwright waits on
//      /health): stats/snapshot/journal passthrough + orderly probe
//      close/restart with the SAME isolated runtime root.
//
// What this is NOT: not production, not a transcript import, not a canned
// chat output — the browser drives the real PWA (Next dev on P2D_NEXT_PORT,
// separate webServer entry) → real PWA route → real gateway → real SDK
// prompt → scripted local stub → real finance tools → real API handlers.
// The model is scripted, so READ_SLICE_PASS remains NOT ACHIEVED (the spec
// asserts this explicitly). No external/paid inference is configured or
// called; no financial writes exist in this stack (journal proves zero).
//
// Temp root comes from the approved folder and is NEVER deleted here.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA_ROOT = path.resolve(HERE, "..", "..");
const API_TEST_APP = path.resolve(PWA_ROOT, "../api/tests/test-app.ts");
if (!fs.existsSync(API_TEST_APP)) {
  throw new Error(`p2d-stack: API test-app not found: ${API_TEST_APP}`);
}
const TED_RUNTIME_DIR = path.resolve(PWA_ROOT, "../ted-runtime");
const PROBE = path.resolve(HERE, "p2d-synthetic-read-probe.mjs");

// Live-mode opt-ins (set by the Playwright config from the launcher flags):
// - P2D_OFFLINE_CHAT=1  full offline chat with a loopback provider + dummy key;
// - P2D_LIVE_REAL=1  future real-provider run.
// This coordinator NEVER receives the real credential: in live-real the probe
// child loads the allowlisted local alias itself, so the secret cannot leak
// into this process, the PWA or Next.
const OFFLINE_CHAT = process.env.P2D_OFFLINE_CHAT === "1";
const LIVE_REAL = process.env.P2D_LIVE_REAL === "1";
if (OFFLINE_CHAT && LIVE_REAL) {
  throw new Error("[p2d-stack] P2D_OFFLINE_CHAT and P2D_LIVE_REAL are mutually exclusive");
}
const MODE = OFFLINE_CHAT ? "offline" : LIVE_REAL ? "live-real" : "synthetic";
const LIVE_MODEL_FILE = path.resolve(TED_RUNTIME_DIR, "src", "live-model.json");

function readLiveModel(): string {
  const raw = fs.readFileSync(LIVE_MODEL_FILE, "utf8");
  const parsed = JSON.parse(raw) as { model?: unknown };
  const model = parsed && typeof parsed === "object" ? parsed.model : null;
  if (typeof model !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error("[p2d-stack] live-model.json must hold a provider/model selector");
  }
  return model;
}

const LIVE_MODEL = MODE === "synthetic" ? null : readLiveModel();

const apiRequire = createRequire(API_TEST_APP);
const memoryAdapterPath: string = apiRequire.resolve("better-auth/adapters/memory");
const { memoryAdapter } = (await import(pathToFileURL(memoryAdapterPath).href)) as unknown as {
  memoryAdapter: (options: Record<string, unknown[]>) => unknown;
};
type AuthConfig = Parameters<typeof createBetterAuth>[0];
const { createBetterAuth } = await import("../../../api/src/auth/better-auth.js");
const { buildTestApp } = await import("../../../api/tests/test-app.js");
const {
  ACCOUNT_A1,
  ACCOUNT_A2,
  ACCOUNT_B1,
  CATEGORY_FOOD_A,
  CATEGORY_FOOD_B,
  CATEGORY_RENT_A,
  CATEGORY_SALARY_A,
  HOUSEHOLD_A,
  TRANSACTIONS,
} = await import("../../../api/tests/fixtures/seed.js");

const ORACLE_A = {
  incomeCents: 1_200_000,
  expenseCents: 288_050,
  balanceCents: 911_950,
  transactionCount: 4,
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`[p2d-stack] invalid ${name}`);
  return n;
}
const API_PORT = numEnv("P2D_API_PORT", 4110);
const GATEWAY_PORT = numEnv("P2D_GATEWAY_PORT", 3221);
const CTL_PORT = numEnv("P2D_CTL_PORT", 3200);
const SECRET = "test-secret-that-is-at-least-32-characters";

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
const ROOT = approvedTmpRoot("ted-pwa-p2dbrowser");
console.log(`[p2d-stack] root=${ROOT}`);

// Fixed single-workspace store (test-only): the synthetic user always sees
// exactly Casa/HOUSEHOLD_A (owner, active). Methods outside the P2D flow
// fail closed instead of inventing state.
const WS_SUMMARY = {
  id: HOUSEHOLD_A,
  name: "Casa",
  kind: "shared",
  role: "owner",
  status: "active",
} as const;
const fixedWorkspaceStore = {
  list: async () => [{ ...WS_SUMMARY }],
  create: async () => ({ ...WS_SUMMARY }),
  listMembers: async (input: { authUserId: string; householdId: string }) => [
    { userId: input.authUserId, name: "P2D", email: "", role: "owner", status: "active" as const },
  ],
  rename: async () => {
    throw Object.assign(new Error("not supported in P2D stack"), { statusCode: 409, code: "workspace.unsupported" });
  },
  setStatus: async () => {
    throw Object.assign(new Error("not supported in P2D stack"), { statusCode: 409, code: "workspace.unsupported" });
  },
  removeMember: async () => {
    throw Object.assign(new Error("not supported in P2D stack"), { statusCode: 409, code: "workspace.unsupported" });
  },
  leave: async () => {
    throw Object.assign(new Error("not supported in P2D stack"), { statusCode: 409, code: "workspace.unsupported" });
  },
  deletionInventory: async () => {
    throw Object.assign(new Error("not supported in P2D stack"), { statusCode: 409, code: "workspace.unsupported" });
  },
  depositEmptyAttestation: async () => {
    throw Object.assign(new Error("not supported in P2D stack"), { statusCode: 409, code: "workspace.unsupported" });
  },
  deleteEmpty: async () => {
    throw Object.assign(new Error("not supported in P2D stack"), { statusCode: 409, code: "workspace.unsupported" });
  },
};
const workspaceAccess = {
  resolve: async (authUserId: string, householdId: string) => {
    if (householdId !== HOUSEHOLD_A || !authUserId) return undefined;
    return { userId: authUserId, householdId, role: "owner" as const, kind: "shared" as const };
  },
};

const NEXT_ORIGIN = `http://127.0.0.1:${numEnv("P2D_NEXT_PORT", 3201)}`;
const auth = createBetterAuth({
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }) as AuthConfig["database"],
  disableSignUp: false,
  transaction: false,
  secret: SECRET,
  baseURL: NEXT_ORIGIN,
  // The PWA backend proxy spoofs browser Origin to the pinned PWA placeholder
  // under ALLOW_LOCAL_ORIGIN=1 (V4 T2.7 G3); the upstream must trust both the
  // real Next origin and the spoof target, otherwise every browser POST is
  // 403 auth.invalid_origin. Test-only stack, loopback only.
  trustedOrigins: [NEXT_ORIGIN, "https://pwa.example"],
});
const built = buildTestApp(
  {
    accounts: [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1],
    categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_SALARY_A, CATEGORY_FOOD_B],
    transactions: TRANSACTIONS,
  },
  auth,
  workspaceAccess,
  fixedWorkspaceStore,
  false,
);
const journal: Array<{ method: string; url: string }> = [];
built.app.addHook("onRequest", async (req) => {
  journal.push({ method: String(req.method), url: String(req.url).split("?")[0] });
});
await built.app.listen({ port: API_PORT, host: "127.0.0.1" });
console.log(`[p2d-stack] api=http://127.0.0.1:${API_PORT}`);

// Probe child (dedicated OS process): same two-tool sequence as the
// route-level proof. Restart reuses the SAME root (persistence proof).
type ProbeHandle = {
  child: ChildProcess;
  lines: string[];
  stderrTail: string;
  exited: boolean;
  exitCode: unknown;
  pid: number | undefined;
};
let probe: ProbeHandle | null = null;

function buildProbeConfig(): Record<string, unknown> {
  const base = {
    root: ROOT,
    identity: MODE === "offline" ? "p2d-offline" : MODE === "live-real" ? "p2d-live-real" : "p2d-browser",
    apiBaseUrl: `http://127.0.0.1:${API_PORT}`,
    tedRuntimeDir: TED_RUNTIME_DIR,
  };
  const stub = {
    toolSequence: [
      { name: "list_accounts", args: {} },
      { name: "get_month_summary", args: { yearMonth: "2026-06" } },
    ],
    expectedAccounts: { names: ["Itaú", "Nubank"], total: 2 },
    expectedOracle: { yearMonth: "2026-06", ...ORACLE_A },
  };
  if (MODE === "synthetic") return { ...base, stub };
  const model = LIVE_MODEL as string;
  return {
    ...base,
    mode: MODE,
    profile: "live",
    provider: model.split("/")[0],
    model,
    // offline: dummy key + loopback stub; live-real: the probe child reads the
    // allowlisted local alias itself (never sent through this coordinator).
    credentialSource: MODE === "offline" ? "dummy" : "allowlist",
    // The scripted tool sequence only exists in the offline mode; the real
    // model decides its own tools.
    ...(MODE === "offline" ? { stub } : {}),
  };
}

async function startProbe(): Promise<{ base: string; pid: number | undefined }> {
  if (probe && !probe.exited) throw new Error("probe already running");
  const child = spawn(process.execPath, [PROBE, "serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: PWA_ROOT,
    env: {
      ...process.env,
      P2D_GATEWAY_PORT: String(GATEWAY_PORT),
      P2D_CONFIG_JSON: JSON.stringify(buildProbeConfig()),
    },
  });
  const handle: ProbeHandle = { child, lines: [], stderrTail: "", exited: false, exitCode: null, pid: child.pid };
  child.stdout?.on("data", (d) => {
    for (const line of String(d).split("\n")) {
      if (!line.trim()) continue;
      handle.lines.push(line);
      // Shutdown-stage telemetry to the webServer log (few lines, no
      // secrets: phase/stage markers only).
      if (line.includes("serve-closing")) console.log(`[p2d-stack] probe ${line}`);
    }
  });
  child.stderr?.on("data", (d) => {
    handle.stderrTail = `${handle.stderrTail}${String(d)}`.slice(-2000);
  });
  child.on("close", (code, signal) => {
    handle.exited = true;
    handle.exitCode = signal ? `signal:${signal}` : code;
  });
  child.on("error", () => {
    handle.exited = true;
    handle.exitCode = "spawn-error";
  });
  probe = handle;
  const deadline = Date.now() + 180000;
  for (;;) {
    const ready = handle.lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((j) => j && j["phase"] === "serve-ready");
    if (ready) return { base: String(ready["base"]), pid: handle.pid };
        if (handle.exited) {
          // live-real: never surface the child's stderr (SDK internals may
          // embed the credential). Offline/synthetic keep the diagnostic.
          const tail = MODE === "live-real" ? "" : `: ${handle.stderrTail}`;
          throw new Error(`probe exited before ready (exit=${handle.exitCode})${tail}`);
        }
    if (Date.now() > deadline) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      throw new Error("probe without ready in 180s");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function probeCmd(line: string, timeoutMs = 60000): Promise<Record<string, unknown>> {
  if (!probe || probe.exited) throw new Error("probe not running");
  const handle = probe;
  const from = handle.lines.length;
  const phase = line === "stats" ? "serve-stats" : line === "close" ? "serve-closed" : line.startsWith("snapshot") ? line.split(" ")[0] === "snapshot-list" ? "serve-snapshot-list" : "serve-snapshot" : "serve-ctl";
  const pending = (async () => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = from; i < handle.lines.length; i++) {
        try {
          const j = JSON.parse(handle.lines[i]) as Record<string, unknown>;
          if (j && j["phase"] === phase) return j;
        } catch {
          /* non-JSON line */
        }
      }
      if (handle.exited) throw new Error(`probe exited during command (exit=${handle.exitCode})`);
      if (Date.now() > deadline) throw new Error("probe without response in 60s");
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  handle.child.stdin?.write(`${line}\n`);
  return pending;
}

async function closeProbe(): Promise<{ exitCode: unknown; pid: number | undefined; forced: boolean }> {
  if (!probe) return { exitCode: null, pid: undefined, forced: false };
  const handle = probe;
  let forced = false;
  try {
    // Orderly SDK shutdown is slow (sqlite persistence); allow it fully
    // before even considering force. forced=true is a finding, not silent.
    // The serve-closed receipt proves every stage completed; afterwards the
    // process may linger on the parent-held stdio pipes, so destroy them
    // and await natural exit (no process.exit inside the probe: the receipt
    // itself is the proof, and exit must not truncate it).
    await probeCmd("close", 180000);
    try {
      handle.child.stdin?.destroy();
    } catch {
      /* best effort */
    }
    try {
      (handle.child.stdout as unknown as { destroy?: () => void } | null | undefined)?.destroy?.();
    } catch {
      /* best effort */
    }
    try {
      (handle.child.stderr as unknown as { destroy?: () => void } | null | undefined)?.destroy?.();
    } catch {
      /* best effort */
    }
  } catch {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      /* noop */
    }
    forced = true;
  }
  const deadline = Date.now() + 60000;
  while (!handle.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (!handle.exited) {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      /* noop */
    }
    forced = true;
    const deadline2 = Date.now() + 10000;
    while (!handle.exited && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 100));
  }
  probe = null;
  const debug: Record<string, unknown> = {
    exitCode: handle.exitCode,
    pid: handle.pid,
    forced,
  };
  // live-real: omit raw child output (SDK internals may embed the credential).
  if (MODE !== "live-real") {
    debug.lastLines = handle.lines.slice(-15);
    debug.stderrTail = handle.stderrTail;
  }
  return debug as { exitCode: unknown; pid: number | undefined; forced: boolean };
}

await startProbe();
console.log(`[p2d-stack] gateway=http://127.0.0.1:${GATEWAY_PORT} pid=${probe?.pid}`);

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const ctl = http.createServer((req, res) => {
  void (async () => {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/health") {
        json(res, 200, { ok: true, probeRunning: !!probe && !probe.exited });
        return;
      }
      if (req.method === "GET" && u.pathname === "/p2d/stats") {
        json(res, 200, await probeCmd("stats"));
        return;
      }
      if (req.method === "GET" && u.pathname === "/p2d/snapshot-list") {
        json(res, 200, await probeCmd("snapshot-list"));
        return;
      }
      if (req.method === "GET" && u.pathname === "/p2d/probe-log") {
        // Debug only (never evidence): last probe stdout lines + stderr
        // tail, bounded. Helps distinguish crash vs shutdown stall.
        json(res, 200, {
          running: !!probe && !probe.exited,
          exitCode: probe?.exitCode ?? null,
          // live-real: no raw child output (SDK internals may embed the
          // credential); debug-only endpoint, never evidence.
          ...(MODE === "live-real"
            ? {}
            : {
                lastLines: (probe?.lines ?? []).slice(-15),
                stderrTail: probe?.stderrTail ?? "",
              }),
        });
        return;
      }
      if (req.method === "GET" && u.pathname === "/p2d/snapshot") {
        const id = (u.searchParams.get("id") || "").slice(0, 80);
        if (!id) {
          json(res, 400, { error: "id is required" });
          return;
        }
        json(res, 200, await probeCmd(`snapshot ${id}`));
        return;
      }
      if (req.method === "GET" && u.pathname === "/p2d/journal") {
        const financial = journal.filter((j) =>
          ["/accounts", "/dashboard", "/categories", "/transactions", "/cards", "/payables", "/budgets", "/goals", "/subscriptions"].some(
            (p) => j.url === p || j.url.startsWith(`${p}/`),
          ),
        );
        json(res, 200, {
          requests: journal,
          financialWrites: financial.filter((j) => j.method !== "GET"),
        });
        return;
      }
      if (req.method === "POST" && u.pathname === "/p2d/close-probe") {
        const receipt = await closeProbe();
        json(res, 200, { ok: true, ...receipt });
        return;
      }
      if (req.method === "POST" && u.pathname === "/p2d/start-probe") {
        const started = await startProbe();
        json(res, 200, { ok: true, ...started });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      // live-real: fixed text only — native/SDK errors may embed the
      // credential in any form. Offline/synthetic keep the diagnostic.
      json(res, 500, {
        error:
          MODE === "live-real"
            ? "p2d control error (details redacted)"
            : String((e as Error)?.message || e).slice(0, 300),
      });
    }
  })();
});
await new Promise<void>((resolve) => ctl.listen(CTL_PORT, "127.0.0.1", resolve));
console.log(`[p2d-stack] ctl=http://127.0.0.1:${CTL_PORT}`);

async function shutdown(signal: string): Promise<void> {
  console.log(`[p2d-stack] ${signal}: orderly shutdown`);
  try {
    await closeProbe();
  } catch {
    /* best effort */
  }
  try {
    await built.app.close().catch(() => {});
    await auth.close().catch(() => {});
  } catch {
    /* best effort */
  }
  ctl.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
