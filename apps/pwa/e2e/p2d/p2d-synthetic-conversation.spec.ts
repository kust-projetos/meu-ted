/**
 * P2D synthetic conversation — ONE real-browser scenario (test-only, loopback).
 *
 * Chain (exact, no transcript import, no canned chat output):
 *   real Chromium (Playwright `p2d-synthetic` project, real Next dev PWA) →
 *   same-origin PWA proxy `/api/backend` → real Fastify `buildTestApp`
 *   (synthetic in-memory ledger + synthetic Better-Auth) for signup/login,
 *   device, workspace and finance reads; and PWA proxy `/api/agent` (B
 *   branch, `TED_OPENCODE_GATEWAY_ORIGIN` loopback) → loopback TED gateway
 *   real (`createGatewayServer`, child process) → real OpenCode SDK 2.2.4
 *   prompt loop (`session.prompt`) → LOCAL scripted OpenAI-compatible stub
 *   (loopback, dummy apiKey, zero paid/external inference) → actual
 *   read-only finance tools (`list_accounts` + `get_month_summary`) → real
 *   `HttpFinanceTransport` → actual Fastify handlers (Itaú/Nubank + June
 *   oracle) → derived answer displayed in the REAL TedChat UI.
 *
 * Proven in ONE scenario: exact prompt
 * `Quais contas eu tenho e quanto gastei em junho de 2026?` in ONE admitted
 * conversation; displayed answer names the accounts and the June summary;
 * `page.reload()` keeps the answer with zero new prompt/tool calls; the
 * OpenCode subprocess is closed orderly (exit awaited) and a NEW OS process
 * starts with the exact same persistent root; reopening in the browser shows
 * the same opaque conversation ID, native session ID and user+assistant
 * message IDs/content with no replayed tools/prompt. Aggregate:
 * prompts=1, list_accounts=1, get_month_summary=1, financial writes=0.
 *
 * HONESTY: the provider is a local scripted stub, so this is NOT an
 * external-model proof and READ_SLICE_PASS remains NOT ACHIEVED (asserted
 * below, recorded in the evidence file, and never upgraded by this spec).
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { resolveP2dPorts } from "../support/ports";

const ports = resolveP2dPorts(process.env);
const CTL = `http://127.0.0.1:${ports.ctlPort}`;

const CHAT_TEXT = "Quais contas eu tenho e quanto gastei em junho de 2026?";
// Independent recomputation (same rationale as the route-level proof):
// equality of the DISPLAYED text with this value proves DTOs →
// provider-context → UI instead of a canned string.
function formatCentsBRL(cents: number): string {
  const [whole, decimals] = (cents / 100).toFixed(2).split(".");
  return `R$ ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimals}`;
}
const EXPECTED_JUNE_EXPENSE = formatCentsBRL(288_050); // R$ 2.880,50

// NOT ACHIEVED by design: the local scripted provider proves wiring and
// persistence, never external model quality. This constant is asserted and
// recorded, never upgraded by this spec.
const READ_SLICE_PASS = "NOT_ACHIEVED" as const;

type Snapshot = {
  phase?: string;
  conversationId?: string;
  runtimeSessionId?: string;
  userMessages?: Array<{ id: string; hash: string }>;
  assistantMessages?: Array<{ id: string; hash: string }>;
  promptCalls?: number;
  transportCalls?: number;
  stubTurns?: number;
  financeReads?: Array<{ route?: string; method?: string; statusCode?: number }>;
  error?: string;
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

test.describe.configure({ mode: "serial" });

test.describe("p2d synthetic conversation (real browser, restart persistence)", () => {
  test("chat → reload → orderly restart → reopen keeps IDs with no replay", async ({ page }, testInfo) => {
    expect(READ_SLICE_PASS).toBe("NOT_ACHIEVED");

    // 1. Stack health + zero baseline: no prompt/tool call before the turn.
    const health = (await ctlGet("/health")) as { ok?: boolean };
    expect(health.ok).toBe(true);
    const baseline = (await ctlGet("/p2d/stats")) as { promptCalls?: number; transportCalls?: number; stubTurns?: number };
    expect(baseline.promptCalls).toBe(0);
    expect(baseline.transportCalls).toBe(0);
    expect(baseline.stubTurns).toBe(0);

    // 2. Synthetic user setup (test-only identity, seeded by the stack):
    // account created through the real proxy → real Better-Auth, from INSIDE
    // the browser (browser fetch carries Origin, which the PWA proxy CSRF
    // gate requires for POST — a server-side request without Origin is
    // refused 403 by design). The AUTHENTICATION itself happens in the
    // browser below (real login UI → real session cookie).
    const email = "ted-p2d-browser@example.test";
    // Deterministic order (no boot race): the login form proves the clean
    // unauthenticated start (boot probe settled). ONLY then create the
    // account from inside the browser and sign in through the real UI.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
    const signupStatus = await page.evaluate(async (userEmail) => {
      const res = await fetch("/api/backend/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P2D Browser" }),
      });
      return res.status;
    }, email);
    expect(signupStatus).toBe(200);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("test-password-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    const launcher = page.getByRole("button", { name: /abrir assistente ted/i });
    await expect(launcher.first()).toBeVisible({ timeout: 60000 });

    // 4. Open TED, wait for the session to leave "conectando.", send the
    // exact prompt through the REAL TedChat → real client → real route.
    await launcher.first().click();
    const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
    await expect(input).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 120000 });
    await input.fill(CHAT_TEXT);
    await page.getByRole("button", { name: /enviar mensagem/i }).click();
    // The displayed answer carries BOTH proofs: account names + June summary.
    await expect(page.getByText("Itaú", { exact: false }).first()).toBeVisible({ timeout: 300000 });
    await expect(page.getByText("Nubank", { exact: false }).first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText(EXPECTED_JUNE_EXPENSE, { exact: false }).first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("junho de 2026", { exact: false }).first()).toBeVisible({ timeout: 60000 });

    // 5. Stability snapshot: ONE conversation, ONE prompt, exactly one call
    // each to /accounts and /dashboard/month-summary, financial writes=0.
    // 5. Stability snapshot: exactly ONE conversation holds the turn (TED
    // opens a session/new on mount; React StrictMode in `next dev` can
    // double-mount and mint extra EMPTY sessions — those carry zero user
    // messages and zero prompts; the proof below pins the conversation that
    // actually holds the admitted turn). ONE prompt, exactly one call each
    // to /accounts and /dashboard/month-summary, financial writes=0.
    const list = (await ctlGet("/p2d/snapshot-list")) as { conversations?: string[] };
    expect(Array.isArray(list.conversations)).toBe(true);
    const candidates: Snapshot[] = [];
    for (const id of list.conversations ?? []) {
      candidates.push((await ctlGet(`/p2d/snapshot?id=${id}`)) as Snapshot);
    }
    expect(candidates.every((c) => c.error === undefined)).toBe(true);
    const chatted = candidates.filter((c) => (c.userMessages ?? []).length >= 1);
    expect(chatted.length).toBe(1);
    const conversationId = String(chatted[0].conversationId ?? "");
    expect(conversationId.length).toBeGreaterThan(0);
    const snap = chatted[0];
    expect(snap.conversationId).toBe(conversationId);
    expect(typeof snap.runtimeSessionId).toBe("string");
    expect((snap.userMessages ?? []).length).toBeGreaterThanOrEqual(1);
    expect((snap.assistantMessages ?? []).length).toBeGreaterThanOrEqual(1);
    expect(snap.promptCalls).toBe(1);
    expect(snap.transportCalls).toBe(2);
    expect(snap.stubTurns).toBe(3);
    const routes = (snap.financeReads ?? []).map((r) => String(r.route ?? ""));
    expect(routes.filter((r) => r.split("?")[0] === "/accounts").length).toBe(1);
    expect(routes.filter((r) => r.startsWith("/dashboard/month-summary")).length).toBe(1);
    expect(routes.some((r) => r.includes("2026-06"))).toBe(true);

    // 6. Real browser reload: same answer, zero new prompt/tool calls, same
    // opaque conversation ID, native session ID and message IDs/content.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Itaú", { exact: false }).first()).toBeVisible({ timeout: 120000 });
    await expect(page.getByText(EXPECTED_JUNE_EXPENSE, { exact: false }).first()).toBeVisible({ timeout: 60000 });
    const afterReloadStats = (await ctlGet("/p2d/stats")) as { promptCalls?: number; transportCalls?: number; stubTurns?: number };
    expect(afterReloadStats.promptCalls).toBe(1);
    expect(afterReloadStats.transportCalls).toBe(2);
    expect(afterReloadStats.stubTurns).toBe(3);
    const snapReload = (await ctlGet(`/p2d/snapshot?id=${conversationId}`)) as Snapshot;
    expect(snapReload.error).toBeUndefined();
    expect(snapReload.runtimeSessionId).toBe(snap.runtimeSessionId);
    expect(snapReload.userMessages).toEqual(snap.userMessages);
    expect(snapReload.assistantMessages).toEqual(snap.assistantMessages);

    // 7. Unload the PWA first (drops any live browser→proxy→gateway
    // streams so shutdown observes a quiescent gateway), then orderly close
    // of the OpenCode subprocess: exit awaited (proves orderly shutdown +
    // sqlite persistence, never a kill-and-hope).
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
      // Diagnostic only (never evidence): distinguish crash vs stall.
      console.log(`[p2d] close forced; receipt=${JSON.stringify(closed).slice(0, 3000)}`);
    }
    expect(closed.forced).toBe(false);
    const firstPid = closed.pid;
    expect(typeof firstPid).toBe("number");

    // 8. NEW OS process with the exact same persistent root (coordinator
    // holds the root; the spec only observes the new pid + readiness).
    const started = (await ctlPost("/p2d/start-probe")) as { ok?: boolean; pid?: number };
    expect(started.ok).toBe(true);
    expect(typeof started.pid).toBe("number");
    expect(started.pid).not.toBe(firstPid);
    const freshStats = (await ctlGet("/p2d/stats")) as { promptCalls?: number; transportCalls?: number; stubTurns?: number };
    expect(freshStats.promptCalls).toBe(0);
    expect(freshStats.transportCalls).toBe(0);
    expect(freshStats.stubTurns).toBe(0);

    // 9. Reopen in the browser (same context/cookies, TED remount fetches
    // history for the pinned conversation): same answer, same opaque
    // conversation ID, native session ID and message IDs/content — with NO
    // replayed tools/prompt. Aggregate: prompts=1, each tool=1.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /abrir assistente ted/i }).first().click();
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({ timeout: 120000 });
    await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 120000 });
    await expect(page.getByText("Itaú", { exact: false }).first()).toBeVisible({ timeout: 120000 });
    await expect(page.getByText("Nubank", { exact: false }).first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText(EXPECTED_JUNE_EXPENSE, { exact: false }).first()).toBeVisible({ timeout: 60000 });
    const listAfter = (await ctlGet("/p2d/snapshot-list")) as { conversations?: string[] };
    expect(listAfter.conversations).toContain(conversationId);
    const snapAfter = (await ctlGet(`/p2d/snapshot?id=${conversationId}`)) as Snapshot;
    expect(snapAfter.error).toBeUndefined();
    expect(snapAfter.conversationId).toBe(conversationId);
    expect(snapAfter.runtimeSessionId).toBe(snap.runtimeSessionId);
    expect(snapAfter.userMessages).toEqual(snap.userMessages);
    expect(snapAfter.assistantMessages).toEqual(snap.assistantMessages);
    expect(snapAfter.promptCalls).toBe(0);
    expect(snapAfter.transportCalls).toBe(0);
    expect(snapAfter.stubTurns).toBe(0);

    // 10. Journal: zero financial writes across the whole scenario.
    const journal = (await ctlGet("/p2d/journal")) as {
      requests?: Array<{ method?: string; url?: string }>;
      financialWrites?: unknown[];
    };
    expect(Array.isArray(journal.requests)).toBe(true);
    expect((journal.requests ?? []).length).toBeGreaterThan(0);
    expect(journal.financialWrites).toEqual([]);

    // 11. Bounded, redacted evidence (IDs + counts + statuses only: no
    // credentials, cookies, tokens, personal data or raw logs/text).
    const evidence = {
      scope: "p2d-synthetic-conversation",
      prompt: CHAT_TEXT,
      conversationId,
      nativeSessionId: snap.runtimeSessionId,
      userMessageIds: (snap.userMessages ?? []).map((m) => m.id),
      assistantMessageIds: (snap.assistantMessages ?? []).map((m) => m.id),
      contentStableAcrossReload: true,
      contentStableAcrossRestart: true,
      aggregatePrompts: 1,
      aggregateListAccounts: 1,
      aggregateGetMonthSummary: 1,
      aggregateFinancialWrites: 0,
      preRestartPid: firstPid,
      postRestartPid: started.pid,
      distinctProcess: started.pid !== firstPid,
      reloadNewPrompts: 0,
      reloadNewTransportCalls: 0,
      restartNewPrompts: 0,
      restartNewTransportCalls: 0,
      closeForced: false,
      readSlicePass: READ_SLICE_PASS,
      provider: "local-scripted-only",
    };
    const serialized = JSON.stringify(evidence, null, 2);
    expect(serialized).not.toMatch(/cookie|token|secret|password|bearer/i);
    const outDir = path.resolve(process.cwd(), "test-results", "p2d-synthetic-conversation");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "evidence.json");
    fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
    await testInfo.attach("p2d-evidence", { path: outPath, contentType: "application/json" });
  });
});
