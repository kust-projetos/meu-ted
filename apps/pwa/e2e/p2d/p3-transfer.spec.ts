/**
 * P3.3 transfer slice — ONE real-browser journey (test-only, loopback only).
 *
 * Chain:
 *   real Chromium → real Next dev PWA → same-origin proxy `/api/agent`
 *   → real loopback TED gateway → real OpenCode SDK 2.2.4 prompt loop
 *   → LOCAL scripted provider stub → `propose_transfer` (intent only)
 *   → authenticated PWA sends the intent to the REAL local Agent Worker
 *     (`wrangler dev --local`, Durable Objects included)
 *   → Pending V2 on the synthetic API → authoritative transfer card
 *   → user Confirm/Reject → real API V2 executor → ONE atomic transfer + receipt.
 *
 * Proof points:
 * - proposal: zero transfer rows and ZERO balance movement;
 * - reload recovery: the persisted intent replays under the same intentionId,
 *   with ZERO new prompt/turn calls;
 * - confirmation: ONE `transfer` row, both balances moved by the exact amount,
 *   receipt on the decision response;
 * - DRE: the month summary keeps income/expense at zero (transfer is neither);
 * - rejection: a second proposal is cancelled and moves nothing.
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
const USER_TEXT = "Transfira R$ 300 da conta Itaú para a conta Nubank.";
const CONFIRM_LABEL = /Confirmar R\$ 300,00/;

const FROM_ID = "11111111-1111-4111-8111-111111111111";
const TO_ID = "11111111-1111-4111-8111-111111111112";

type TransferTxn = {
  id: string;
  kind: string;
  amountCents: number;
  description: string;
  date: string;
  accountId: string;
  categoryId?: string;
  transferToAccountId?: string;
};

type AccountRow = { id: string; name: string; kind: string; balanceCents: number };

async function ctlGet<T>(pathname: string): Promise<T> {
  const res = await fetch(`${CTL}${pathname}`);
  if (!res.ok) throw new Error(`ctl GET ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}

const ctlLedgerState = () =>
  ctlGet<{ transactions: TransferTxn[]; total: number; accounts: AccountRow[] }>("/p2d/expense-state");
const ctlStats = () =>
  ctlGet<{ promptCalls: number; transportCalls: number; stubTurns: number; stubMismatches: string[] }>("/p2d/stats");
const ctlJournal = () =>
  ctlGet<{ requests: Array<{ method: string; url: string }>; financialWrites: Array<{ method: string; url: string }> }>(
    "/p2d/journal",
  );

const countTransfers = (state: { transactions: TransferTxn[] }) =>
  state.transactions.filter(
    (t) =>
      t.kind === "transfer" &&
      t.description === "Transferência Itaú → Nubank" &&
      t.amountCents === 30000 &&
      t.accountId === FROM_ID &&
      t.transferToAccountId === TO_ID,
  ).length;

const balanceOf = (state: { accounts: AccountRow[] }, id: string) =>
  state.accounts.find((a) => a.id === id)?.balanceCents;

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

test.describe("p3 transfer slice (real browser, real Agent, Pending V2)", () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    // Bounded diagnostics only: never cookies, tokens, bodies or raw logs.
    try {
      console.log("[p3-transfer-diagnostic] health", JSON.stringify(await ctlGet("/health")));
    } catch {
      /* noop */
    }
    try {
      console.log("[p3-transfer-diagnostic] stats", JSON.stringify(await ctlStats()));
    } catch {
      /* noop */
    }
  });

  test("transfer proposal → lost broker → reload recovery → confirm (one atomic transfer); reject writes zero", async ({ page }, testInfo) => {
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

    // 2. Synthetic user, real Better-Auth login through the UI.
    const email = "ted-p3-transfer@example.test";
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
    const signupStatus = await page.evaluate(async (userEmail) => {
      const res = await fetch("/api/backend/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P3 Transfer" }),
      });
      return res.status;
    }, email);
    expect(signupStatus).toBe(200);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("test-password-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("button", { name: /abrir assistente ted/i }).last()).toBeVisible({ timeout: 60000 });

    const initial = await ctlLedgerState();
    const initialFrom = balanceOf(initial, FROM_ID);
    const initialTo = balanceOf(initial, TO_ID);
    expect(typeof initialFrom).toBe("number");
    expect(typeof initialTo).toBe("number");
    expect(countTransfers(initial)).toBe(0);

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
    // is lost. No card, no transfer and no balance movement may exist.
    await openTed(page);
    await sendTed(page, USER_TEXT);
    await expect(page.getByText(/Não foi possível preparar a proposta de transferência/)).toBeVisible({
      timeout: 300000,
    });
    expect(brokerAttempts).toBe(1);
    expect(page.getByRole("button", { name: CONFIRM_LABEL })).toHaveCount(0);
    expect(countTransfers(await ctlLedgerState())).toBe(0);
    expect(balanceOf(await ctlLedgerState(), FROM_ID)).toBe(initialFrom);
    expect(balanceOf(await ctlLedgerState(), TO_ID)).toBe(initialTo);
    const afterFailedBroker = await ctlStats();
    expect(afterFailedBroker.promptCalls).toBe(1);
    expect(afterFailedBroker.stubTurns).toBe(2);
    expect(afterFailedBroker.stubMismatches).toEqual([]);

    // 5. Reload: the persisted intent is replayed to the broker under the SAME
    // intentionId. The reload must NOT re-send the chat turn (zero new prompts)
    // and must NOT move money before approval.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({
      timeout: 120000,
    });
    const confirmButton = page.getByRole("button", { name: CONFIRM_LABEL });
    await expect(confirmButton).toBeVisible({ timeout: 300000 });
    expect(brokerAttempts).toBe(2);
    expect(await page.getByRole("button", { name: CONFIRM_LABEL }).count()).toBe(1);
    // Card content: title + origem/destino come from the authoritative projection.
    await expect(page.getByText("Transferência de R$ 300,00").first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("Origem").first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("Itaú").first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("Destino").first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("Nubank").first()).toBeVisible({ timeout: 60000 });
    const afterRecovery = await ctlStats();
    expect(afterRecovery.promptCalls).toBe(1);
    expect(afterRecovery.stubTurns).toBe(2);
    expect(countTransfers(await ctlLedgerState())).toBe(0);
    expect(balanceOf(await ctlLedgerState(), FROM_ID)).toBe(initialFrom);
    expect(balanceOf(await ctlLedgerState(), TO_ID)).toBe(initialTo);

    // 6. Confirm → real Agent decision → API confirm+execute → ONE atomic
    // transfer, both balances moved and the canonical receipt.
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
    expect(decisionBody.receipt?.mutationKind).toBe("transactions.transfer.create");
    expect(decisionBody.receipt?.status).toBe("succeeded");
    expect(decisionBody.receipt?.entity?.type).toBe("transaction");

    await expect.poll(async () => countTransfers(await ctlLedgerState()), { timeout: 120000 }).toBe(1);
    const afterConfirm = await ctlLedgerState();
    const launched = afterConfirm.transactions.find(
      (t) => t.kind === "transfer" && t.description === "Transferência Itaú → Nubank",
    );
    expect(launched).toBeTruthy();
    expect(decisionBody.receipt?.entity?.id).toBe(launched?.id);
    expect(balanceOf(afterConfirm, FROM_ID)).toBe(initialFrom! - 30000);
    expect(balanceOf(afterConfirm, TO_ID)).toBe(initialTo! + 30000);

    // 7. Visible financial result for the authenticated browser: the SAME
    // transfer is readable through the real same-origin proxy.
    const browserTransactions = await page.evaluate(async () => {
      const response = await fetch("/api/backend/transactions", {
        credentials: "include",
        headers: { "X-Workspace-Id": "00000000-0000-4000-8000-00000000000a" },
      });
      const body = (await response.json().catch(() => null)) as
        | { items?: Array<{ description?: string; amountCents?: number; kind?: string; id?: string; transferToAccountId?: string }> }
        | null;
      return { status: response.status, items: body?.items ?? [] };
    });
    expect(browserTransactions.status).toBe(200);
    expect(
      browserTransactions.items.some(
        (t) =>
          t.kind === "transfer" &&
          t.description === "Transferência Itaú → Nubank" &&
          t.amountCents === 30000 &&
          t.transferToAccountId === TO_ID,
      ),
    ).toBe(true);

    // 8. DRE: the month summary of the transfer month has ZERO income/expense.
    const monthSummary = await page.evaluate(async () => {
      const response = await fetch("/api/backend/dashboard/month-summary?yearMonth=2026-11", {
        credentials: "include",
        headers: { "X-Workspace-Id": "00000000-0000-4000-8000-00000000000a" },
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
    });
    expect(monthSummary.status).toBe(200);
    expect(monthSummary.body?.incomeCents).toBe(0);
    expect(monthSummary.body?.expenseCents).toBe(0);
    expect(monthSummary.body?.transactionCount).toBe(1);

    // 9. Rejection: a second proposal is rejected (Rejeitar). Zero extra
    // transfers and zero extra balance movement.
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({
      timeout: 60000,
    });
    await expect(page.getByRole("button", { name: CONFIRM_LABEL })).toHaveCount(0, { timeout: 60000 });
    await sendTed(page, USER_TEXT);
    const secondConfirm = page.getByRole("button", { name: CONFIRM_LABEL }).first();
    await expect(secondConfirm).toBeVisible({ timeout: 300000 });
    const rejectButton = secondConfirm.locator("xpath=..").getByRole("button", { name: "Rejeitar" });
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
    await expect.poll(async () => countTransfers(await ctlLedgerState()), { timeout: 60000 }).toBe(1);
    const afterReject = await ctlLedgerState();
    expect(balanceOf(afterReject, FROM_ID)).toBe(initialFrom! - 30000);
    expect(balanceOf(afterReject, TO_ID)).toBe(initialTo! + 30000);

    // 10. Aggregate proof: two broker proposes (first lost, recovery, second
    // message), ONE confirm, ONE execute, ONE cancel — never a duplicate run,
    // and NO direct expense/income write (transfer is atomic, not two legs).
    const journal = await ctlJournal();
    const proposes = countJournal(journal, "POST", (u) => u === "/pending-operations/v2/propose");
    const confirms = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/confirm$/.test(u));
    const executes = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/execute$/.test(u));
    const cancels = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/(cancel|reject)$/.test(u));
    expect(proposes).toBe(2);
    expect(confirms).toBe(1);
    expect(executes).toBe(1);
    expect(cancels).toBe(1);
    expect(journal.financialWrites.filter((w) => w.url.startsWith("/transactions/expense") || w.url.startsWith("/transactions/income")).length).toBe(0);
    expect(journal.financialWrites.filter((w) => w.url.startsWith("/transfers")).length).toBe(0);

    const finalStats = await ctlStats();
    expect(finalStats.promptCalls).toBe(2);
    expect(finalStats.stubTurns).toBe(4);
    expect(finalStats.stubMismatches).toEqual([]);

    // 11. Bounded, redacted evidence (ids/counts/statuses only).
    const evidence = {
      scope: "p3-transfer-slice",
      provider: "local-scripted-only",
      brokerAttempts,
      promptCalls: finalStats.promptCalls,
      stubTurns: finalStats.stubTurns,
      reloadNewPrompts: afterRecovery.promptCalls - afterFailedBroker.promptCalls,
      proposeRequests: proposes,
      confirmRequests: confirms,
      executeRequests: executes,
      cancelRequests: cancels,
      transferId: launched?.id,
      fromAccountId: FROM_ID,
      toAccountId: TO_ID,
      fromDelta: balanceOf(afterConfirm, FROM_ID)! - initialFrom!,
      toDelta: balanceOf(afterConfirm, TO_ID)! - initialTo!,
      transferRows: countTransfers(afterConfirm),
      incomeCents: monthSummary.body?.incomeCents,
      expenseCents: monthSummary.body?.expenseCents,
      duplicateLaunch: false,
      recoveredAfterReload: true,
      rejectedWrites: 0,
    };
    const serialized = JSON.stringify(evidence, null, 2);
    expect(serialized).not.toMatch(/cookie|token|secret|password|bearer/i);
    const outDir = path.resolve(process.cwd(), "test-results", "p3-transfer");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "evidence.json");
    fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
    await testInfo.attach("p3-transfer-evidence", { path: outPath, contentType: "application/json" });
  });
});
