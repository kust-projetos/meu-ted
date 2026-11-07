/**
 * P2D live-offline chat — opt-in, real browser, zero external inference.
 *
 * Runs ONLY via `pnpm test:p2d-offline` (launcher sets `P2D_OFFLINE_CHAT=1`
 * and selects this spec with `-g p2d-live-offline`). The file-level skip
 * keeps default P2D runs (`P2D_BROWSER=1`) unaffected.
 *
 * Chain (no transcript import, no canned chat output):
 *   real Chromium → real Next dev PWA → same-origin `/api/backend` proxy →
 *   synthetic Fastify API (in-memory ledger + Better-Auth) for auth/finance;
 *   and same-origin `/api/agent` proxy → real loopback TED gateway (child
 *   process) → real OpenCode SDK 2.2.4 `session.prompt` → local
 *   OpenAI-compatible provider on 127.0.0.1 (dummy key) → real
 *   `list_accounts` + `get_month_summary` tools → real `HttpFinanceTransport`
 *   → real Fastify handlers.
 *
 * Runtime profile is `live`; provider/model come from
 * `apps/ted-runtime/src/live-model.json` (currently
 * `opencode-go/deepseek-v4.1-flash`). The provider ID stays `opencode-go`,
 * but the HTTP endpoint is the loopback stub: no remote OpenCode Go call is
 * configured or made. The non-loopback `fetch` guard is active and counted.
 *
 * HONESTY: the provider is scripted, so `READ_SLICE_PASS` remains NOT
 * ACHIEVED. The credential is the dummy key only (never a real one).
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { resolveP2dPorts } from "../support/ports";

const require = createRequire(__filename);
const { loadLiveModelSelector, validateOfflineChatReceipt } = require(
  "../support/p2d-live-credential.mjs",
) as {
  loadLiveModelSelector: () => string;
  validateOfflineChatReceipt: (receipt: unknown, opts?: { expectedModel?: string }) => true;
};

const ports = resolveP2dPorts(process.env);
const CTL = `http://127.0.0.1:${ports.ctlPort}`;

const CHAT_TEXT = "Quais contas eu tenho e quanto gastei em junho de 2026?";
const FINANCE_TOOL_NAMES = ["list_accounts", "get_month_summary", "list_categories"];
const FINANCIAL_PREFIXES = [
  "/accounts",
  "/dashboard",
  "/categories",
  "/transactions",
  "/cards",
  "/payables",
  "/budgets",
  "/goals",
  "/subscriptions",
];

function formatCentsBRL(cents: number): string {
  const [whole, decimals] = (cents / 100).toFixed(2).split(".");
  return `R$ ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimals}`;
}
const EXPECTED_JUNE_EXPENSE = formatCentsBRL(288_050); // R$ 2.880,50
const READ_SLICE_PASS = "NOT_ACHIEVED" as const;

type Stats = {
  mode?: string;
  profile?: string;
  provider?: string;
  model?: string;
  agent?: string | null;
  sessionId?: string | null;
  providerLoopback?: boolean;
  credentialSource?: string;
  credentialPresent?: boolean;
  fetchGuard?: string;
  sdkProviderID?: string | null;
  sdkModelID?: string | null;
  promptCalls?: number;
  transportCalls?: number;
  messageLists?: number;
  stubTurns?: number;
  stubModels?: Array<string | null>;
  offeredTools?: string[];
  stubRemotes?: string[];
  stubMismatches?: string[];
  fetchBlockedCatalog?: number;
  fetchBlockedUnexpected?: number;
  fetchAllowedLoopback?: number;
  retryHookAvailable?: boolean;
  retryHookRegistered?: boolean;
  retryHookInvocations?: number;
  retryVetoes?: number;
  financeReads?: Array<{ route?: string; method?: string; statusCode?: number }>;
};

type Snapshot = {
  userMessages?: unknown[];
  assistantMessages?: unknown[];
};

type Journal = {
  requests?: Array<{ method?: string; url?: string }>;
  financialWrites?: unknown[];
};

async function ctlGet(pathname: string): Promise<unknown> {
  const res = await fetch(`${CTL}${pathname}`);
  if (!res.ok) throw new Error(`ctl GET ${pathname} -> ${res.status}`);
  return res.json();
}
async function ctlPost(pathname: string): Promise<unknown> {
  const res = await fetch(`${CTL}${pathname}`, { method: "POST" });
  if (!res.ok) throw new Error(`ctl POST ${pathname} -> ${res.status}`);
  return res.json();
}
function isFinancial(url: string): boolean {
  const pathname = url.split("?")[0];
  return FINANCIAL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Native-history proof: exactly one user message across the tracked
 * conversations (the SDK-visible truth, not just the prompt counter).
 */
async function nativeUserMessages(): Promise<{ total: number; perConversation: number[] }> {
  const list = (await ctlGet("/p2d/snapshot-list")) as { conversations?: string[] };
  const perConversation: number[] = [];
  let total = 0;
  for (const id of list.conversations ?? []) {
    const snap = (await ctlGet(`/p2d/snapshot?id=${id}`)) as Snapshot;
    const count = (snap.userMessages ?? []).length;
    perConversation.push(count);
    total += count;
  }
  return { total, perConversation };
}

test.describe.configure({ mode: "serial" });

test.describe("p2d-live-offline (profile live, loopback provider)", () => {
  test.skip(process.env.P2D_OFFLINE_CHAT !== "1", "opt-in only: run via pnpm test:p2d-offline");

  test("exact prompt → two finance tools → two GETs → no retry → orderly close", async ({ page }, testInfo) => {
    expect(READ_SLICE_PASS).toBe("NOT_ACHIEVED");
    const model = loadLiveModelSelector();
    const modelID = model.split("/")[1];

    // Browser-level proof: exactly ONE POST to the native `/rpc/chat` route
    // (provider POSTs to the loopback stub are a different layer and must
    // never be confused with user messages).
    const chatPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      let pathname = "";
      try {
        pathname = new URL(request.url()).pathname;
      } catch {
        return;
      }
      if (pathname.endsWith("/rpc/chat")) chatPosts.push(request.url());
    });

    // 1. Stack health + baseline: mode/profile/provider/model exact, zero
    // prompt/provider/tool calls before the turn.
    const health = (await ctlGet("/health")) as { ok?: boolean };
    expect(health.ok).toBe(true);
    const baseline = (await ctlGet("/p2d/stats")) as Stats;
    expect(baseline.mode).toBe("offline");
    expect(baseline.profile).toBe("live");
    expect(baseline.provider).toBe("opencode-go");
    expect(baseline.model).toBe(model);
    expect(baseline.sdkProviderID).toBe("opencode-go");
    expect(baseline.sdkModelID).toBe(modelID);
    expect(baseline.credentialSource).toBe("dummy");
    expect(baseline.credentialPresent).toBe(true);
    expect(baseline.providerLoopback).toBe(true);
    expect(baseline.fetchGuard).toBe("loopback-only");
    expect(baseline.promptCalls).toBe(0);
    expect(baseline.transportCalls).toBe(0);
    expect(baseline.stubTurns).toBe(0);
    const journal0 = (await ctlGet("/p2d/journal")) as Journal;
    const journal0Len = (journal0.requests ?? []).length;

    // 2. Synthetic user setup through the real proxy (browser carries Origin).
    const email = "ted-p2d-offline@example.test";
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
    const signupStatus = await page.evaluate(async (userEmail) => {
      const res = await fetch("/api/backend/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P2D Offline" }),
      });
      return res.status;
    }, email);
    expect(signupStatus).toBe(200);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("test-password-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    const launcher = page.getByRole("button", { name: /abrir assistente ted/i });
    await expect(launcher.first()).toBeVisible({ timeout: 60000 });

    // 3. Open TED and send the exact prompt through the real UI.
    await launcher.first().click();
    const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
    await expect(input).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 120000 });
    await input.fill(CHAT_TEXT);
    await page.getByRole("button", { name: /enviar mensagem/i }).click();

    // 4. The displayed answer comes from the observed DTOs (accounts + June).
    await expect(page.getByText("Itaú", { exact: false }).first()).toBeVisible({ timeout: 300000 });
    await expect(page.getByText("Nubank", { exact: false }).first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText(EXPECTED_JUNE_EXPENSE, { exact: false }).first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("junho de 2026", { exact: false }).first()).toBeVisible({ timeout: 60000 });

    // 5. Aggregate proof: ONE admitted prompt, exactly the two finance tools,
    // exactly two GETs, zero writes, no automatic retry/fallback.
    const stats = (await ctlGet("/p2d/stats")) as Stats;
    expect(stats.mode).toBe("offline");
    expect(stats.profile).toBe("live");
    expect(stats.provider).toBe("opencode-go");
    expect(stats.model).toBe(model);
    expect(stats.agent).toBe("ted");
    expect(stats.credentialSource).toBe("dummy");
    expect(stats.credentialPresent).toBe(true);
    expect(stats.sdkProviderID).toBe("opencode-go");
    expect(stats.sdkModelID).toBe(modelID);
    expect(stats.providerLoopback).toBe(true);
    expect(stats.fetchGuard).toBe("loopback-only");
    expect(stats.promptCalls).toBe(1);
    expect(stats.stubTurns).toBe(3);
    // Each of the 3 loopback POSTs (2 tool-calls + final) carries the exact
    // modelID from live-model.json — the local HTTP provider, never Go.
    expect(stats.stubModels).toEqual([modelID, modelID, modelID]);
    expect(stats.transportCalls).toBe(2);
    expect(stats.stubMismatches).toEqual([]);
    expect(stats.retryHookAvailable).toBe(true);
    expect(stats.retryHookRegistered).toBe(true);
    expect(stats.retryHookInvocations).toBe(0);
    expect(stats.retryVetoes).toBe(0);

    // Exactly one browser POST to `/rpc/chat` and exactly one native user
    // message: provider POSTs are NOT user messages.
    expect(chatPosts.length).toBe(1);
    const native = await nativeUserMessages();
    expect(native.total).toBe(1);
    expect(native.perConversation.filter((n) => n > 0)).toEqual([1]);
    expect(stats.fetchBlockedUnexpected).toBe(0);
    expect(stats.fetchAllowedLoopback).toBeGreaterThan(0);
    const loopbackRemotes = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
    expect((stats.stubRemotes ?? []).length).toBe(3);
    expect((stats.stubRemotes ?? []).every((r) => loopbackRemotes.has(String(r)))).toBe(true);

    const financeTools = (stats.offeredTools ?? [])
      .filter((n) => FINANCE_TOOL_NAMES.includes(n))
      .sort();
    expect(financeTools).toEqual(["get_month_summary", "list_accounts"]);

    const reads = stats.financeReads ?? [];
    expect(reads.length).toBe(2);
    expect(reads.every((r) => r.method === "GET")).toBe(true);
    const routes = reads.map((r) => String(r.route ?? "").split("?")[0]);
    expect(routes.filter((r) => r === "/accounts").length).toBe(1);
    expect(routes.filter((r) => r === "/dashboard/month-summary").length).toBe(1);
    expect(reads.some((r) => String(r.route ?? "").includes("2026-06"))).toBe(true);

    // 6. Strict offline receipt: the allowlist rejects any credential field.
    validateOfflineChatReceipt(
      {
        ok: true,
        phase: "offline-chat-ready",
        mode: stats.mode,
        profile: stats.profile,
        provider: stats.provider,
        model: stats.model,
        agent: stats.agent,
        providerLoopback: stats.providerLoopback,
        credentialSource: stats.credentialSource,
        fetchGuard: stats.fetchGuard,
      },
      { expectedModel: model },
    );

    // 7. Journal delta after the turn: no financial writes and GET-only.
    // `stats.financeReads` above is the exact TOOL-driven set (two GETs);
    // the journal is broader (the PWA may load its own dashboard), so it is
    // used only to prove no write and that both tool routes are GETs.
    const journal = (await ctlGet("/p2d/journal")) as Journal;
    expect(journal.financialWrites).toEqual([]);
    const delta = (journal.requests ?? []).slice(journal0Len);
    const financialDelta = delta.filter((j) => isFinancial(String(j.url ?? "")));
    expect(financialDelta.every((j) => j.method === "GET")).toBe(true);
    const journalRoutes = financialDelta.map((j) => String(j.url ?? "").split("?")[0]);
    expect(journalRoutes.filter((r) => r === "/accounts").length).toBeGreaterThanOrEqual(1);
    expect(journalRoutes.filter((r) => r === "/dashboard/month-summary").length).toBeGreaterThanOrEqual(1);

    // 8. Natural teardown: orderly probe close (no force), exit code 0.
    await page.goto("about:blank");
    const closed = (await ctlPost("/p2d/close-probe")) as {
      ok?: boolean;
      exitCode?: unknown;
      pid?: number;
      forced?: boolean;
      lastLines?: unknown;
      stderrTail?: unknown;
    };
    expect(closed.ok).toBe(true);
    if (closed.forced) {
      console.log(`[p2d-offline] close forced; receipt=${JSON.stringify(closed).slice(0, 3000)}`);
    }
    expect(closed.forced).toBe(false);
    expect(closed.exitCode).toBe(0);
    expect(typeof closed.pid).toBe("number");

    // 9. Bounded, redacted evidence (IDs/counts/statuses only; no credential).
    const evidence = {
      scope: "p2d-live-offline",
      mode: stats.mode,
      profile: stats.profile,
      provider: stats.provider,
      model: stats.model,
      agent: stats.agent,
      prompt: CHAT_TEXT,
      aggregatePrompts: 1,
      aggregateBrowserChatPosts: chatPosts.length,
      aggregateNativeUserMessages: native.total,
      aggregateProviderPosts: stats.stubTurns,
      aggregateTransportCalls: stats.transportCalls,
      aggregateListAccounts: 1,
      aggregateGetMonthSummary: 1,
      aggregateFinancialWrites: 0,
      sdkProviderID: stats.sdkProviderID,
      sdkModelID: stats.sdkModelID,
      retryHookAvailable: stats.retryHookAvailable,
      retryHookRegistered: stats.retryHookRegistered,
      retryHookInvocations: stats.retryHookInvocations,
      retryVetoes: stats.retryVetoes,
      providerLoopback: stats.providerLoopback,
      credentialSource: stats.credentialSource,
      closeForced: false,
      closeExitCode: 0,
      readSlicePass: READ_SLICE_PASS,
    };
    const serialized = JSON.stringify(evidence, null, 2);
    expect(serialized).not.toMatch(/cookie|token|secret|password|bearer/i);
    const outDir = path.resolve(process.cwd(), "test-results", "p2d-live-offline");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "evidence.json");
    fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
    await testInfo.attach("p2d-live-offline-evidence", { path: outPath, contentType: "application/json" });
  });
});
