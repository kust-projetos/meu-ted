/**
 * P3.6 statement-payment slice - ONE real-browser journey (test-only, loopback only).
 *
 * Chain:
 *   real Chromium → real Next dev PWA → same-origin proxy `/api/agent`
 *   → real loopback TED gateway → real OpenCode SDK 2.2.4 prompt loop
 *   → LOCAL scripted provider stub → `propose_statement_payment` (intent only)
 *   → authenticated PWA sends the intent to the REAL local Agent Worker
 *     (`wrangler dev --local`, Durable Objects included)
 *   → Pending V2 on the synthetic API → authoritative card
 *     (card, invoice, total/paid/remaining, payer, Confirm/Reject)
 *   → user Confirm → real API V2 executor → ONE statement payment + receipt,
 *     debiting the payer and reducing the card debt.
 *
 * Negative path: rejection writes zero. Recovery path: a proposal survives a
 * full reload (the authoritative active list rehydrates the card) and is then
 * rejected without writing. The confirmation runs LAST because a fully paid
 * invoice must not accept another proposal.
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
const USER_TEXT = "Pague R$ 850 da fatura do cartão Nubank usando minha conta Itaú.";
const CONFIRM_LABEL = /Confirmar R\$ 850,00/;
const WORKSPACE_ID = "00000000-0000-4000-8000-00000000000a";

type LedgerTxn = {
  id: string;
  kind: string;
  amountCents: number;
  description: string;
  date: string;
  accountId: string;
  statementPaymentId?: string;
};

type LedgerAccount = { id: string; name: string; kind: string; balanceCents: number };
type StatementRow = {
  id: string;
  accountId: string;
  cycleYearMonth: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  status: string;
};

async function ctlGet<T>(pathname: string): Promise<T> {
  const res = await fetch(`${CTL}${pathname}`);
  if (!res.ok) throw new Error(`ctl GET ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}

const ctlState = () =>
  ctlGet<{ transactions: LedgerTxn[]; total: number; accounts: LedgerAccount[] }>("/p2d/expense-state");
const ctlStatements = () =>
  ctlGet<{ statements: StatementRow[]; cardBalanceCents?: number }>("/p2d/statement-state");
const ctlStats = () =>
  ctlGet<{ promptCalls: number; transportCalls: number; stubTurns: number; stubMismatches: string[] }>("/p2d/stats");
const ctlJournal = () =>
  ctlGet<{ requests: Array<{ method: string; url: string }>; financialWrites: Array<{ method: string; url: string }> }>(
    "/p2d/journal",
  );

/** The scripted payment is the only row with this exact tuple. */
const paymentRows = (state: { transactions: LedgerTxn[] }, statementId: string) =>
  state.transactions.filter(
    (t) =>
      t.kind === "expense" &&
      t.statementPaymentId === statementId &&
      t.amountCents === 85000,
  );

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

async function decide(
  page: import("@playwright/test").Page,
  button: import("@playwright/test").Locator,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/rpc\/pending-operations\/[^/]+\/decision$/.test(new URL(response.url()).pathname),
    { timeout: 180000 },
  );
  await button.click();
  return responsePromise;
}

test.describe.configure({ mode: "serial" });

test.describe("p3.6 statement payment slice (real browser, real Agent, Pending V2)", () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    try {
      console.log("[p3-statement-diagnostic] health", JSON.stringify(await ctlGet("/health")));
    } catch {
      /* noop */
    }
    try {
      console.log("[p3-statement-diagnostic] stats", JSON.stringify(await ctlStats()));
    } catch {
      /* noop */
    }
  });

  test("reject/reload write zero; confirm pays exactly one invoice", async ({ page }, testInfo) => {
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

    const initialStatements = await ctlStatements();
    const statement = initialStatements.statements.find((s) => s.totalCents === 120000 && s.paidCents === 35000);
    expect(statement, "the synthetic stack must seed a partial invoice (1.200 total / 350 paid)").toBeTruthy();
    const initialState = await ctlState();
    const card = initialState.accounts.find((a) => a.kind === "credit_card");
    expect(card, "the synthetic ledger must expose the credit-card account").toBeTruthy();
    expect(card!.name).toBe("Nubank Card");
    const payer = initialState.accounts.find((a) => a.name === "Itaú");
    expect(payer, "the synthetic ledger must expose the Itaú payer account").toBeTruthy();
    expect(paymentRows(initialState, statement!.id)).toHaveLength(0);

    // 2. Synthetic user, real Better-Auth login through the UI.
    const email = "ted-p36-statement@example.test";
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
    const signupStatus = await page.evaluate(async (userEmail) => {
      const res = await fetch("/api/backend/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P3.6 Statement" }),
      });
      return res.status;
    }, email);
    expect(signupStatus).toBe(200);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("test-password-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("button", { name: /abrir assistente ted/i }).last()).toBeVisible({ timeout: 60000 });

    // 3. First proposal → authoritative card → rejection (zero writes).
    await openTed(page);
    await sendTed(page, USER_TEXT);
    const firstConfirm = page.getByRole("button", { name: CONFIRM_LABEL });
    await expect(firstConfirm).toBeVisible({ timeout: 300000 });
    expect(paymentRows(await ctlState(), statement!.id)).toHaveLength(0);
    const afterFirstProposal = await ctlStats();
    expect(afterFirstProposal.promptCalls).toBe(1);
    expect(afterFirstProposal.stubTurns).toBe(2); // tool_call + final text
    expect(afterFirstProposal.stubMismatches).toEqual([]);

    // 4. The card shows the invoice, card, authoritative amounts and payer.
    const approvalCard = page
      .locator('div[id^="ted-op-"]')
      .filter({ hasText: "Pagamento de fatura" })
      .first();
    await expect(approvalCard.getByText("Pagamento de fatura — R$ 850,00")).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Nubank Card", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("R$ 1.200,00", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("R$ 350,00", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("R$ 850,00", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Itaú", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Conta pagadora", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Fatura", { exact: true })).toBeVisible({ timeout: 60000 });

    const firstReject = firstConfirm.locator("xpath=..").getByRole("button", { name: "Rejeitar" });
    await expect(firstReject).toBeVisible({ timeout: 60000 });
    const firstCancelled = await decide(page, firstReject);
    expect(firstCancelled.status()).toBe(200);
    expect(((await firstCancelled.json()) as { status?: string }).status).toBe("cancelled");
    await expect.poll(async () => paymentRows(await ctlState(), statement!.id).length, { timeout: 60000 }).toBe(0);

    // 5. Second proposal → full reload → recovered SAME card (no new prompt),
    // then rejection (zero writes).
    await sendTed(page, USER_TEXT);
    const secondConfirm = page.getByRole("button", { name: CONFIRM_LABEL });
    await expect(secondConfirm).toBeVisible({ timeout: 300000 });
    const promptsBeforeReload = (await ctlStats()).promptCalls;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({
      timeout: 300000,
    });
    const recoveredConfirm = page.getByRole("button", { name: CONFIRM_LABEL });
    await expect(recoveredConfirm).toBeVisible({ timeout: 300000 });
    expect((await ctlStats()).promptCalls).toBe(promptsBeforeReload);
    const recoveredReject = recoveredConfirm.locator("xpath=..").getByRole("button", { name: "Rejeitar" });
    await expect(recoveredReject).toBeVisible({ timeout: 60000 });
    const recoveredCancelled = await decide(page, recoveredReject);
    expect(recoveredCancelled.status()).toBe(200);
    expect(((await recoveredCancelled.json()) as { status?: string }).status).toBe("cancelled");
    await expect.poll(async () => paymentRows(await ctlState(), statement!.id).length, { timeout: 60000 }).toBe(0);

    // 6. Third proposal → confirm → real Agent decision → API confirm+execute
    // → ONE payment and the canonical statement receipt.
    await sendTed(page, USER_TEXT);
    const thirdConfirm = page.getByRole("button", { name: CONFIRM_LABEL });
    await expect(thirdConfirm).toBeVisible({ timeout: 300000 });
    const decision = await decide(page, thirdConfirm);
    expect(decision.status()).toBe(200);
    const decisionBody = (await decision.json()) as {
      status?: string;
      receipt?: { mutationKind?: string; status?: string; entity?: { type?: string; id?: string } };
    };
    expect(decisionBody.status).toBe("succeeded");
    expect(decisionBody.receipt?.mutationKind).toBe("cards.statement.pay");
    expect(decisionBody.receipt?.status).toBe("succeeded");
    expect(decisionBody.receipt?.entity?.type).toBe("statement");
    expect(decisionBody.receipt?.entity?.id).toBe(statement!.id);

    await expect.poll(async () => paymentRows(await ctlState(), statement!.id).length, { timeout: 120000 }).toBe(1);
    const afterConfirmState = await ctlState();
    const payment = paymentRows(afterConfirmState, statement!.id)[0]!;
    expect(payment.amountCents).toBe(85000);

    // 7. Bank debited, card debt zero, invoice paid (authoritative state).
    const afterStatements = await ctlStatements();
    const paid = afterStatements.statements.find((s) => s.id === statement!.id)!;
    expect(paid.paidCents).toBe(120000);
    expect(paid.status).toBe("paid");
    expect(afterStatements.cardBalanceCents).toBe(0);
    expect(afterConfirmState.accounts.find((a) => a.id === payer!.id)!.balanceCents).toBe(-20000);

    // 8. A fourth proposal is refused because the invoice is fully paid:
    // no new card appears and zero payments are written. Wait for the actual
    // broker response so the journal assertion below is not racy.
    const fourthPropose = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/rpc\/pending-operations\/propose$/.test(new URL(response.url()).pathname),
      { timeout: 180000 },
    );
    await sendTed(page, USER_TEXT);
    const fourth = await fourthPropose;
    expect(fourth.status()).toBe(409);
    await expect(page.getByRole("button", { name: CONFIRM_LABEL })).toHaveCount(0, { timeout: 60000 });
    await expect.poll(async () => paymentRows(await ctlState(), statement!.id).length, { timeout: 60000 }).toBe(1);

    // 9. Aggregate proof: no duplicate payment, no direct card/statement write.
    const journal = await ctlJournal();
    const proposes = countJournal(journal, "POST", (u) => u === "/pending-operations/v2/propose");
    const confirms = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/confirm$/.test(u));
    const executes = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/execute$/.test(u));
    const cancels = countJournal(journal, "POST", (u) => /^\/pending-operations\/v2\/[^/]+\/(cancel|reject)$/.test(u));
    // Four propose requests reached the API; the fourth was refused by the
    // paid-invoice gate before persistence (no confirm/execute for it).
    expect(proposes).toBe(4);
    expect(confirms).toBe(1);
    expect(executes).toBe(1);
    expect(cancels).toBe(2);
    expect(
      journal.financialWrites.filter(
        (w) => w.url === "/cards/purchases" || w.url.startsWith("/cards/purchases?") || /^\/cards\/statements\/[^/]+\/pay$/.test(w.url),
      ).length,
    ).toBe(0);

    // 10. Bounded, redacted evidence (ids/counts/statuses only).
    const evidence = {
      scope: "p3-statement-payment-slice",
      provider: "local-scripted-only",
      promptCalls: (await ctlStats()).promptCalls,
      proposeRequests: proposes,
      confirmRequests: confirms,
      executeRequests: executes,
      cancelRequests: cancels,
      cardId: card!.id,
      statementId: statement!.id,
      paymentTransactionId: payment.id,
      syntheticPaymentRows: paymentRows(afterConfirmState, statement!.id).length,
      duplicatePayment: false,
      recoveredAfterReload: true,
      rejectedWrites: 0,
    };
    const serialized = JSON.stringify(evidence, null, 2);
    expect(serialized).not.toMatch(/cookie|token|secret|password|bearer/i);
    const outDir = path.resolve(process.cwd(), "test-results", "p3-statement-payment");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "evidence.json");
    fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
    await testInfo.attach("p3-statement-payment-evidence", { path: outPath, contentType: "application/json" });
  });
});
