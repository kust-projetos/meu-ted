/**
 * P3 expense slice — ONE real-browser journey (test-only, loopback only).
 *
 * Chain:
 *   real Chromium → real Next dev PWA → same-origin proxy `/api/agent`
 *   → real loopback TED gateway → real OpenCode SDK 2.2.4 prompt loop
 *   → LOCAL scripted provider stub → `propose_expense` (intent only)
 *   → authenticated PWA sends the intent to the REAL local Agent Worker
 *     (`wrangler dev --local`, Durable Objects included)
 *   → Pending V2 on the synthetic API → authoritative card
 *   → user Confirm/Reject → real API V2 executor → transaction + receipt.
 *
 * The broker call is aborted exactly once to prove the reload recovery: the
 * persisted retry anchor keeps the original intent and the next mount replays
 * it under the same `intentionId` (the broker's idempotency seed). The reload
 * performs ZERO new prompt/turn calls; only the broker is retried.
 *
 * Negative path: a second proposal is rejected; it must create ZERO rows.
 *
 * HONESTY: the provider is a local scripted stub, so this is a product-flow
 * proof, not an external-model-quality proof. No paid/external inference.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { resolveP2dPorts } from "../support/ports";

const ports = resolveP2dPorts(process.env);
const CTL = `http://127.0.0.1:${ports.ctlPort}`;
const USER_TEXT = "Registre uma despesa de R$ 50 no mercado, na conta Nubank.";
const CONFIRM_LABEL = /Confirmar R\$ 50,00/;

type ExpenseTxn = {
  id: string;
  kind: string;
  amountCents: number;
  description: string;
  date: string;
  accountId: string;
  categoryId: string;
};

async function ctlGet<T>(pathname: string): Promise<T> {
  const res = await fetch(`${CTL}${pathname}`);
  if (!res.ok) throw new Error(`ctl GET ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}

const ctlExpenseState = () => ctlGet<{ transactions: ExpenseTxn[]; total: number }>("/p2d/expense-state");
const ctlStats = () =>
  ctlGet<{ promptCalls: number; transportCalls: number; stubTurns: number; stubMismatches: string[] }>("/p2d/stats");
const ctlJournal = () =>
  ctlGet<{ requests: Array<{ method: string; url: string }>; financialWrites: Array<{ method: string; url: string }> }>(
    "/p2d/journal",
  );

/** The scripted expense is the only row with this exact description/sign/amount. */
const countExpense = (state: { transactions: ExpenseTxn[] }) =>
  state.transactions.filter(
    (t) => t.kind === "expense" && t.description === "mercado" && t.amountCents === 5000,
  ).length;

const countJournal = (
  journal: { requests: Array<{ method: string; url: string }> },
  method: string,
  matcher: (url: string) => boolean,
) => journal.requests.filter((r) => r.method === method && matcher(r.url)).length;

async function openTed(page: import("@playwright/test").Page) {
  const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  await expect(launcher).toBeVisible({ timeout: 60000 });
  await launcher.click();
  await page.waitForURL(/\/ted/);
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 60000 });
  await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 120000 });
  return input;
}

async function sendTed(page: import("@playwright/test").Page, text: string) {
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 60000 });
  await input.fill(text);
  const sendButton = page.getByRole("button", { name: /enviar mensagem/i });
  await expect(sendButton).toBeEnabled({ timeout: 120000 });
  await sendButton.click();
}

async function gotoWithStartupRetry(
  page: import("@playwright/test").Page,
  url: string,
  projectBaseURL?: string,
) {
  const baseURL = process.env.P2D_NEXT_BASE || projectBaseURL || `http://127.0.0.1:${ports.nextPort}`;
  const readinessUrl = new URL(url, baseURL).href;
  const readinessDeadline = Date.now() + 60000;
  while (Date.now() < readinessDeadline) {
    try {
      await fetch(readinessUrl, { method: "HEAD", signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const retryable =
        /net::ERR_CONNECTION_(?:RESET|REFUSED)/i.test(message) ||
        /(?:TimeoutError|Timeout[^\n]*(?:exceeded|navigation)|navigation[^\n]*timeout)/i.test(message);
      if (!retryable || attempt === 10) throw error;
      await page.waitForTimeout(3000);
    }
  }
}

test.describe.configure({ mode: "serial" });

test.describe("p3 expense slice (real browser, real Agent, Pending V2)", () => {
  let proposalCalls: Array<{ url: string; status: number; body?: string }> = [];

  async function attachProposalCalls(testInfo: import("@playwright/test").TestInfo) {
    const body = JSON.stringify(proposalCalls, null, 2);
    console.log("[p3-expense] proposalCalls", JSON.stringify(proposalCalls));
    await testInfo.attach("proposal-calls", { body, contentType: "application/json" });
  }

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    await attachProposalCalls(testInfo);
    // Bounded diagnostics; proposal/decision bodies are captured separately
    // with sensitive fields masked and a strict size limit.
    try {
      console.log("[p3-diagnostic] health", JSON.stringify(await ctlGet("/health")));
    } catch {
      /* noop */
    }
    try {
      console.log("[p3-diagnostic] stats", JSON.stringify(await ctlStats()));
    } catch {
      /* noop */
    }
  });

  test("proposal → lost broker → reload recovery → confirm → launch; reject writes zero", async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    proposalCalls = [];
    page.on("response", async (res) => {
      const url = new URL(res.url()).pathname;
      if (!/\/rpc\/pending-operations\/(propose|[^/]+\/decision)$/.test(url)) return;
      let body: string | undefined;
      try {
        body = (await res.text())
          .replace(/("[^"]*(?:authorization|cookie|password|secret|token|credential|api[_-]?key)[^"]*"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
          .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
          .slice(0, 300);
      } catch {
        /* response body may already be consumed */
      }
      proposalCalls.push({ url, status: res.status(), body });
    });

    // 1. Stack health + zero-turn baseline.
    const health = await ctlGet<{ ok: boolean; probeRunning: boolean }>("/health");
    expect(health.ok).toBe(true);
    expect(health.probeRunning).toBe(true);
    const baseline = await ctlStats();
    expect(baseline.promptCalls).toBe(0);
    expect(baseline.transportCalls).toBe(0);
    expect(baseline.stubTurns).toBe(0);

    // 2. Synthetic user, real Better-Auth login through the UI.
    const email = "ted-p3-expense@example.test";
    const projectBaseURL = typeof testInfo.project.use.baseURL === "string" ? testInfo.project.use.baseURL : undefined;
    await gotoWithStartupRetry(page, "/", projectBaseURL);
    await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
    const signupStatus = await page.evaluate(async (userEmail) => {
      const res = await fetch("/api/backend/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P3 Expense" }),
      });
      return res.status;
    }, email);
    expect(signupStatus).toBe(200);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("test-password-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("button", { name: /abrir assistente ted/i }).last()).toBeVisible({ timeout: 60000 });

    // 3. The broker fails ONCE (browser→Agent propose aborted). Every later
    // attempt (recovery + second proposal) is allowed through.
    let brokerAttempts = 0;
    await page.route("**/rpc/pending-operations/propose", async (route) => {
      brokerAttempts += 1;
      if (brokerAttempts === 1) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    // 4. Message → OpenCode turn → intent. The turn succeeds; the broker call
    // is lost. No card and no launch may exist.
    await openTed(page);
    await sendTed(page, USER_TEXT);
    await expect(page.getByText(/Não foi possível preparar a proposta de despesa/)).toBeVisible({
      timeout: 300000,
    });
    expect(brokerAttempts).toBe(1);
    expect(page.getByRole("button", { name: CONFIRM_LABEL })).toHaveCount(0);
    expect(countExpense(await ctlExpenseState())).toBe(0);
    const afterFailedBroker = await ctlStats();
    expect(afterFailedBroker.promptCalls).toBe(1);
    expect(afterFailedBroker.stubTurns).toBe(2); // tool_call + final text
    expect(afterFailedBroker.stubMismatches).toEqual([]);

    // 5. Reload: the persisted intent is replayed to the broker under the SAME
    // intentionId. The reload must NOT re-send the chat turn (zero new prompts)
    // and must NOT create a transaction before approval.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({
      timeout: 120000,
    });
    const confirmButton = page.getByRole("button", { name: CONFIRM_LABEL });
    await attachProposalCalls(testInfo);
    await expect(confirmButton).toBeVisible({ timeout: 300000 });
    expect(brokerAttempts).toBe(2);
    expect(await page.getByRole("button", { name: CONFIRM_LABEL }).count()).toBe(1);
    const afterRecovery = await ctlStats();
    expect(afterRecovery.promptCalls).toBe(1);
    expect(afterRecovery.stubTurns).toBe(2);
    expect(countExpense(await ctlExpenseState())).toBe(0);

    // 6. Confirm → real Agent decision → API confirm+execute → ONE transaction
    // and the canonical receipt.
    const decisionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/rpc\/pending-operations\/[^/]+\/decision$/.test(new URL(response.url()).pathname),
      { timeout: 180000 },
    );
    await confirmButton.click();
    const decision = await decisionResponse;
    expect(decision.status()).toBe(200);
    const decisionBody = (await decision.json()) as {
      status?: string;
      receipt?: { mutationKind?: string; status?: string; entity?: { type?: string; id?: string } };
    };
    expect(decisionBody.status).toBe("succeeded");
    expect(decisionBody.receipt?.mutationKind).toBe("transactions.expense.create");
    expect(decisionBody.receipt?.status).toBe("succeeded");
    expect(decisionBody.receipt?.entity?.type).toBe("transaction");
    await expect.poll(async () => countExpense(await ctlExpenseState()), { timeout: 120000 }).toBe(1);
    const afterConfirm = await ctlExpenseState();
    const launched = afterConfirm.transactions.find(
      (t) => t.kind === "expense" && t.description === "mercado" && t.amountCents === 5000,
    );
    expect(launched).toBeTruthy();
    expect(decisionBody.receipt?.entity?.id).toBe(launched?.id);

    // 7. Visible financial result for the authenticated browser: the SAME
    // transaction the user just approved is readable through the real
    // same-origin proxy (the records page's own data source). The P2D
    // synthetic app-state bootstrap is intentionally minimal and can leave the
    // records skeleton loading, so the assertion targets the authoritative
    // browser-visible data instead of that harness-only gate.
    const browserTransactions = await page.evaluate(async () => {
      const response = await fetch("/api/backend/transactions", {
        credentials: "include",
        headers: { "X-Workspace-Id": "00000000-0000-4000-8000-00000000000a" },
      });
      const body = (await response.json().catch(() => null)) as
        | { items?: Array<{ description?: string; amountCents?: number; kind?: string; id?: string }> }
        | null;
      return { status: response.status, items: body?.items ?? [] };
    });
    expect(browserTransactions.status).toBe(200);
    expect(
      browserTransactions.items.some(
        (t) => t.kind === "expense" && t.description === "mercado" && t.amountCents === 5000,
      ),
    ).toBe(true);

    // 8. Rejection: a second proposal is cancelled. Zero extra launches.
    // Stay on the SAME /ted page (the first decision already settled); a
    // fresh navigation here would race the app-state bootstrap and abort the
    // next in-flight turn.
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({
      timeout: 60000,
    });
    await expect(page.getByRole("button", { name: CONFIRM_LABEL })).toHaveCount(0, { timeout: 60000 });
    await sendTed(page, USER_TEXT);
    const secondConfirm = page.getByRole("button", { name: CONFIRM_LABEL }).first();
    await expect(secondConfirm).toBeVisible({ timeout: 300000 });
    const rejectButton = secondConfirm.locator("xpath=..").getByRole("button", { name: "Cancelar" });
    await expect(rejectButton).toBeVisible({ timeout: 60000 });
    const cancelResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/rpc\/pending-operations\/[^/]+\/decision$/.test(new URL(response.url()).pathname),
      { timeout: 180000 },
    );
    await rejectButton.click();
    const cancelled = await cancelResponse;
    expect(cancelled.status()).toBe(200);
    const cancelledBody = (await cancelled.json()) as { status?: string };
    expect(cancelledBody.status).toBe("cancelled");
    await expect.poll(async () => countExpense(await ctlExpenseState()), { timeout: 60000 }).toBe(1);

    // 9. Aggregate proof: two broker proposes (first lost, recovery, second
    // message), ONE confirm, ONE execute, ONE cancel — never a duplicate run.
    const journal = await ctlJournal();
    const proposes = countJournal(journal, "POST", (u) => u === "/pending-operations/v2/propose");
    const confirms = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/confirm$/.test(u));
    const executes = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/execute$/.test(u));
    const cancels = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/(cancel|reject)$/.test(u));
    expect(proposes).toBe(2);
    expect(confirms).toBe(1);
    expect(executes).toBe(1);
    expect(cancels).toBe(1);
    expect(journal.financialWrites.filter((w) => w.url === "/transactions/expense" || w.url.startsWith("/transactions/expense?")).length).toBe(0);

    const finalStats = await ctlStats();
    expect(finalStats.promptCalls).toBe(2);
    expect(finalStats.stubTurns).toBe(4);
    expect(finalStats.stubMismatches).toEqual([]);

    // 10. Bounded, redacted evidence (ids/counts/statuses only).
    const evidence = {
      scope: "p3-expense-slice",
      provider: "local-scripted-only",
      brokerAttempts,
      promptCalls: finalStats.promptCalls,
      stubTurns: finalStats.stubTurns,
      reloadNewPrompts: afterRecovery.promptCalls - afterFailedBroker.promptCalls,
      proposeRequests: proposes,
      confirmRequests: confirms,
      executeRequests: executes,
      cancelRequests: cancels,
      transactionId: launched?.id,
      syntheticExpenseRows: countExpense(afterConfirm),
      ledgerTotal: afterConfirm.total,
      duplicateLaunch: false,
      recoveredAfterReload: true,
      rejectedWrites: 0,
    };
    const serialized = JSON.stringify(evidence, null, 2);
    expect(serialized).not.toMatch(/cookie|token|secret|password|bearer/i);
    const outDir = path.resolve(process.cwd(), "test-results", "p3-expense");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "evidence.json");
    fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
    await testInfo.attach("p3-expense-evidence", { path: outPath, contentType: "application/json" });
    await attachProposalCalls(testInfo);
  });
});
