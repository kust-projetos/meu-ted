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
// P3 proposal slices (test-only): real Agent Worker + Pending V2 on the
// synthetic API + the scripted provider emitting propose_expense (P3.1) or
// propose_income (P3.2). It reuses the same loopback stack; no external
// inference and no production data.
const EXPENSE = process.env.P2D_EXPENSE === "1";
const INCOME = process.env.P2D_INCOME === "1";
const CARD = process.env.P2D_CARD === "1";
const CARD_INSTALLMENTS = process.env.P2D_CARD_INSTALLMENTS === "1";
const TRANSFER = process.env.P2D_TRANSFER === "1";
const STATEMENT_PAY = process.env.P2D_STATEMENT_PAY === "1";
const P3_PILOT = process.env.P2D_P3_PILOT === "1";
const P38_CARD_SMOKE = process.env.P2D_P38_CARD_SMOKE === "1";
// P2D rollback slice: needs the real Agent Worker (A0) for the pin to land on,
// plus the loopback gateway so a wrong route would be observable. Never prompts
// the gateway (kill switch forces A0).
const ROLLBACK = process.env.P2D_ROLLBACK === "1";
const PROPOSAL = P3_PILOT || P38_CARD_SMOKE || EXPENSE || INCOME || CARD || CARD_INSTALLMENTS || TRANSFER || STATEMENT_PAY;
const AGENT_RUN = PROPOSAL || ROLLBACK;
if (ROLLBACK && (PROPOSAL || OFFLINE_CHAT || LIVE_REAL)) {
  throw new Error("[p2d-stack] P2D_ROLLBACK is exclusive with every other P2D mode");
}
if (P38_CARD_SMOKE && !LIVE_REAL) {
  throw new Error("[p2d-stack] P2D_P38_CARD_SMOKE requires P2D_LIVE_REAL (fail-closed)");
}
if (P38_CARD_SMOKE && (P3_PILOT || EXPENSE || INCOME || CARD || CARD_INSTALLMENTS || TRANSFER || STATEMENT_PAY || OFFLINE_CHAT)) {
  throw new Error("[p2d-stack] P2D_P38_CARD_SMOKE is exclusive with P3_PILOT, P3 slices and P2D_OFFLINE_CHAT");
}
if (P3_PILOT && (EXPENSE || INCOME || CARD || CARD_INSTALLMENTS || TRANSFER || STATEMENT_PAY || OFFLINE_CHAT)) {
  throw new Error("[p2d-stack] P2D_P3_PILOT is exclusive with P3 slices and P2D_OFFLINE_CHAT");
}
if ([EXPENSE, INCOME, CARD, CARD_INSTALLMENTS, TRANSFER, STATEMENT_PAY].filter(Boolean).length > 1) {
  throw new Error(
    "[p2d-stack] select at most one P3 proposal slice (P2D_EXPENSE|P2D_INCOME|P2D_CARD|P2D_CARD_INSTALLMENTS|P2D_TRANSFER|P2D_STATEMENT_PAY)",
  );
}
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
const { createInMemoryPendingOperationV2Store } = await import("../../../api/src/approvals/pending-v2.js");
const {
  ACCOUNT_A1,
  ACCOUNT_A2,
  ACCOUNT_B1,
  CARD_A1,
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
const AGENT_PORT = numEnv("P2D_AGENT_PORT", 3222);
const SECRET = "test-secret-that-is-at-least-32-characters";
// Dev-only HMAC pairs for the local Agent/API (same values the repo's
// docker/local stack uses; never production).
const DELEGATION_SECRET = "dev-agent-delegation-secret-32-chars!";
const CONNECTION_SECRET = "dev-agent-connection-secret-at-least-32-chars!";
const SERVICE_TOKEN = "dev-agent-auth-service-token-32-chars!";
process.env.AGENT_CONNECTION_TOKEN_SECRET = CONNECTION_SECRET;
process.env.AGENT_AUTH_SERVICE_TOKEN = SERVICE_TOKEN;

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
const AGENT_PERSIST = approvedTmpRoot("ted-agent-p3");
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
const pendingV2Store = PROPOSAL ? createInMemoryPendingOperationV2Store() : null;
const built = buildTestApp(
  {
    // P3.4/P3.5 only: the card slices need a real credit-card account in the
    // synthetic ledger. Every other mode keeps the exact read-slice oracle.
    accounts: P3_PILOT || P38_CARD_SMOKE || CARD || CARD_INSTALLMENTS || STATEMENT_PAY
      ? [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1, CARD_A1]
      : [ACCOUNT_A1, ACCOUNT_A2, ACCOUNT_B1],
    categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_SALARY_A, CATEGORY_FOOD_B],
    transactions: TRANSACTIONS,
  },
  auth,
  workspaceAccess,
  fixedWorkspaceStore,
  false,
  DELEGATION_SECRET,
  ...(pendingV2Store ? [pendingV2Store] : []),
);
// P3.6: seed the invoice BEFORE the probe starts. The stack's own card store
// is authoritative; the E2E never invents a statement id or amount. A prior
// partial payment (R$ 350,00 of R$ 1.200,00) makes the card match the product
// example: total 1.200, already paid 350, pay 850 now.
let seededStatement: Awaited<ReturnType<typeof built.cardStore.listStatements>>[number] | null = null;
if (STATEMENT_PAY) {
  await built.cardStore.createCardPurchase(HOUSEHOLD_A, {
    accountId: CARD_A1.id,
    description: "compra fatura",
    amountCents: 120_000,
    date: "2026-11-07",
  });
  const initial = (await built.cardStore.listStatements(HOUSEHOLD_A, CARD_A1.id))[0]!;
  await built.cardStore.payStatement(HOUSEHOLD_A, initial.id, {
    amountCents: 35_000,
    fromAccountId: ACCOUNT_A1.id,
  });
  seededStatement = (await built.cardStore.listStatements(HOUSEHOLD_A, CARD_A1.id))[0]!;
  console.log(`[p2d-stack] statement=${seededStatement.id} paid=${seededStatement.paidCents} total=${seededStatement.totalCents}`);
}

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
    identity:
      MODE === "offline"
        ? "p2d-offline"
        : P38_CARD_SMOKE
          ? "p2d-p38-card-smoke"
          : MODE === "live-real"
            ? "p2d-live-real"
            : "p2d-browser",
    apiBaseUrl: `http://127.0.0.1:${API_PORT}`,
    tedRuntimeDir: TED_RUNTIME_DIR,
    ctlBaseUrl: `http://127.0.0.1:${CTL_PORT}`,
  };
  if (PROPOSAL) {
    if ((P3_PILOT || P38_CARD_SMOKE) && LIVE_REAL) {
      const liveModel = LIVE_MODEL as string;
      return {
        ...base,
        mode: MODE,
        profile: "live",
        provider: liveModel.split("/")[0],
        model: liveModel,
        credentialSource: "allowlist",
      };
    }
    if (P3_PILOT && !LIVE_REAL) return {
      ...base,
      stub: { mode: "pilot", toolSequence: [
        { match: "Gastei R$ 65", name: "propose_expense", args: { amountCents: 6500, description: "almoço", date: "2026-11-07", accountId: ACCOUNT_A1.id, categoryId: CATEGORY_FOOD_A.id } },
        { match: "Recebi R$ 800", name: "propose_income", args: { amountCents: 80000, description: "receita", date: "2026-11-07", accountId: ACCOUNT_A1.id, categoryId: CATEGORY_SALARY_A.id } },
        { match: "Transfira R$ 150", name: "propose_transfer", args: { amountCents: 15000, description: "Transferência Itaú para Neon", date: "2026-11-07", fromAccountId: ACCOUNT_A1.id, toAccountId: ACCOUNT_A2.id } },
        { match: "Comprei R$ 120", name: "propose_card_purchase", args: { amountCents: 12000, description: "compra à vista", date: "2026-11-07", accountId: CARD_A1.id } },
        { match: "Comprei R$ 600", name: "propose_card_purchase", args: { amountCents: 60000, description: "compra parcelada", date: "2026-11-07", accountId: CARD_A1.id, installmentsTotal: 3 } },
        { match: "Pague R$ 300", name: "propose_statement_payment", args: { statementId: "resolve-november", fromAccountId: ACCOUNT_A1.id, amountCents: 30000 } },
        { match: "Agora quite", name: "propose_statement_payment", args: { statementId: "resolve-november", fromAccountId: ACCOUNT_A1.id, amountCents: 2000 } },
        { match: "despesa extra", name: "propose_expense", args: { amountCents: 100000, description: "piloto extra", date: "2026-11-07", accountId: ACCOUNT_A1.id, categoryId: CATEGORY_FOOD_A.id } },
      ] },
    };
    if (STATEMENT_PAY) {
      if (!seededStatement) throw new Error("[p2d-stack] statement seed missing");
      return {
        ...base,
        stub: {
          mode: "statement",
          toolName: "propose_statement_payment",
          toolArgs: {
            statementId: seededStatement.id,
            fromAccountId: ACCOUNT_A1.id,
            amountCents: 85_000,
          },
        },
      };
    }
    if (CARD_INSTALLMENTS) {
      return {
        ...base,
        stub: {
          mode: "card",
          toolName: "propose_card_purchase",
          toolArgs: {
            amountCents: 120000,
            description: "celular",
            date: "2026-11-07",
            accountId: CARD_A1.id,
            installmentsTotal: 6,
          },
        },
      };
    }
    if (CARD) {
      return {
        ...base,
        stub: {
          mode: "card",
          toolName: "propose_card_purchase",
          toolArgs: {
            amountCents: 15000,
            description: "supermercado",
            date: "2026-11-07",
            accountId: CARD_A1.id,
          },
        },
      };
    }
    if (TRANSFER) {
      return {
        ...base,
        stub: {
          mode: "transfer",
          toolName: "propose_transfer",
          toolArgs: {
            amountCents: 30000,
            description: "Transferência Itaú → Nubank",
            date: "2026-11-07",
            fromAccountId: ACCOUNT_A1.id,
            toAccountId: ACCOUNT_A2.id,
          },
        },
      };
    }
    if (INCOME) {
      return {
        ...base,
        stub: {
          mode: "income",
          toolName: "propose_income",
          toolArgs: {
            amountCents: 250000,
            description: "salário",
            date: "2026-11-07",
            accountId: ACCOUNT_A2.id,
            categoryId: CATEGORY_SALARY_A.id,
          },
        },
      };
    }
    return {
      ...base,
      stub: {
        mode: "expense",
        toolName: "propose_expense",
        toolArgs: {
          amountCents: 5000,
          description: "mercado",
          date: "2026-11-06",
          accountId: ACCOUNT_A2.id,
          categoryId: CATEGORY_FOOD_A.id,
        },
      },
    };
  }
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
      ...(PROPOSAL ? { TED_OPENCODE_P3_WRITES_ENABLED: "1", NODE_ENV: "test" } : {}),
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

// P3 proposal E2E: the REAL Agent Worker (Durable Objects included) runs as a
// dedicated local child via `wrangler dev --local`. It talks to the synthetic
// API above; the browser reaches it through the PWA same-origin proxy. No
// deploy, no Cloudflare account, no external inference.
type AgentHandle = {
  child: ChildProcess;
  lines: string[];
  stderrTail: string;
  exited: boolean;
  exitCode: unknown;
  pid: number | undefined;
};
let agent: AgentHandle | null = null;

async function startAgent(): Promise<void> {
  if (!AGENT_RUN) return;
  if (agent && !agent.exited) throw new Error("agent already running");
  const agentDir = path.resolve(PWA_ROOT, "../agent");
  const env = {
    ...process.env,
    API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    AGENT_CONFIG_TOKEN: "dev-agent-config-token-32-chars-minimum!",
    AGENT_RUNTIME_ADMIN_TOKEN: "dev-agent-runtime-admin-token-32-chars!",
    AGENT_CONNECTION_TOKEN_SECRET: CONNECTION_SECRET,
    AGENT_AUTH_SERVICE_TOKEN: SERVICE_TOKEN,
    AGENT_DELEGATION_SECRET: DELEGATION_SECRET,
    PWA_ORIGIN: NEXT_ORIGIN,
    ALLOW_LOCAL_ORIGIN: "1",
    NODE_ENV: "development",
    TED_ATTACHMENTS_ENABLED: "0",
    WRANGLER_SEND_METRICS: "false",
  } as Record<string, string | undefined>;
  const args = [
    "exec",
    "wrangler",
    "dev",
    "src/worker.local-entry.ts",
    "--local",
    "--port",
    String(AGENT_PORT),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    AGENT_PERSIST,
    // `wrangler dev` does NOT expose the parent process env as Worker vars.
    // Inject them explicitly (test-only local values; never production).
    ...Object.entries({
      API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      AGENT_CONFIG_TOKEN: "dev-agent-config-token-32-chars-minimum!",
      AGENT_RUNTIME_ADMIN_TOKEN: "dev-agent-runtime-admin-token-32-chars!",
      AGENT_CONNECTION_TOKEN_SECRET: CONNECTION_SECRET,
      AGENT_AUTH_SERVICE_TOKEN: SERVICE_TOKEN,
      AGENT_DELEGATION_SECRET: DELEGATION_SECRET,
      PWA_ORIGIN: NEXT_ORIGIN,
      ALLOW_LOCAL_ORIGIN: "1",
      TED_ATTACHMENTS_ENABLED: "0",
    }).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
  ];
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `pnpm ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`], {
          cwd: agentDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn("pnpm", args, { cwd: agentDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const handle: AgentHandle = { child, lines: [], stderrTail: "", exited: false, exitCode: null, pid: child.pid };
  child.stdout?.on("data", (d) => {
    for (const line of String(d).split("\n")) {
      if (line.trim()) handle.lines.push(line);
    }
  });
  child.stderr?.on("data", (d) => {
    handle.stderrTail = `${handle.stderrTail}${String(d)}`.slice(-3000);
  });
  child.on("close", (code, signal) => {
    handle.exited = true;
    handle.exitCode = signal ? `signal:${signal}` : code;
  });
  child.on("error", () => {
    handle.exited = true;
    handle.exitCode = "spawn-error";
  });
  agent = handle;
  const deadline = Date.now() + 180000;
  for (;;) {
    if (handle.exited) {
      throw new Error(`agent exited before ready (exit=${handle.exitCode}): ${handle.stderrTail.slice(-1200)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/health/agent`);
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > deadline) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      throw new Error(`agent without ready in 180s: ${handle.stderrTail.slice(-1200)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function stopAgent(): Promise<void> {
  if (!agent) return;
  const handle = agent;
  try {
    if (process.platform === "win32" && handle.pid) {
      spawn("taskkill", ["/pid", String(handle.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      handle.child.kill("SIGTERM");
    }
  } catch {
    /* best effort */
  }
  const deadline = Date.now() + 15000;
  while (!handle.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (!handle.exited) {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }
  agent = null;
}

await startProbe();
console.log(`[p2d-stack] gateway=http://127.0.0.1:${GATEWAY_PORT} pid=${probe?.pid}`);
await startAgent();
if (AGENT_RUN) console.log(`[p2d-stack] agent=http://127.0.0.1:${AGENT_PORT} pid=${agent?.pid}`);

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const ctl = http.createServer((req, res) => {
  void (async () => {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/health") {
        json(res, 200, { ok: true, probeRunning: !!probe && !probe.exited, agentRunning: !!agent && !agent.exited });
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
      if (req.method === "GET" && u.pathname === "/p2d/agent-log") {
        json(res, 200, {
          running: !!agent && !agent.exited,
          exitCode: agent?.exitCode ?? null,
          lastLines: (agent?.lines ?? []).slice(-80),
          stderrTail: agent?.stderrTail ?? "",
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
          ["/accounts", "/dashboard", "/categories", "/transactions", "/transfers", "/cards", "/payables", "/budgets", "/goals", "/subscriptions"].some(
            (p) => j.url === p || j.url.startsWith(`${p}/`),
          ),
        );
        json(res, 200, {
          requests: journal,
          financialWrites: financial.filter((j) => j.method !== "GET"),
        });
        return;
      }
      if (req.method === "GET" && u.pathname === "/p2d/expense-state") {
        // Authoritative in-memory ledger AFTER the real V2 executor ran. This
        // is the proof that confirmation created exactly one transaction and
        // rejection created none (no fixture/stub rows are added here). P3.2
        // also exposes the account balances so the income E2E can prove the
        // credit without reading a fixture.
        const transactions = (built.state.transactions ?? [])
          .filter((t) => t.householdId === HOUSEHOLD_A)
          .map((t) => ({
            id: t.id,
            kind: t.kind,
            amountCents: t.amountCents,
            description: t.description,
            date: t.date,
            accountId: t.accountId,
            categoryId: t.categoryId,
            transferToAccountId: t.transferToAccountId,
            statementPaymentId: (t as { statementPaymentId?: string }).statementPaymentId,
          }));
        const accounts = (built.state.accounts ?? [])
          .filter((a) => a.householdId === HOUSEHOLD_A)
          .map((a) => ({ id: a.id, name: a.name, kind: a.kind, balanceCents: a.balanceCents }));
        json(res, 200, { transactions, total: transactions.length, accounts });
        return;
      }
      if (req.method === "GET" && u.pathname === "/p2d/statement-state") {
        const statements = (await built.cardStore.listStatements(HOUSEHOLD_A, CARD_A1.id)).map((s) => ({
          id: s.id,
          accountId: s.accountId,
          cycleYearMonth: s.cycleYearMonth,
          dueDate: s.dueDate,
          totalCents: s.totalCents,
          paidCents: s.paidCents,
          status: s.status,
        }));
        const cardBalanceCents = (built.state.accounts ?? [])
          .filter((a) => a.householdId === HOUSEHOLD_A && a.id === CARD_A1.id)
          .map((a) => a.balanceCents)[0];
        json(res, 200, { statements, cardBalanceCents });
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
    await stopAgent();
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
