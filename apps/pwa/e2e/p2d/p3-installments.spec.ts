/**
 * P3.5 installments slice - ONE real-browser journey (test-only, loopback only).
 *
 * Chain:
 *   real Chromium → real Next dev PWA → same-origin proxy `/api/agent`
 *   → real loopback TED gateway → real OpenCode SDK prompt loop
 *   → LOCAL scripted provider stub → `propose_card_purchase` with
 *     `installmentsTotal` (intent only)
 *   → authenticated PWA sends the intent to the REAL local Agent Worker
 *     (`wrangler dev --local`, Durable Objects included)
 *   → Pending V2 on the synthetic API → authoritative card
 *     (Compra parcelada — R$ 1.200,00 · 6x de R$ 200,00 · Confirm/Reject)
 *   → user Confirm → real API V2 executor → `createCardInstallments` in ONE
 *     transaction: 6 parcels, one statement per cycle, card debt + total,
 *     no bank debit, canonical receipt.
 *
 * Negative path: a second proposal is rejected; it writes ZERO extra parcels.
 * Recovery path: a third proposal survives a full reload and is rejected.
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
const USER_TEXT = "Comprei R$ 1.200 em 6x no Nubank.";
const CONFIRM_LABEL = /Confirmar R\$ 1\.200,00/;
const WORKSPACE_ID = "00000000-0000-4000-8000-00000000000a";
const INSTALLMENT_AMOUNTS = [20000, 20000, 20000, 20000, 20000, 20000];
const INSTALLMENT_DATES = [
  "2026-11-07",
  "2026-12-07",
  "2027-01-07",
  "2027-02-07",
  "2027-03-07",
  "2027-04-07",
];

type LedgerTxn = {
  id: string;
  kind: string;
  amountCents: number;
  description: string;
  date: string;
  accountId: string;
  categoryId?: string;
};

type LedgerAccount = { id: string; name: string; kind: string; balanceCents: number };

async function ctlGet<T>(pathname: string): Promise<T> {
  const res = await fetch(`${CTL}${pathname}`);
  if (!res.ok) throw new Error(`ctl GET ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}

const ctlState = () =>
  ctlGet<{ transactions: LedgerTxn[]; total: number; accounts: LedgerAccount[] }>("/p2d/expense-state");
const ctlStats = () =>
  ctlGet<{ promptCalls: number; transportCalls: number; stubTurns: number; stubMismatches: string[] }>("/p2d/stats");
const ctlJournal = () =>
  ctlGet<{ requests: Array<{ method: string; url: string }>; financialWrites: Array<{ method: string; url: string }> }>(
    "/p2d/journal",
  );

/** The scripted installment set is the only group with this exact tuple. */
const installmentRows = (state: { transactions: LedgerTxn[] }, cardId: string) =>
  state.transactions
    .filter(
      (t) =>
        t.kind === "expense" &&
        t.description === "celular" &&
        t.accountId === cardId,
    )
    .sort((a, b) => a.date.localeCompare(b.date));

const accountBalance = (state: { accounts: LedgerAccount[] }, accountId: string) =>
  state.accounts.find((a) => a.id === accountId)?.balanceCents;

const countJournal = (
  journal: { requests: Array<{ method: string; url: string }> },
  method: string,
  matcher: (url: string) => boolean,
) => journal.requests.filter((r) => r.method === method && matcher(r.url)).length;

async function openTed(page: import("@playwright/test").Page) {
  const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  await expect(launcher).toBeVisible({ timeout: 120000 });
  await launcher.click();
  await page.waitForURL(/\/ted/);
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 300000 });
  await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 300000 });
  return input;
}

async function sendTed(page: import("@playwright/test").Page, text: string) {
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 300000 });
  await input.fill(text);
  const sendButton = page.getByRole("button", { name: /enviar mensagem/i });
  await expect(sendButton).toBeEnabled({ timeout: 300000 });
  await sendButton.click();
}

test.describe.configure({ mode: "serial" });

test.describe("p3.5 installments slice (real browser, real Agent, Pending V2)", () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    try {
      console.log("[p3-installments-diagnostic] health", JSON.stringify(await ctlGet("/health")));
    } catch {
      /* noop */
    }
    try {
      console.log("[p3-installments-diagnostic] stats", JSON.stringify(await ctlStats()));
    } catch {
      /* noop */
    }
  });

  test("proposal → confirm → 6 parcels in 6 statements; reject/reload never duplicate", async ({ page }, testInfo) => {
    test.setTimeout(1_800_000);

    // 1. Stack health + zero-turn baseline.
    const health = await ctlGet<{ ok: boolean; agentRunning: boolean; probeRunning: boolean }>("/health");
    expect(health.ok).toBe(true);
    expect(health.probeRunning).toBe(true);
    expect(health.agentRunning).toBe(true);
    const baseline = await ctlStats();
    expect(baseline.promptCalls).toBe(0);
    expect(baseline.transportCalls).toBe(0);
    expect(baseline.stubTurns).toBe(0);

    const initialState = await ctlState();
    const card = initialState.accounts.find((a) => a.kind === "credit_card");
    expect(card, "the synthetic ledger must expose the credit-card account").toBeTruthy();
    expect(card!.name).toBe("Nubank Card");
    expect(installmentRows(initialState, card!.id)).toHaveLength(0);
    const bank = initialState.accounts.find((a) => a.kind === "bank");
    expect(bank, "the synthetic ledger must expose a bank account").toBeTruthy();
    const bankBefore = bank!.balanceCents;
    const cardDebtBefore = card!.balanceCents;

    // 2. Synthetic user, real Better-Auth login through the UI.
    const email = "ted-p35-installments@example.test";
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
    const signupStatus = await page.evaluate(async (userEmail) => {
      const res = await fetch("/api/backend/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P3.5" }),
      });
      return res.status;
    }, email);
    expect(signupStatus).toBe(200);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("test-password-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("button", { name: /abrir assistente ted/i }).last()).toBeVisible({ timeout: 60000 });

    // 3. Message → OpenCode turn → installment intent → authoritative card.
    await openTed(page);
    await sendTed(page, USER_TEXT);
    const confirmButton = page.getByRole("button", { name: CONFIRM_LABEL });
    await expect(confirmButton).toBeVisible({ timeout: 300000 });

    // (1) Before confirmation: zero parcels exist.
    expect(installmentRows(await ctlState(), card!.id)).toHaveLength(0);
    const afterProposal = await ctlStats();
    expect(afterProposal.promptCalls).toBe(1);
    expect(afterProposal.stubTurns).toBe(2); // tool_call + final text
    expect(afterProposal.stubMismatches).toEqual([]);

    // 4. The preview shows the TOTAL, the parcel split and the first invoice.
    const approvalCard = page
      .locator('div[id^="ted-op-"]')
      .filter({ hasText: "Compra parcelada" })
      .first();
    await expect(approvalCard.getByText("⚠️ Compra parcelada — R$ 1.200,00")).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("celular", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Nubank Card", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Parcelamento", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("6x de R$ 200,00", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Primeira fatura", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("25/11/2026", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("R$ 1.200,00", { exact: true })).toBeVisible({ timeout: 60000 });

    // 5. Confirm → real Agent decision → API confirm+execute → SIX parcels and
    // the canonical receipt bound to the FIRST created transaction.
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
    expect(decisionBody.receipt?.mutationKind).toBe("cards.purchase.create");
    expect(decisionBody.receipt?.status).toBe("succeeded");
    expect(decisionBody.receipt?.entity?.type).toBe("transaction");

    await expect.poll(async () => installmentRows(await ctlState(), card!.id).length, { timeout: 120000 }).toBe(6);
    const afterConfirm = await ctlState();
    const parcels = installmentRows(afterConfirm, card!.id);
    // (2) exactly 6 parcels of R$ 200, with the monthly dates.
    expect(parcels.map((t) => t.amountCents)).toEqual(INSTALLMENT_AMOUNTS);
    expect(parcels.map((t) => t.date)).toEqual(INSTALLMENT_DATES);
    // The receipt is bound to the FIRST parcel, never to a synthetic total.
    expect(decisionBody.receipt?.entity?.id).toBe(parcels[0]!.id);

    // (5) the bank balance is untouched; (4) the card debt grew by the TOTAL.
    expect(accountBalance(afterConfirm, bank!.id)).toBe(bankBefore);
    expect(accountBalance(afterConfirm, card!.id)).toBe(cardDebtBefore + 120000);

    // (3) each parcel is linked to the statement of its own cycle.
    const statements = await page.evaluate(async ({ accountId, workspaceId }) => {
      const response = await fetch(`/api/backend/cards/statements?accountId=${accountId}`, {
        credentials: "include",
        headers: { "X-Workspace-Id": workspaceId },
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as
        | { items?: Array<{ id?: string; cycleYearMonth?: string; totalCents?: number }> }
        | null };
    }, { accountId: card!.id, workspaceId: WORKSPACE_ID });
    expect(statements.status).toBe(200);
    const installedStatements = (statements.body?.items ?? []).filter((s) => s.totalCents === 20000);
    expect(installedStatements).toHaveLength(6);
    expect(installedStatements.map((s) => s.cycleYearMonth).sort()).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
      "2027-04",
    ]);

    // The statement projection exposes its own card_purchases row id (not the
    // transaction id), so linkage is proven by exactly ONE matching parcel per
    // statement, not by id equality with the ledger rows.
    let linkedParcels = 0;
    for (const statement of installedStatements) {
      const detail = await page.evaluate(async ({ statementId, workspaceId }) => {
        const response = await fetch(`/api/backend/cards/statements/${statementId}`, {
          credentials: "include",
          headers: { "X-Workspace-Id": workspaceId },
        });
        return { status: response.status, body: (await response.json().catch(() => null)) as
          | { purchases?: Array<{ id?: string; description?: string; amountCents?: number }> }
          | null };
      }, { statementId: statement.id!, workspaceId: WORKSPACE_ID });
      expect(detail.status).toBe(200);
      const matching = (detail.body?.purchases ?? []).filter(
        (purchase) => purchase.description === "celular" && purchase.amountCents === 20000,
      );
      expect(matching, `statement ${statement.cycleYearMonth} must carry exactly one parcel`).toHaveLength(1);
      linkedParcels += matching.length;
    }
    expect(linkedParcels).toBe(6);

    // (6) Rejection: a second proposal is cancelled; zero extra parcels.
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({ timeout: 60000 });
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
    expect(((await cancelled.json()) as { status?: string }).status).toBe("cancelled");
    await expect.poll(async () => installmentRows(await ctlState(), card!.id).length, { timeout: 60000 }).toBe(6);

    // (7) Recovery after reload: a third proposal is created, the page is
    // reloaded and the authoritative active list rehydrates the SAME card (no
    // new prompt/turn). Rejecting it still writes nothing.
    await sendTed(page, USER_TEXT);
    await expect(page.getByRole("button", { name: CONFIRM_LABEL })).toHaveCount(0, { timeout: 60000 });
    const thirdConfirm = page.getByRole("button", { name: CONFIRM_LABEL });
    await expect(thirdConfirm).toBeVisible({ timeout: 300000 });
    const promptsBeforeReload = (await ctlStats()).promptCalls;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({
      timeout: 300000,
    });
    const recoveredConfirm = page.getByRole("button", { name: CONFIRM_LABEL });
    await expect(recoveredConfirm).toBeVisible({ timeout: 300000 });
    expect((await ctlStats()).promptCalls).toBe(promptsBeforeReload);
    const recoveredReject = recoveredConfirm.locator("xpath=..").getByRole("button", { name: "Cancelar" });
    await expect(recoveredReject).toBeVisible({ timeout: 60000 });
    const recoveredCancelResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/rpc\/pending-operations\/[^/]+\/decision$/.test(new URL(response.url()).pathname),
      { timeout: 180000 },
    );
    await recoveredReject.click();
    const recoveredCancelled = await recoveredCancelResponse;
    expect(recoveredCancelled.status()).toBe(200);
    expect(((await recoveredCancelled.json()) as { status?: string }).status).toBe("cancelled");
    await expect.poll(async () => installmentRows(await ctlState(), card!.id).length, { timeout: 60000 }).toBe(6);

    // (7 continued) No duplicate write and no direct card write: the only
    // financial path is the V2 executor, exactly once.
    const journal = await ctlJournal();
    const proposes = countJournal(journal, "POST", (u) => u === "/pending-operations/v2/propose");
    const confirms = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/confirm$/.test(u));
    const executes = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/execute$/.test(u));
    const cancels = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/(cancel|reject)$/.test(u));
    expect(proposes).toBe(3);
    expect(confirms).toBe(1);
    expect(executes).toBe(1);
    expect(cancels).toBe(2);
    expect(
      journal.financialWrites.filter(
        (w) =>
          w.url === "/cards/purchases" ||
          w.url.startsWith("/cards/purchases?") ||
          w.url === "/cards/installments" ||
          w.url.startsWith("/cards/installments?"),
      ).length,
    ).toBe(0);

    // 10. Bounded, redacted evidence (ids/counts/statuses only).
    const evidence = {
      scope: "p3-installments-slice",
      provider: "local-scripted-only",
      promptCalls: (await ctlStats()).promptCalls,
      proposeRequests: proposes,
      confirmRequests: confirms,
      executeRequests: executes,
      cancelRequests: cancels,
      cardId: card!.id,
      firstTransactionId: parcels[0]!.id,
      statementIds: installedStatements.map((s) => s.id),
      installmentAmountsCents: parcels.map((p) => p.amountCents),
      installmentDates: parcels.map((p) => p.date),
      cardDebtAfterCents: accountBalance(afterConfirm, card!.id),
      bankBalanceBeforeCents: bankBefore,
      bankBalanceAfterCents: accountBalance(afterConfirm, bank!.id),
      rejectedWrites: 0,
      recoveredAfterReload: true,
    };
    const serialized = JSON.stringify(evidence, null, 2);
    expect(serialized).not.toMatch(/cookie|token|secret|password|bearer/i);
    const outDir = path.resolve(process.cwd(), "test-results", "p3-installments");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "evidence.json");
    fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
    await testInfo.attach("p3-installments-evidence", { path: outPath, contentType: "application/json" });
  });
});
