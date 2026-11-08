/**
 * P3.4 card-purchase slice - ONE real-browser journey (test-only, loopback only).
 *
 * Chain:
 *   real Chromium → real Next dev PWA → same-origin proxy `/api/agent`
 *   → real loopback TED gateway → real OpenCode SDK 2.2.4 prompt loop
 *   → LOCAL scripted provider stub → `propose_card_purchase` (intent only)
 *   → authenticated PWA sends the intent to the REAL local Agent Worker
 *     (`wrangler dev --local`, Durable Objects included)
 *   → Pending V2 on the synthetic API → authoritative card
 *     (card, value, description, 1x, Confirm/Reject)
 *   → user Confirm → real API V2 executor → one card purchase + receipt,
 *     linked to the correct statement.
 *
 * Negative path: a second proposal is rejected; it creates ZERO rows.
 * Recovery path: a third proposal survives a full reload (the authoritative
 * active list rehydrates the card) and is then rejected without writing.
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
const USER_TEXT = "Gastei R$ 150 no supermercado, no cartão Nubank";
const CONFIRM_LABEL = /Confirmar R\$ 150,00/;
const WORKSPACE_ID = "00000000-0000-4000-8000-00000000000a";

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

/** The scripted card purchase is the only row with this exact tuple. */
const cardPurchases = (state: { transactions: LedgerTxn[] }, cardId: string) =>
  state.transactions.filter(
    (t) =>
      t.kind === "expense" &&
      t.description === "supermercado" &&
      t.amountCents === 15000 &&
      t.accountId === cardId,
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
  // First hit to /ted cold-compiles the route on the local Next dev server;
  // on a busy CI-class machine that can take several minutes. The timeout is
  // a compile budget, not a product assertion.
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

test.describe("p3.4 card purchase slice (real browser, real Agent, Pending V2)", () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    // Bounded diagnostics only: never cookies, tokens, bodies or raw logs.
    try {
      console.log("[p3-card-diagnostic] health", JSON.stringify(await ctlGet("/health")));
    } catch {
      /* noop */
    }
    try {
      console.log("[p3-card-diagnostic] stats", JSON.stringify(await ctlStats()));
    } catch {
      /* noop */
    }
  });

  test("proposal → confirm → purchase in the statement; reject writes zero; reload recovers", async ({ page }, testInfo) => {
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
    expect(cardPurchases(initialState, card!.id)).toHaveLength(0);

    // 2. Synthetic user, real Better-Auth login through the UI.
    const email = "ted-p34-card@example.test";
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
    const signupStatus = await page.evaluate(async (userEmail) => {
      const res = await fetch("/api/backend/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P3.4 Card" }),
      });
      return res.status;
    }, email);
    expect(signupStatus).toBe(200);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill("test-password-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("button", { name: /abrir assistente ted/i }).last()).toBeVisible({ timeout: 60000 });

    // 3. Message → OpenCode turn → card-purchase intent → authoritative card.
    await openTed(page);
    await sendTed(page, USER_TEXT);
    const confirmButton = page.getByRole("button", { name: CONFIRM_LABEL });
    await expect(confirmButton).toBeVisible({ timeout: 300000 });
    expect(cardPurchases(await ctlState(), card!.id)).toHaveLength(0);
    const afterProposal = await ctlStats();
    expect(afterProposal.promptCalls).toBe(1);
    expect(afterProposal.stubTurns).toBe(2); // tool_call + final text
    expect(afterProposal.stubMismatches).toEqual([]);

    // 4. The card shows the CARD, the VALUE, the DESCRIPTION and 1x. Scope to
    // the approval card: the user's own message also contains "supermercado"
    // and "cartão Nubank".
    // The wrapper testid flips between `ted-approval-item` and
    // `ted-approval-focused` while the newest proposal is focused; the stable
    // anchor is the `ted-op-<id>` wrapper itself.
    const approvalCard = page
      .locator('div[id^="ted-op-"]')
      .filter({ hasText: "Confirmar compra no cartão" })
      .first();
    await expect(approvalCard.getByText("Confirmar compra no cartão")).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("supermercado", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Nubank Card", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("R$ 150,00", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Cartão", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("Parcela", { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(approvalCard.getByText("1x", { exact: true })).toBeVisible({ timeout: 60000 });

    // 5. Confirm → real Agent decision → API confirm+execute → ONE purchase
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
    expect(decisionBody.receipt?.mutationKind).toBe("cards.purchase.create");
    expect(decisionBody.receipt?.status).toBe("succeeded");
    expect(decisionBody.receipt?.entity?.type).toBe("transaction");

    await expect.poll(async () => cardPurchases(await ctlState(), card!.id).length, { timeout: 120000 }).toBe(1);
    const afterConfirm = await ctlState();
    const launched = cardPurchases(afterConfirm, card!.id)[0]!;
    expect(launched.amountCents).toBe(15000);
    expect(decisionBody.receipt?.entity?.id).toBe(launched.id);

    // 6. The purchase is linked to the CORRECT card statement (browser-visible
    // through the same-origin proxy the records/cards pages use).
    const statements = await page.evaluate(async ({ accountId, workspaceId }) => {
      const response = await fetch(`/api/backend/cards/statements?accountId=${accountId}`, {
        credentials: "include",
        headers: { "X-Workspace-Id": workspaceId },
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as
        | { items?: Array<{ id?: string; totalCents?: number }> }
        | null };
    }, { accountId: card!.id, workspaceId: WORKSPACE_ID });
    expect(statements.status).toBe(200);
    const statement = statements.body?.items?.find((s) => s.totalCents === 15000);
    expect(statement?.id, "the purchase must be attached to a statement whose total is R$ 150,00").toBeTruthy();

    const detail = await page.evaluate(async ({ statementId, workspaceId }) => {
      const response = await fetch(`/api/backend/cards/statements/${statementId}`, {
        credentials: "include",
        headers: { "X-Workspace-Id": workspaceId },
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as
        | { purchases?: Array<{ id?: string; description?: string; amountCents?: number }> }
        | null };
    }, { statementId: statement!.id!, workspaceId: WORKSPACE_ID });
    expect(detail.status).toBe(200);
    // The statement projection exposes the card-purchase row (its own id);
    // the receipt entity id proves the same purchase at the ledger level.
    expect(
      detail.body?.purchases?.some(
        (p: { id?: string; description?: string; amountCents?: number }) =>
          p.description === "supermercado" && p.amountCents === 15000,
      ),
    ).toBe(true);

    // 7. Rejection: a second proposal is cancelled. Zero extra purchases.
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({
      timeout: 60000,
    });
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
    await expect.poll(async () => cardPurchases(await ctlState(), card!.id).length, { timeout: 60000 }).toBe(1);

    // 8. Recovery after reload: a third proposal is created, the page is
    // reloaded, and the authoritative active list rehydrates the SAME card
    // (no new prompt/turn). Rejecting it still writes nothing.
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
    await expect.poll(async () => cardPurchases(await ctlState(), card!.id).length, { timeout: 60000 }).toBe(1);

    // 9. Aggregate proof: no duplicate purchase, no direct card write.
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
      journal.financialWrites.filter((w) => w.url === "/cards/purchases" || w.url.startsWith("/cards/purchases?")).length,
    ).toBe(0);

    // 10. Bounded, redacted evidence (ids/counts/statuses only).
    const evidence = {
      scope: "p3-card-purchase-slice",
      provider: "local-scripted-only",
      promptCalls: (await ctlStats()).promptCalls,
      proposeRequests: proposes,
      confirmRequests: confirms,
      executeRequests: executes,
      cancelRequests: cancels,
      cardId: card!.id,
      transactionId: launched.id,
      statementId: statement!.id,
      syntheticCardPurchaseRows: cardPurchases(afterConfirm, card!.id).length,
      duplicateLaunch: false,
      recoveredAfterReload: true,
      rejectedWrites: 0,
    };
    const serialized = JSON.stringify(evidence, null, 2);
    expect(serialized).not.toMatch(/cookie|token|secret|password|bearer/i);
    const outDir = path.resolve(process.cwd(), "test-results", "p3-card-purchase");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "evidence.json");
    fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
    await testInfo.attach("p3-card-purchase-evidence", { path: outPath, contentType: "application/json" });
  });
});
