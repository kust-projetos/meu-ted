/**
 * P2D live-real chat — FUTURE opt-in, real provider/model, not run by CI.
 *
 * Runs ONLY via `pnpm test:p2d-live-real` (launcher sets `P2D_LIVE_REAL=1`
 * and selects this spec with `-g p2d-live-real`). The file-level skip keeps
 * every other P2D run unaffected.
 *
 * Secrecy boundary: the real credential is NEVER read by this spec, by the
 * Playwright config, by the stack, by Next or by the PWA. The isolated
 * runtime child (probe) loads the alias `OPENCODE_GO` from the two
 * allowlisted local `.env` files and supplies it as `OPENCODE_GO_API_KEY`;
 * `setupIsolation` scrubs the inherited env and preserves only that alias, and
 * then the probe — on the live-real path only — translates the alias into the
 * native `OPENCODE_API_KEY` (the key OpenCode 2.2.4 resolves for
 * `opencode-go`) and removes the alias. Neither the prep path nor the product
 * bootstrap performs that translation. It never writes/logs the value. This
 * spec only observes structural counters (IDs/counts/statuses), never the
 * credential.
 *
 * HONESTY: this file is wired but was NOT executed in the current change
 * (no provider authorization). `READ_SLICE_PASS` stays NOT ACHIEVED. Do NOT
 * run it until the operator explicitly confirms the authorization scope, the
 * current quota and Extra Usage.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { resolveP2dPorts } from "../support/ports";
import { validateLiveRealEgress } from "../support/live-real-classification";

const require = createRequire(__filename);
const { loadLiveModelSelector } = require("../support/p2d-live-credential.mjs") as {
  loadLiveModelSelector: () => string;
};

const ports = resolveP2dPorts(process.env);
const CTL = `http://127.0.0.1:${ports.ctlPort}`;

const CHAT_TEXT = "Quais contas eu tenho e quanto gastei em junho de 2026?";
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
  stubTurns?: number;
  offeredTools?: string[];
  stubMismatches?: string[];
  fetchBlockedUnexpected?: number;
  retryHookAvailable?: boolean;
  retryHookRegistered?: boolean;
  retryHookInvocations?: number;
  retryVetoes?: number;
  financeReads?: Array<{ route?: string; method?: string; statusCode?: number; body?: unknown }>;
  liveFetchGuard?: {
    catalogAllowed?: number;
    inferenceAttempts?: number;
    inferenceAllowed?: number;
    inferenceFailures?: number;
    apiAllowed?: number;
    apiBlocked?: number;
    blocked?: number;
    redirectsBlocked?: number;
    catalogStatuses?: number[];
    inferenceStatuses?: number[];
    apiStatuses?: number[];
    inferenceModels?: string[];
    blockedReasons?: Record<string, number>;
  } | null;
  financeToolNames?: string[] | null;
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
async function nativeMessages(): Promise<{ userTotal: number; perConversation: number[]; assistantTotal: number }> {
  const list = (await ctlGet("/p2d/snapshot-list")) as { conversations?: string[] };
  const perConversation: number[] = [];
  let userTotal = 0;
  let assistantTotal = 0;
  for (const id of list.conversations ?? []) {
    const snap = (await ctlGet(`/p2d/snapshot?id=${id}`)) as Snapshot;
    const users = (snap.userMessages ?? []).length;
    perConversation.push(users);
    userTotal += users;
    if (users > 0) assistantTotal += (snap.assistantMessages ?? []).length;
  }
  return { userTotal, perConversation, assistantTotal };
}

test.describe.configure({ mode: "serial" });

test.describe("p2d-live-real (real provider, opt-in only)", () => {
  test.skip(process.env.P2D_LIVE_REAL !== "1", "opt-in only: run via pnpm test:p2d-live-real");

  test("exact prompt → two finance tools → two GETs → no retry → orderly close", async ({ page }, testInfo) => {
    const model = loadLiveModelSelector();
    const modelID = model.split("/")[1];

    // Browser-level proof: exactly ONE POST to the native `/rpc/chat` route.
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

    const health = (await ctlGet("/health")) as { ok?: boolean };
    expect(health.ok).toBe(true);
    const baseline = (await ctlGet("/p2d/stats")) as Stats;
    expect(baseline.mode).toBe("live-real");
    expect(baseline.profile).toBe("live");
    expect(baseline.provider).toBe("opencode-go");
    expect(baseline.model).toBe(model);
    expect(baseline.sdkProviderID).toBe("opencode-go");
    expect(baseline.sdkModelID).toBe(modelID);
    expect(baseline.credentialSource).toBe("allowlist");
    expect(baseline.credentialPresent).toBe(true);
    expect(baseline.providerLoopback).toBe(false);
    expect(baseline.fetchGuard).toBe("live-real-allowlist");
    expect(baseline.promptCalls).toBe(0);
    expect(baseline.transportCalls).toBe(0);
    const journal0 = (await ctlGet("/p2d/journal")) as Journal;
    const journal0Len = (journal0.requests ?? []).length;

    const email = "ted-p2d-live-real@example.test";
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
    const signupStatus = await page.evaluate(async (userEmail) => {
      const res = await fetch("/api/backend/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P2D Live" }),
      });
      return res.status;
    }, email);
    expect(signupStatus).toBe(200);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("test-password-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    const launcher = page.getByRole("button", { name: /abrir assistente ted/i });
    await expect(launcher.first()).toBeVisible({ timeout: 60000 });

    await launcher.first().click();
    const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
    await expect(input).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 120000 });
    await input.fill(CHAT_TEXT);
    await page.getByRole("button", { name: /enviar mensagem/i }).click();

    // Real model: wait for the admitted turn + both finance tools + an
    // assistant message (no exact wording assertion — that is model output).
    await expect
      .poll(async () => {
        const s = (await ctlGet("/p2d/stats")) as Stats;
        return [s.promptCalls ?? 0, s.transportCalls ?? 0];
      }, { timeout: 300000, intervals: [1000, 2000, 5000] })
      .toEqual([1, 2]);
    await expect
      .poll(async () => (await nativeMessages()).assistantTotal, { timeout: 300000, intervals: [1000, 2000, 5000] })
      .toBeGreaterThanOrEqual(1);

    const stats = (await ctlGet("/p2d/stats")) as Stats;
    expect(stats.mode).toBe("live-real");
    expect(stats.profile).toBe("live");
    expect(stats.provider).toBe("opencode-go");
    expect(stats.model).toBe(model);
    expect(stats.agent).toBe("ted");
    expect(stats.credentialSource).toBe("allowlist");
    expect(stats.credentialPresent).toBe(true);
    expect(stats.sdkProviderID).toBe("opencode-go");
    expect(stats.sdkModelID).toBe(modelID);
    expect(stats.providerLoopback).toBe(false);
    expect(stats.fetchGuard).toBe("live-real-allowlist");
    expect(stats.promptCalls).toBe(1);
    // Exactly the two tool-driven finance transport calls the acceptance
    // requires — a third call (duplicate/extra tool invocation) fails here.
    expect(stats.transportCalls).toBe(2);
    expect(stats.stubMismatches ?? []).toEqual([]);
    expect(stats.retryHookAvailable).toBe(true);
    expect(stats.retryHookRegistered).toBe(true);
    expect(stats.retryHookInvocations).toBe(0);
    expect(stats.retryVetoes).toBe(0);

    // Exactly one browser POST and exactly one native user message.
    expect(chatPosts.length).toBe(1);
    const native = await nativeMessages();
    expect(native.userTotal).toBe(1);
    expect(native.perConversation.filter((n) => n > 0)).toEqual([1]);

    // Allowlist-only egress: no redirect was ever followed (a redirect is a
    // hard failure) and the official inference host was reached. Blocked
    // counts are observed as categories only (no URL/body/header values).
    const guard = stats.liveFetchGuard ?? {};
    expect(guard.redirectsBlocked ?? 0).toBe(0);
    expect(guard.inferenceAllowed ?? 0).toBeGreaterThanOrEqual(1);
    // Every inference POST is model-pinned BEFORE the socket: the guard
    // validated the OpenAI-compatible body against the exact modelID from
    // live-model.json, so a provider/model fallback could never have received
    // the credential. At least one attempt exists, none failed, and every
    // captured model equals the pinned id.
    expect(guard.inferenceAttempts ?? 0).toBeGreaterThanOrEqual(1);
    expect(guard.inferenceFailures ?? 0).toBe(0);
    expect((guard.inferenceModels ?? []).length).toBeGreaterThanOrEqual(1);
    for (const observed of guard.inferenceModels ?? []) {
      expect(observed).toBe(modelID);
    }
    // Every observed inference response was a 2xx (no redirect/error status).
    // The exact number of provider POSTs is NOT asserted: a tool loop may
    // legitimately combine or split calls (2 or 3+), so only the minimum is
    // required.
    expect((guard.inferenceStatuses ?? []).length).toBeGreaterThanOrEqual(1);
    expect((guard.inferenceStatuses ?? []).every((s) => s >= 200 && s < 300)).toBe(true);

    // Loopback API allowlist: the probe's own gateway identity mint/device
    // resolution plus the two finance GETs reach the synthetic Fastify API
    // through the SAME guard. Nothing was blocked and every allowed API
    // response was a 200.
    expect(guard.apiBlocked ?? 0).toBe(0);
    expect(guard.apiAllowed ?? 0).toBeGreaterThanOrEqual(4);
    expect((guard.apiStatuses ?? []).length).toBeGreaterThanOrEqual(4);
    expect((guard.apiStatuses ?? []).every((s) => s === 200)).toBe(true);

    // Effective egress validation: derive per-reason blocked requests from the
    // guard's aggregated `blockedReasons` (real reasons, no URLs/headers/creds)
    // and validate them with validateLiveRealEgress. Functional blockages fail;
    // unidentified (unknown destination) are recorded but do not pass silently.
    const blockedRequests = Object.entries(guard.blockedReasons ?? {}).flatMap(
      ([reason, count]) =>
        Array.from({ length: Number(count) || 0 }, () => ({ reason, blocked: true })),
    );
    const egress = validateLiveRealEgress(blockedRequests);
    expect(egress.functionalBlocked).toBe(0);
    // unidentifiedBlocked is observed (historical pending origin of the ten
    // blocked requests) and recorded in evidence; it does not silently pass.

    // Effective catalog captured inside the product plugin: exactly the two
    // finance tools (list_categories stays opt-in/off).
    expect(stats.financeToolNames).toEqual(["get_month_summary", "list_accounts"]);

    // No stub exists in live-real, so there is no provider-request capture:
    // the executed tools are proven by the finance transport routes below.
    // The slice is EXACT: one GET /accounts and one
    // GET /dashboard/month-summary?yearMonth=2026-06 — nothing else, no
    // duplicate tool call, no write.
    const reads = stats.financeReads ?? [];
    expect(reads.length).toBe(2);
    expect(reads.every((r) => r.method === "GET")).toBe(true);
    // live-real stats keep route/method/status only — never the DTO body.
    expect(reads.every((r) => !("body" in r))).toBe(true);
    const routes = reads.map((r) => String(r.route ?? "").split("?")[0]);
    const listAccountsCount = routes.filter((r) => r === "/accounts").length;
    const getMonthSummaryCount = routes.filter((r) => r === "/dashboard/month-summary").length;
    expect(listAccountsCount).toBe(1);
    expect(getMonthSummaryCount).toBe(1);
    // The summary read carries the exact month the prompt asked for.
    const monthSummaryRoute = String(
      reads.find((r) => String(r.route ?? "").split("?")[0] === "/dashboard/month-summary")?.route ?? "",
    );
    expect(monthSummaryRoute).toContain("yearMonth=2026-06");

    // Journal delta after the turn: no financial writes and GET-only. The
    // journal is broader than the tool slice (the PWA loads its own
    // dashboard), so the EXACT two-read contract is proven above by
    // `stats.financeReads`; here only no-write + both routes present as GETs
    // is required.
    const journal = (await ctlGet("/p2d/journal")) as Journal;
    expect(journal.financialWrites).toEqual([]);
    const delta = (journal.requests ?? []).slice(journal0Len);
    const financialDelta = delta.filter((j) => isFinancial(String(j.url ?? "")));
    expect(financialDelta.every((j) => j.method === "GET")).toBe(true);
    const journalRoutes = financialDelta.map((j) => String(j.url ?? "").split("?")[0]);
    expect(journalRoutes.filter((r) => r === "/accounts").length).toBeGreaterThanOrEqual(1);
    expect(journalRoutes.filter((r) => r === "/dashboard/month-summary").length).toBeGreaterThanOrEqual(1);

    await page.goto("about:blank");
    const closed = (await ctlPost("/p2d/close-probe")) as {
      ok?: boolean;
      exitCode?: unknown;
      pid?: number;
      forced?: boolean;
    };
    expect(closed.ok).toBe(true);
    expect(closed.forced).toBe(false);
    expect(closed.exitCode).toBe(0);
    expect(typeof closed.pid).toBe("number");

    const evidence = {
      scope: "p2d-live-real",
      mode: stats.mode,
      profile: stats.profile,
      provider: stats.provider,
      model: stats.model,
      agent: stats.agent,
      prompt: CHAT_TEXT,
      aggregatePrompts: 1,
      aggregateBrowserChatPosts: chatPosts.length,
      aggregateNativeUserMessages: native.userTotal,
      aggregateTransportCalls: stats.transportCalls,
      aggregateListAccounts: listAccountsCount,
      aggregateGetMonthSummary: getMonthSummaryCount,
      aggregateFinancialWrites: 0,
      sdkProviderID: stats.sdkProviderID,
      sdkModelID: stats.sdkModelID,
      retryHookAvailable: stats.retryHookAvailable,
      retryHookRegistered: stats.retryHookRegistered,
      retryHookInvocations: stats.retryHookInvocations,
      retryVetoes: stats.retryVetoes,
      fetchGuardBlocked: guard.blocked ?? 0,
      fetchGuardRedirectsBlocked: guard.redirectsBlocked ?? 0,
      fetchGuardInferenceAttempts: guard.inferenceAttempts ?? 0,
      fetchGuardInferenceAllowed: guard.inferenceAllowed ?? 0,
      fetchGuardInferenceFailures: guard.inferenceFailures ?? 0,
      fetchGuardInferenceStatuses: guard.inferenceStatuses ?? [],
      fetchGuardInferenceModels: guard.inferenceModels ?? [],
      fetchGuardApiAllowed: guard.apiAllowed ?? 0,
      fetchGuardApiBlocked: guard.apiBlocked ?? 0,
      fetchGuardBlockedReasons: guard.blockedReasons ?? {},
      fetchGuardEgressFunctionalBlocked: egress.functionalBlocked,
      fetchGuardEgressAuxiliaryBlocked: egress.auxiliaryBlocked,
      fetchGuardEgressUnidentifiedBlocked: egress.unidentifiedBlocked,
      financeToolNames: stats.financeToolNames ?? [],
      credentialSource: stats.credentialSource,
      closeForced: false,
      closeExitCode: 0,
      readSlicePass: "NOT_ACHIEVED",
    };
    const serialized = JSON.stringify(evidence, null, 2);
    expect(serialized).not.toMatch(/cookie|token|secret|password|bearer/i);
    const outDir = path.resolve(process.cwd(), "test-results", "p2d-live-real");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "evidence.json");
    fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
    await testInfo.attach("p2d-live-real-evidence", { path: outPath, contentType: "application/json" });
  });
});
