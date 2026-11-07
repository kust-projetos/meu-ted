/**
 * P3.2 income slice — ONE real-browser journey (test-only, loopback only).
 *
 * Chain (identical to P3.1, only the intent tool changes):
 *   real Chromium → real Next dev PWA → same-origin proxy `/api/agent`
 *   → real loopback TED gateway → real OpenCode SDK 2.2.4 prompt loop
 *   → LOCAL scripted provider stub → `propose_income` (intent only)
 *   → authenticated PWA sends the intent to the REAL local Agent Worker
 *     (`wrangler dev --local`, Durable Objects included)
 *   → Pending V2 on the synthetic API → authoritative receita card
 *   → user Confirm/Reject → real API V2 executor → income + receipt.
 *
 * The broker call is aborted exactly once to prove reload recovery: the
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
const USER_TEXT = "Registre uma receita de R$ 2.500 de salário na conta Nubank.";
const CONFIRM_LABEL = /Confirmar R\$ 2\.500,00/;
const ACCOUNT_A2 = "11111111-1111-4111-8111-111111111112";

type LedgerTxn = {
  id: string;
  kind: string;
  amountCents: number;
  description: string;
  date: string;
  accountId: string;
  categoryId: string;
};
type LedgerAccount = { id: string; name: string; kind: string; balanceCents: number };
type LedgerState = { transactions: LedgerTxn[]; total: number; accounts: LedgerAccount[] };

async function ctlGet<T>(pathname: string): Promise<T> {
  const res = await fetch(`${CTL}${pathname}`);
  if (!res.ok) throw new Error(`ctl GET ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}

const ctlState = () => ctlGet<LedgerState>("/p2d/expense-state");
const ctlStats = () =>
  ctlGet<{ promptCalls: number; transportCalls: number; stubTurns: number; stubMismatches: string[] }>("/p2d/stats");
const ctlJournal = () =>
  ctlGet<{ requests: Array<{ method: string; url: string }>; financialWrites: Array<{ method: string; url: string }> }>(
    "/p2d/journal",
  );

/** The scripted income is the only row with this exact description/sign/amount. */
const countIncome = (state: LedgerState) =>
  state.transactions.filter(
    (t) => t.kind === "income" && t.description === "salário" && t.amountCents === 250000,
  ).length;

const nubankBalance = (state: LedgerState) =>
  state.accounts.find((a) => a.id === ACCOUNT_A2)?.balanceCents;

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

test.describe.configure({ mode: "serial" });

test.describe("p3.2 income slice (real browser, real Agent, Pending V2)", () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    // Bounded diagnostics only: never cookies, tokens, bodies or raw logs.
    try {
      console.log("[p3-income-diagnostic] health", JSON.stringify(await ctlGet("/health")));
    } catch {
      /* noop */
    }
    try {
      console.log("[p3-income-diagnostic] stats", JSON.stringify(await ctlStats()));
    } catch {
      /* noop */
    }
  });

  test("proposal → lost broker → reload recovery → confirm → income; reject writes zero", async ({ page }, testInfo) => {
    test.setTimeout(900_000);

    // 1. Stack health + zero-turn baseline.
    const health = await ctlGet<{ ok: boolean; agentRunning: boolean; probeRunning: boolean }>("/health");
    expect(health.ok).toBe(true);
    expect(health.probeRunning).toBe(true);
    expect(health.agentRunning).toBe(true);
    const baseline = await ctlStats();
    expect(baseline.promptCalls).toBe(0);
    expect(baseline.transportCalls).toBe(0);
    expect(baseline.stubTurns).toBe(0);
    const baselineState = await ctlState();
    const baselineBalance = nubankBalance(baselineState);
    expect(typeof baselineBalance).toBe("number");

    // 2. Synthetic user, real Better-Auth login through the UI.
    const email = "ted-p3-income@example.test";
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
    const signupStatus = await page.evaluate(async (userEmail) => {
      const res = await fetch("/api/backend/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P3 Income" }),
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
    await expect(page.getByText(/Não foi possível preparar a proposta de receita/)).toBeVisible({
      timeout: 300000,
    });
    expect(brokerAttempts).toBe(1);
    expect(page.getByRole("button", { name: CONFIRM_LABEL })).toHaveCount(0);
    expect(countIncome(await ctlState())).toBe(0);
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
    await expect(confirmButton).toBeVisible({ timeout: 300000 });
    expect(brokerAttempts).toBe(2);
    expect(await page.getByRole("button", { name: CONFIRM_LABEL }).count()).toBe(1);
    // Card identity: receita + value + description + account + category.
    await expect(page.getByText("Confirmar receita")).toBeVisible();
    await expect(page.getByText("salário").first()).toBeVisible();
    await expect(page.getByText("Nubank").first()).toBeVisible();
    await expect(page.getByText("Salário").first()).toBeVisible();
    const afterRecovery = await ctlStats();
    expect(afterRecovery.promptCalls).toBe(1);
    expect(afterRecovery.stubTurns).toBe(2);
    expect(countIncome(await ctlState())).toBe(0);

    // 6. Confirm → real Agent decision → API confirm+execute → ONE income row
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
    expect(decisionBody.receipt?.mutationKind).toBe("transactions.income.create");
    expect(decisionBody.receipt?.status).toBe("succeeded");
    expect(decisionBody.receipt?.entity?.type).toBe("transaction");
    await expect.poll(async () => countIncome(await ctlState()), { timeout: 120000 }).toBe(1);
    const afterConfirm = await ctlState();
    const launched = afterConfirm.transactions.find(
      (t) => t.kind === "income" && t.description === "salário" && t.amountCents === 250000,
    );
    expect(launched).toBeTruthy();
    expect(decisionBody.receipt?.entity?.id).toBe(launched?.id);

    // 8. The account balance increased by EXACTLY R$ 2.500,00.
    expect(nubankBalance(afterConfirm)).toBe((baselineBalance as number) + 250000);

    // 9. Visible financial result for the authenticated browser: the same
    // income and balance are readable through the real same-origin proxy.
    const browserData = await page.evaluate(async () => {
      const headers = { "X-Workspace-Id": "00000000-0000-4000-8000-00000000000a" };
      const [txRes, accRes] = await Promise.all([
        fetch("/api/backend/transactions", { credentials: "include", headers }),
        fetch("/api/backend/accounts", { credentials: "include", headers }),
      ]);
      const txBody = (await txRes.json().catch(() => null)) as
        | { items?: Array<{ description?: string; amountCents?: number; kind?: string; id?: string }> }
        | null;
      const accBody = (await accRes.json().catch(() => null)) as
        | { items?: Array<{ id?: string; balanceCents?: number; name?: string }> }
        | null;
      return {
        txStatus: txRes.status,
        accStatus: accRes.status,
        transactions: txBody?.items ?? [],
        accounts: accBody?.items ?? [],
      };
    });
    expect(browserData.txStatus).toBe(200);
    expect(browserData.accStatus).toBe(200);
    expect(
      browserData.transactions.some(
        (t) => t.kind === "income" && t.description === "salário" && t.amountCents === 250000,
      ),
    ).toBe(true);
    expect(browserData.accounts.find((a) => a.id === ACCOUNT_A2)?.balanceCents).toBe(
      (baselineBalance as number) + 250000,
    );
    // The PWA consumed the canonical receipt: the actionable card is resolved
    // (no Confirm button) and no error is shown. The terminal card itself is
    // transient by the existing P3.1 behavior (the active list drops terminal
    // operations); the receipt contract is asserted on the decision response
    // above and via the financial reconciliation below.
    await expect(page.getByRole("button", { name: CONFIRM_LABEL })).toHaveCount(0, { timeout: 60000 });
    await expect(page.getByText(/Não foi possível/)).toHaveCount(0);

    // 10. Rejection: a second proposal is cancelled. Zero extra launches.
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
    await expect.poll(async () => countIncome(await ctlState()), { timeout: 60000 }).toBe(1);

    // 11. Aggregate proof: two broker proposes (first lost, recovery, second
    // message), ONE confirm, ONE execute, ONE cancel — never a duplicate run,
    // and no direct financial write from the tool.
    const journal = await ctlJournal();
    const proposes = countJournal(journal, "POST", (u) => u === "/pending-operations/v2/propose");
    const confirms = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/confirm$/.test(u));
    const executes = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/execute$/.test(u));
    const cancels = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/(cancel|reject)$/.test(u));
    expect(proposes).toBe(2);
    expect(confirms).toBe(1);
    expect(executes).toBe(1);
    expect(cancels).toBe(1);
    expect(
      journal.financialWrites.filter((w) => w.url === "/transactions/income" || w.url.startsWith("/transactions/income?")).length,
    ).toBe(0);
    expect(
      journal.financialWrites.filter((w) => w.url === "/transactions/expense" || w.url.startsWith("/transactions/expense?")).length,
    ).toBe(0);

    const finalStats = await ctlStats();
    expect(finalStats.promptCalls).toBe(2);
    expect(finalStats.stubTurns).toBe(4);
    expect(finalStats.stubMismatches).toEqual([]);

    // 12. Bounded, redacted evidence (ids/counts/statuses only).
    const evidence = {
      scope: "p3.2-income-slice",
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
      syntheticIncomeRows: countIncome(afterConfirm),
      balanceBeforeCents: baselineBalance,
      balanceAfterCents: nubankBalance(afterConfirm),
      balanceDeltaCents: (nubankBalance(afterConfirm) as number) - (baselineBalance as number),
      ledgerTotal: afterConfirm.total,
      duplicateLaunch: false,
      recoveredAfterReload: true,
      rejectedWrites: 0,
    };
    const serialized = JSON.stringify(evidence, null, 2);
    expect(serialized).not.toMatch(/cookie|token|secret|password|bearer/i);
    const outDir = path.resolve(process.cwd(), "test-results", "p3-income");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "evidence.json");
    fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
    await testInfo.attach("p3-income-evidence", { path: outPath, contentType: "application/json" });
  });
});
