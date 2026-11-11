/**
 * P3.9 — real-model integrated pilot: 7 operations / 7 confirmations in one
 * conversation (DeepSeek via opencode-go, synthetic local stack). Evidence is
 * structural (routes/counts/ids/amounts/states); never reads or records a credential.
 * Reuses financial verification logic from p3-integrated.spec.ts and real
 * approval/statement flow from p3-card-discovery-smoke.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { resolveP2dPorts } from "../support/ports";

const CTL = `http://127.0.0.1:${resolveP2dPorts(process.env).ctlPort}`;
const WORKSPACE_ID = "00000000-0000-4000-8000-00000000000a";
test.skip(
  process.env.P2D_LIVE_REAL !== "1" || process.env.P2D_P3_PILOT !== "1",
  "requires explicit P2D live-real P3 pilot opt-in",
);

type Tx = {
  id: string; kind: string; amountCents: number; description: string; date: string;
  accountId: string; transferToAccountId?: string; statementPaymentId?: string; categoryId?: string;
};
type Account = { id: string; name: string; kind: string; balanceCents: number };
type State = { transactions: Tx[]; total: number; accounts: Account[] };
type Statement = { id: string; accountId: string; cycleYearMonth: string; totalCents: number; paidCents: number; status: string };
type Journal = { requests?: Array<{ method?: string; url?: string }>; financialWrites?: Array<{ method?: string; url?: string }> };
type Stats = {
  promptCalls?: number;
  transportCalls?: number;
  financeReads?: Array<{ method?: string; route?: string; statusCode?: number }>;
  financeToolNames?: string[] | null;
};
type StepEvidence = {
  step: number;
  operation: string;
  message: string;
  toolReads: Array<{ method?: string; route?: string; statusCode?: number }>;
  amountCents: number;
  accounts: Record<string, string | number | undefined>;
  proposalCountBefore: number;
  proposalCountAfter: number;
  noWriteBeforeApproval: boolean;
  approved: boolean;
  receipt?: { mutationKind?: string; entityId?: string; status?: string };
  stateBefore: { txCount: number; balances: Record<string, number | undefined> };
  stateAfter: { txCount: number; balances: Record<string, number | undefined> };
  result: "PASS" | "FAIL";
  note?: string;
};

async function ctl<T>(route: string): Promise<T> {
  const res = await fetch(`${CTL}${route}`);
  if (!res.ok) throw new Error(`control ${route}: ${res.status}`);
  return (await res.json()) as T;
}
const state = () => ctl<State>("/p2d/expense-state");
const statements = () => ctl<{ statements: Statement[]; cardBalanceCents: number }>("/p2d/statement-state");
const journal = () => ctl<Journal>("/p2d/journal");
const stats = () => ctl<Stats>("/p2d/stats");
const proposalCount = (j: Journal) =>
  (j.requests ?? []).filter((r) => r.method === "POST" && /^\/pending-operations\/v2\/propose(?:\?|$)/.test(String(r.url ?? ""))).length;
const countPath = (j: Journal, re: RegExp) =>
  (j.requests ?? []).filter((r) => r.method === "POST" && re.test(String(r.url ?? ""))).length;
const byName = (accounts: Account[], name: string) => accounts.find((a) => a.name === name);
const byKind = (accounts: Account[], kind: string) => accounts.find((a) => a.kind === kind);
const balance = (accounts: Account[], id?: string) => accounts.find((a) => a.id === id)?.balanceCents;

function expenseCents(body: Record<string, unknown>): number {
  const summary = body.summary as Record<string, unknown> | undefined;
  return Number(body.expenseCents ?? summary?.expenseCents ?? 0);
}

function writeEvidence(evidence: Record<string, unknown>, file = "evidence.json") {
  const out = path.resolve(process.cwd(), "test-results", "p3-integrated-real", file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return out;
}

async function openTed(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
  const email = "ted-p39-real-sixflow@example.test";
  const status = await page.evaluate(async (userEmail) => (await fetch("/api/backend/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P3.9 Real" }),
  })).status, email);
  // The P2D stack is shared by both tests in this file: the first one may
  // already have created this synthetic user, so 422 (already registered) is
  // an acceptable idempotent outcome for the second test.
  expect([200, 422]).toContain(status);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("test-password-123");
  await page.getByRole("button", { name: "Entrar" }).click();
  const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  await expect(launcher).toBeVisible({ timeout: 120000 });
  await launcher.click();
  await page.waitForURL(/\/ted/);
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 300000 });
  await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 300000 });
  return input;
}

async function send(page: Page, text: string) {
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 300000 });
  await input.fill(text);
  const btn = page.getByRole("button", { name: /enviar mensagem/i });
  await expect(btn).toBeEnabled({ timeout: 300000 });
  await btn.click();
}

async function waitForConfirm(page: Page, label: RegExp, timeout = 360000) {
  const confirm = page.getByRole("button", { name: label }).last();
  const sendBtn = page.getByRole("button", { name: /enviar mensagem/i });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await confirm.isVisible().catch(() => false)) return confirm;
    // If model finished responding (send re-enabled) but no confirm appeared,
    // return null so caller can nudge — never auto-approve anything.
    const sendEnabled = await sendBtn.isEnabled().catch(() => false);
    const connecting = await page.getByText("conectando.", { exact: false }).count().catch(() => 1);
    if (sendEnabled && connecting === 0 && !(await confirm.isVisible().catch(() => false))) return null;
    await page.waitForTimeout(1500);
  }
  await expect(confirm).toBeVisible({ timeout: 5000 });
  return confirm;
}

async function nudgeUntilConfirm(page: Page, label: RegExp, nudgeText: string, nudges = 2) {
  let confirm = await waitForConfirm(page, label);
  let used = 0;
  while (!confirm && used < nudges) {
    // Model responded without the expected proposal; nudge it to proceed.
    // This is continuation only — never approves/cancels any proposal.
    await send(page, nudgeText);
    confirm = await waitForConfirm(page, label);
    used++;
  }
  if (!confirm) {
    await expect(page.getByRole("button", { name: label }).last()).toBeVisible({ timeout: 30000 });
  }
  return page.getByRole("button", { name: label }).last();
}

async function decide(page: Page, button: ReturnType<Page["getByRole"]>) {
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/rpc\/pending-operations\/[^/]+\/decision$/.test(new URL(r.url()).pathname),
    { timeout: 180000 },
  );
  await button.click();
  const res = await response;
  if (res.status() !== 200) {
    // Diagnostic only: the Agent maps API failures to 502; keep the sanitized
    // API code/message so the failure names the real cause (no secrets).
    const body = await res.text().catch(() => "");
    const log = await fetch(`${CTL}/p2d/agent-log`).then((r) => r.json()).catch(() => null) as
      | { lastLines?: string[] }
      | null;
    const failureLines = (log?.lastLines ?? []).filter((line) => /ted\.approval|decision_failed|approval_failed/i.test(line));
    throw new Error(
      `decision failed status=${res.status()} body=${body.slice(0, 300)} agentFailure=${JSON.stringify(failureLines).slice(0, 700)}`,
    );
  }
  return res;
}

test("P3.9 real six-flow: 7 operations, 7 confirmations, continuity and recovery", async ({ page }, info) => {
  test.setTimeout(2_400_000); // 40 min: 7 real-model turns + confirmations + continuity
  const steps: StepEvidence[] = [];
  const evidenceBase: Record<string, unknown> = {
    scope: "p3-real-six-flow",
    criterion: "P3_REAL_SIX_FLOW_PASS",
    model: "opencode-go/deepseek-v4.1-flash",
    date: "2026-11-07",
    steps,
  };
  const persist = async (extra: Record<string, unknown> = {}) => {
    const ev = { ...evidenceBase, ...extra };
    const out = writeEvidence(ev);
    await info.attach("p3-real-six-flow-evidence", { path: out, contentType: "application/json" });
    return ev;
  };

  try {
    expect(await ctl("/health")).toMatchObject({ ok: true, agentRunning: true, probeRunning: true });
    const initial = await state();
    const itau = byName(initial.accounts, "Itaú");
    const nubank = byName(initial.accounts, "Nubank");
    const card = byKind(initial.accounts, "credit_card");
    expect(itau, "Itaú account required").toBeTruthy();
    expect(nubank, "Nubank bank account required").toBeTruthy();
    expect(card, "Nubank credit card required").toBeTruthy();
    const initialBalances = {
      itau: itau!.balanceCents,
      nubank: nubank!.balanceCents,
      cardDebt: card!.balanceCents,
    };
    const initialTxCount = initial.transactions.length;
    const initialJournal = await journal();
    const initialProposals = proposalCount(initialJournal);

    await openTed(page);

    type Op = {
      step: number; operation: string; message: string; label: RegExp; mutation: string;
      amountCents: number; txDelta?: number; // default 1
      verify: (before: State, after: State) => Record<string, unknown>;
    };

    const ops: Op[] = [
      {
        step: 1, operation: "Despesa Mercado R$65 Itaú", amountCents: 6500, mutation: "transactions.expense.create",
        message: "Registre uma despesa de R$ 65,00 no Mercado, paga pela conta Itaú, em 07/11/2026.",
        label: /Confirmar R\$ 65,00/,
        verify: (before, after) => {
          const d = balance(after.accounts, itau!.id)! - balance(before.accounts, itau!.id)!;
          expect(d).toBe(-6500);
          return { itauDelta: d };
        },
      },
      {
        step: 2, operation: "Receita Salário R$800 Itaú", amountCents: 80000, mutation: "transactions.income.create",
        message: "Registre uma receita de salário de R$ 800,00 recebida na conta Itaú em 07/11/2026.",
        label: /Confirmar R\$ 800,00/,
        verify: (before, after) => {
          const d = balance(after.accounts, itau!.id)! - balance(before.accounts, itau!.id)!;
          expect(d).toBe(80000);
          return { itauDelta: d };
        },
      },
      {
        step: 3, operation: "Transferência R$150 Itaú→Nubank banco", amountCents: 15000, mutation: "transactions.transfer.create",
        message: "Transfira R$ 150,00 da conta Itaú para a conta Nubank (banco) em 07/11/2026.",
        label: /Confirmar R\$ 150,00/,
        verify: (before, after) => {
          const di = balance(after.accounts, itau!.id)! - balance(before.accounts, itau!.id)!;
          const dn = balance(after.accounts, nubank!.id)! - balance(before.accounts, nubank!.id)!;
          expect(di).toBe(-15000);
          expect(dn).toBe(15000);
          return { itauDelta: di, nubankDelta: dn };
        },
      },
      {
        step: 4, operation: "Compra R$120 Nubank Card 1x", amountCents: 12000, mutation: "cards.purchase.create",
        message: "Registre uma compra à vista de R$ 120,00 no cartão Nubank Card, em 1 parcela, em 07/11/2026.",
        label: /Confirmar R\$ 120,00/,
        verify: (before, after) => {
          const created = after.transactions.filter((t) => t.kind === "expense" && t.accountId === card!.id && t.amountCents === 12000);
          expect(created.length).toBeGreaterThanOrEqual(1);
          return { cardPurchaseId: created[created.length - 1]?.id, count: created.length, date: created[created.length - 1]?.date };
        },
      },
      {
        step: 5, operation: "Compra R$600 Nubank Card 3x", amountCents: 60000, mutation: "cards.purchase.create", txDelta: 3,
        message: "Registre uma compra parcelada de R$ 600,00 no cartão Nubank Card, em 3 parcelas, em 07/11/2026.",
        label: /Confirmar R\$ 600,00/,
        verify: (_before, after) => {
          const parcels = after.transactions
            .filter((t) => t.accountId === card!.id && t.amountCents === 20000 && t.date >= "2026-11-07" && t.date <= "2027-01-31")
            .sort((a, b) => a.date.localeCompare(b.date));
          const dates = parcels.map((p) => p.date);
          // Competence months Nov/Dec/Jan (day may follow card cycle; amounts/dates ordered).
          expect(parcels.length).toBe(3);
          expect(dates[0]?.startsWith("2026-11")).toBe(true);
          expect(dates[1]?.startsWith("2026-12")).toBe(true);
          expect(dates[2]?.startsWith("2027-01")).toBe(true);
          return { installments: parcels.map((p) => ({ amountCents: p.amountCents, date: p.date, id: p.id })) };
        },
      },
      {
        step: 6, operation: "Pagamento R$300 fatura novembro Itaú", amountCents: 30000, mutation: "cards.statement.pay",
        message: "Pague R$ 300,00 da fatura de novembro do cartão Nubank Card, usando a conta Itaú.",
        label: /Confirmar R\$ 300,00/,
        verify: (before, after) => {
          const di = balance(after.accounts, itau!.id)! - balance(before.accounts, itau!.id)!;
          expect(di).toBe(-30000);
          return { itauDelta: di };
        },
      },
      {
        step: 7, operation: "Quitação restante fatura novembro", amountCents: 2000, mutation: "cards.statement.pay",
        message: "Quite o restante da fatura de novembro do cartão Nubank Card, pagando pela conta Itaú.",
        label: /Confirmar R\$ 20,00/,
        verify: (before, after) => {
          const di = balance(after.accounts, itau!.id)! - balance(before.accounts, itau!.id)!;
          // Remaining should be 20,00 (320 total - 300 paid)
          expect(di).toBe(-2000);
          return { itauDelta: di };
        },
      },
    ];

    for (const op of ops) {
      const beforeState = await state();
      const beforeJournal = await journal();
      const beforeProposals = proposalCount(beforeJournal);
      const beforeStats = await stats();
      const readBase = (beforeStats.financeReads ?? []).length;
      const stepEv: StepEvidence = {
        step: op.step,
        operation: op.operation,
        message: op.message,
        toolReads: [],
        amountCents: op.amountCents,
        accounts: {},
        proposalCountBefore: beforeProposals,
        proposalCountAfter: beforeProposals,
        noWriteBeforeApproval: false,
        approved: false,
        stateBefore: {
          txCount: beforeState.transactions.length,
          balances: {
            itau: balance(beforeState.accounts, itau!.id),
            nubank: balance(beforeState.accounts, nubank!.id),
            cardDebt: balance(beforeState.accounts, card!.id),
          },
        },
        stateAfter: { txCount: beforeState.transactions.length, balances: {} },
        result: "FAIL",
      };
      steps.push(stepEv);
      await persist({ verdict: "IN_PROGRESS", failedAt: null });

      await send(page, op.message);

      // Wait for expected confirm; if model responds without proposing, nudge
      // (continuation only — never approve/cancel). Never accept wrong proposal.
      let confirm: ReturnType<Page["getByRole"]>;
      try {
        confirm = await nudgeUntilConfirm(
          page,
          op.label,
          `Prossiga agora com a proposta de confirmação: ${op.operation}, valor exato R$ ${(op.amountCents / 100).toFixed(2).replace(".", ",")}, data 07/11/2026. Não execute sem confirmação.`,
        );
      } catch (e) {
        const afterStats = await stats().catch(() => beforeStats);
        stepEv.toolReads = (afterStats.financeReads ?? []).slice(readBase);
        // capture any visible confirm buttons (diagnostic, no secrets)
        const anyConfirm = await page.getByRole("button", { name: /Confirmar/ }).count().catch(() => 0);
        stepEv.note = `no matching proposal after nudges (confirmsVisible=${anyConfirm}, ${String((e as Error)?.message || e).slice(0, 140)})`;
        await persist({ verdict: "FAIL", failedAt: op.step, error: stepEv.note });
        throw e;
      }

      // No financial execution before approval.
      const midState = await state();
      const midJournal = await journal();
      stepEv.noWriteBeforeApproval =
        midState.transactions.length === beforeState.transactions.length &&
        (midJournal.financialWrites ?? []).length === (beforeJournal.financialWrites ?? []).length;
      expect(stepEv.noWriteBeforeApproval, `step ${op.step}: write before approval`).toBe(true);

      const decisionRes = await decide(page, confirm);
      expect(decisionRes.status()).toBe(200);
      const decisionBody = (await decisionRes.json()) as {
        status?: string; receipt?: { mutationKind?: string; status?: string; entity?: { type?: string; id?: string } };
      };
      expect(decisionBody.status).toBe("succeeded");
      expect(decisionBody.receipt?.mutationKind).toBe(op.mutation);
      expect(decisionBody.receipt?.status).toBe("succeeded");

      const txDelta = op.txDelta ?? 1;
      await expect.poll(async () => (await state()).transactions.length, { timeout: 180000 }).toBe(beforeState.transactions.length + txDelta);

      const afterState = await state();
      const afterJournal = await journal();
      const afterStats = await stats();
      stepEv.toolReads = (afterStats.financeReads ?? []).slice(readBase);
      stepEv.proposalCountAfter = proposalCount(afterJournal);
      stepEv.approved = true;
      stepEv.receipt = {
        mutationKind: decisionBody.receipt?.mutationKind,
        entityId: decisionBody.receipt?.entity?.id,
        status: decisionBody.receipt?.status,
      };
      stepEv.note = `toolNames=${JSON.stringify(afterStats.financeToolNames ?? null)}`;
      stepEv.stateAfter = {
        txCount: afterState.transactions.length,
        balances: {
          itau: balance(afterState.accounts, itau!.id),
          nubank: balance(afterState.accounts, nubank!.id),
          cardDebt: balance(afterState.accounts, card!.id),
        },
      };
      const verifyInfo = op.verify(beforeState, afterState);
      stepEv.accounts = { itauId: itau!.id, nubankId: nubank!.id, cardId: card!.id, ...verifyInfo };
      stepEv.result = "PASS";
      await persist({ verdict: "IN_PROGRESS" });
    }

    // Aggregate financial validation (compare to captured initial state).
    const finalState = await state();
    const finalStatements = await statements();
    const nov = finalStatements.statements.find((s) => s.cycleYearMonth === "2026-11");
    expect(nov, "November statement must exist").toBeTruthy();
    expect(nov!.totalCents).toBe(32000);
    expect(nov!.paidCents).toBe(32000);
    expect(nov!.totalCents - nov!.paidCents).toBe(0);
    expect(nov!.status).toBe("paid");

    const itauDelta = balance(finalState.accounts, itau!.id)! - initialBalances.itau;
    const nubankDelta = balance(finalState.accounts, nubank!.id)! - initialBalances.nubank;
    const cardDebtDelta = balance(finalState.accounts, card!.id)! - initialBalances.cardDebt;
    expect(itauDelta).toBe(26500);
    expect(nubankDelta).toBe(15000);
    expect(cardDebtDelta).toBe(40000);

    const parcelTxs = finalState.transactions
      .filter((t) => t.accountId === card!.id && t.amountCents === 20000)
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(parcelTxs).toHaveLength(3);
    expect(parcelTxs.map((t) => t.date.slice(0, 7))).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(parcelTxs.every((t) => t.amountCents === 20000)).toBe(true);

    const payments = finalState.transactions.filter((t) => t.statementPaymentId === nov!.id);
    expect(payments.map((t) => t.amountCents).sort((a, b) => a - b)).toEqual([2000, 30000]);

    // Competence expenses Nov (no statement payment duplication).
    // Step 1 expense (65, Nov) + 1x card 120 (Nov) + Nov installment 200 = 385.
    const novCompetence = finalState.transactions.filter((t) => {
      if (t.date.slice(0, 7) !== "2026-11") return false;
      if (t.kind !== "expense") return false;
      if (t.statementPaymentId) return false;
      // Only transactions created in this run (exclude seed June txns context not needed; June filtered out)
      return true;
    });
    const novExpenseSum = novCompetence.reduce((s, t) => s + t.amountCents, 0);
    expect(novExpenseSum).toBe(38500);
    expect(novCompetence.some((t) => t.statementPaymentId)).toBe(false);

    // No duplicates (by id uniqueness already structural; also check key operation amounts appear expected times).
    const ids = finalState.transactions.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Month summary consistency (if endpoint responds as in synthetic spec).
    const summary = await page.evaluate(async (workspaceId) => {
      const get = async (basis: string) => {
        const r = await fetch(`/api/backend/dashboard/month-summary?yearMonth=2026-11${basis ? `&basis=${basis}` : ""}`, {
          credentials: "include", headers: { "X-Workspace-Id": workspaceId },
        });
        return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
      };
      return { liquidity: await get(""), competence: await get("competencia") };
    }, WORKSPACE_ID);
    const summaryEvidence: Record<string, unknown> = { summary };
    if (summary.liquidity.status === 200 && summary.competence.status === 200 && summary.competence.body) {
      expect(expenseCents(summary.competence.body)).toBe(38500);
      summaryEvidence.competenceExpenseCents = expenseCents(summary.competence.body);
      summaryEvidence.liquidityExpenseCents = expenseCents(summary.liquidity.body!);
    }

    // Continuity/context after paying off.
    const promptsBefore = (await stats()).promptCalls ?? 0;
    await send(page, "Quanto falta pagar dessa fatura de novembro do Nubank Card?");
    await expect(page.getByText(/quitad|paga|R\$ ?0|zero|nada|não (há|falta)/i).last()).toBeVisible({ timeout: 180000 });
    await expect(page.getByRole("button", { name: /Confirmar/ })).toHaveCount(0);

    await send(page, "Qual conta usei para pagar essa fatura?");
    await expect(page.getByText(/Itaú/i).last()).toBeVisible({ timeout: 180000 });
    await expect(page.getByRole("button", { name: /Confirmar/ })).toHaveCount(0);

    const stateBeforeExtraPay = await state();
    await send(page, "Posso pagar mais R$ 100 nessa mesma fatura de novembro?");
    // Must recognize it's paid off and NOT register additional payment / not propose a valid extra payment.
    await expect(page.getByText(/quitad|paga|não (é )?poss[ií]vel|já (está|foi) paga|saldo|R\$ ?0|zero|nada/i).last()).toBeVisible({ timeout: 180000 });
    // If a confirm button appears, it would be wrong for an already-paid statement; wait briefly and assert none with R$100.
    await page.waitForTimeout(3000);
    const wrongPay = page.getByRole("button", { name: /Confirmar R\$ 100,00/ });
    expect(await wrongPay.count()).toBe(0);
    expect((await state()).transactions.length).toBe(stateBeforeExtraPay.transactions.length);

    // Recovery/idempotency reuse (reload + cancel extra proposal; no new prompt turn consumed by reload).
    await send(page, "Registre uma despesa extra de R$ 1.000,00 no Mercado, conta Itaú, 07/11/2026.");
    const extra = page.getByRole("button", { name: /Confirmar R\$ 1\.000,00/ });
    await expect(extra).toBeVisible({ timeout: 300000 });
    expect((await state()).transactions.filter((t) => t.description?.toLowerCase().includes("extra") && t.amountCents === 100000)).toHaveLength(0);
    const promptsBeforeReload = (await stats()).promptCalls ?? 0;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({ timeout: 300000 });
    await expect(page.getByRole("button", { name: /Confirmar R\$ 1\.000,00/ })).toBeVisible({ timeout: 300000 });
    expect((await stats()).promptCalls ?? 0).toBe(promptsBeforeReload);
    const cancelRes = await decide(page, page.getByRole("button", { name: "Cancelar" }).last());
    expect(cancelRes.status()).toBe(200);
    expect(((await cancelRes.json()) as { status?: string }).status).toBe("cancelled");
    expect((await state()).transactions.filter((t) => t.amountCents === 100000)).toHaveLength(0);

    const finalJournal = await journal();
    const finalStats = await stats();
    const pass =
      steps.every((s) => s.result === "PASS") &&
      itauDelta === 26500 &&
      nubankDelta === 15000 &&
      cardDebtDelta === 40000 &&
      nov!.paidCents === nov!.totalCents &&
      novExpenseSum === 38500;

    await persist({
      verdict: pass ? "P3_REAL_SIX_FLOW_PASS" : "FAIL",
      "P3_REAL_SIX_FLOW_PASS": pass ? "SIM" : "NÃO",
      initial: { balances: initialBalances, txCount: initialTxCount, proposals: initialProposals },
      final: {
        balances: {
          itau: balance(finalState.accounts, itau!.id),
          nubank: balance(finalState.accounts, nubank!.id),
          cardDebt: balance(finalState.accounts, card!.id),
        },
        txCount: finalState.transactions.length,
        deltasCents: { itau: itauDelta, nubank: nubankDelta, cardDebt: cardDebtDelta },
      },
      novemberStatement: { id: nov!.id, totalCents: nov!.totalCents, paidCents: nov!.paidCents, status: nov!.status },
      installments: parcelTxs.map((t) => ({ amountCents: t.amountCents, date: t.date })),
      payments: payments.map((t) => ({ amountCents: t.amountCents, statementPaymentId: t.statementPaymentId })),
      novemberCompetenceExpenseCents: novExpenseSum,
      continuity: { promptsAfterSeven: ((await stats()).promptCalls ?? 0) - promptsBefore, noExtraPayment: true },
      journal: {
        proposals: proposalCount(finalJournal),
        confirms: countPath(finalJournal, /^\/pending-operations\/v2\/[^/]+\/confirm$/),
        executes: countPath(finalJournal, /^\/pending-operations\/v2\/[^/]+\/execute$/),
        cancels: countPath(finalJournal, /^\/pending-operations\/v2\/[^/]+\/(cancel|reject)$/),
        financialWrites: (finalJournal.financialWrites ?? []).length,
      },
      toolReads: finalStats.financeReads ?? [],
      ...summaryEvidence,
    });
    expect(pass).toBe(true);
  } catch (err) {
    const failedAt = steps.find((s) => s.result !== "PASS")?.step ?? "unknown";
    await persist({
      verdict: "FAIL",
      "P3_REAL_SIX_FLOW_PASS": "NÃO",
      failedAt,
      error: String((err as Error)?.message || err).slice(0, 400),
    }).catch(() => {});
    throw err;
  }
});

/**
 * V1 functional completion — real-model journeys for the tools added in the
 * V1 closure: financial reads, account/description updates and payables.
 * Reuses the SAME P2D live-real stack (no new infrastructure); runs after the
 * P3.9 pilot in the same file so `pnpm test:p2d-p3-pilot-real` still drives it.
 */
test("P3.9 real six-flow — V1 functional completion: reads, CRUD and payables with the real model", async ({ page }, info) => {
  test.setTimeout(2_400_000);
  const evidence: Record<string, unknown> = {
    scope: "v1-functional-completion",
    criterion: "V1_FUNCTIONAL_REAL_PASS",
    model: "opencode-go/deepseek-v4.1-flash",
    steps: [] as Array<Record<string, unknown>>,
  };
  const persist = async (extra: Record<string, unknown> = {}) => {
    const ev = { ...evidence, ...extra };
    const out = path.resolve(process.cwd(), "test-results", "v1-functional-real", "evidence.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(ev, null, 2)}\n`, "utf8");
    await info.attach("v1-functional-real-evidence", { path: out, contentType: "application/json" });
    return ev;
  };
  const steps = evidence.steps as Array<Record<string, unknown>>;
  const mark = (name: string, data: Record<string, unknown>) => {
    steps.push({ name, result: "PASS", ...data });
  };

  async function waitTurnEnd() {
    // The composer is intentionally disabled while the input is empty, so
    // "send enabled" is NOT a turn-completion signal. The stable signal is the
    // busy label disappearing; the assistant bubble/history follows.
    await expect(page.getByText(/escrevendo\.\.\.|conectando\./i)).toHaveCount(0, { timeout: 240000 });
    await page.waitForTimeout(1500);
  }

  async function waitCard(title: string, confirmLabel: RegExp, nudge: string) {
    let confirm = await waitForConfirm(page, confirmLabel);
    let used = 0;
    while (!confirm && used < 2) {
      await send(page, nudge);
      confirm = await waitForConfirm(page, confirmLabel);
      used++;
    }
    if (!confirm) {
      await expect(page.getByRole("button", { name: confirmLabel }).last()).toBeVisible({ timeout: 30000 });
    }
    await expect(page.getByText(title).last()).toBeVisible({ timeout: 60000 });
    return page.getByRole("button", { name: confirmLabel }).last();
  }

  try {
    await openTed(page);
    const before = await state();
    const itau = byName(before.accounts, "Itaú");
    const nubank = byName(before.accounts, "Nubank");
    expect(itau, "Itaú account required").toBeTruthy();
    expect(nubank, "Nubank account required").toBeTruthy();
    expect(nubank!.name).toBe("Nubank");

    // Journey 1 — financial reads (budgets/goals/payables/analytics/audit)
    // in one grounded turn. No write may occur.
    const readsBase = (await stats()).financeReads?.length ?? 0;
    const txBase = (await state()).transactions.length;
    await send(page, "Quais são meus orçamentos, metas, contas a pagar e KPIs deste mês?");
    await waitTurnEnd();
    await expect
      .poll(async () => {
        const reads = (await stats()).financeReads ?? [];
        const routes = reads.slice(readsBase).map((r) => String(r.route ?? ""));
        return ["/budgets", "/goals", "/payables", "/analytics/kpis"].filter((r) => routes.some((x) => x === r || x.startsWith(`${r}?`)));
      }, { timeout: 180000 })
      .toEqual(["/budgets", "/goals", "/payables", "/analytics/kpis"]);
    expect((await state()).transactions.length).toBe(txBase);
    mark("financial-reads", { routes: ((await stats()).financeReads ?? []).slice(readsBase).map((r) => r.route) });
    await persist({ verdict: "IN_PROGRESS" });

    // Journey 2 — account rename through the conversational CRUD.
    await send(page, "Renomeie a conta Nubank para Nubank Principal.");
    const renameConfirm = await waitCard("Renomear conta", /^Confirmar$/, "Prossiga com a proposta de renomear a conta Nubank para Nubank Principal.");
    expect((await state()).accounts.some((a) => a.name === "Nubank Principal")).toBe(false);
    const renameRes = await decide(page, renameConfirm);
    expect(renameRes.status()).toBe(200);
    const renameBody = (await renameRes.json()) as { status?: string; receipt?: { mutationKind?: string; entity?: { id?: string } } };
    expect(renameBody.status).toBe("succeeded");
    expect(renameBody.receipt?.mutationKind).toBe("accounts.update");
    await expect.poll(async () => (await state()).accounts.some((a) => a.name === "Nubank Principal"), { timeout: 60000 }).toBe(true);
    mark("account-rename", { receipt: renameBody.receipt });
    await persist({ verdict: "IN_PROGRESS" });

    // Journey 3 — description-only transaction update. The expense is created
    // HERE with a description the pilot does NOT use: running both tests in the
    // same stack must not leave two identical expenses (which correctly routes
    // the update turn into disambiguation) and this test must not depend on
    // another test having populated the ledger first.
    await send(page, "Registre uma despesa de R$ 42,00 de Aluguel do escritório, na categoria Aluguel, paga pela conta Itaú, em 07/11/2026.");
    const expenseConfirm = await waitCard("Confirmar despesa", /Confirmar R\$ 42,00/, "Prossiga com a proposta da despesa de R$ 42,00 de Aluguel do escritório.");
    const expenseRes = await decide(page, expenseConfirm);
    expect(expenseRes.status()).toBe(200);
    const expenseBody = (await expenseRes.json()) as { status?: string; receipt?: { mutationKind?: string } };
    expect(expenseBody.status).toBe("succeeded");
    expect(expenseBody.receipt?.mutationKind).toBe("transactions.expense.create");
    const aluguel = (await state()).transactions.find(
      (t) => t.kind === "expense" && t.description?.toLowerCase().includes("aluguel do escritório") && t.amountCents === 4200,
    );
    expect(aluguel, "Aluguel expense created by this journey").toBeTruthy();
    const aluguelId = aluguel!.id;
    await send(page, "Altere a descrição da despesa Aluguel do escritório para Aluguel do escritório novembro.");
    const descConfirm = await waitCard("Alterar descrição do lançamento", /^Confirmar$/, "Prossiga com a proposta de alterar a descrição da despesa Aluguel do escritório para Aluguel do escritório novembro.");
    const descRes = await decide(page, descConfirm);
    expect(descRes.status()).toBe(200);
    const descBody = (await descRes.json()) as { status?: string; receipt?: { mutationKind?: string } };
    expect(descBody.status).toBe("succeeded");
    expect(descBody.receipt?.mutationKind).toBe("transactions.update");
    await expect
      .poll(async () => (await state()).transactions.find((t) => t.id === aluguelId)?.description, { timeout: 60000 })
      .toBe("Aluguel do escritório novembro");
    mark("transaction-description-update", { receipt: descBody.receipt });
    await persist({ verdict: "IN_PROGRESS" });

    // Journey 4 — create an accounts-payable through the conversation.
    await send(page, "Crie uma conta a pagar de R$ 99,00 para Internet, vencendo em 20/11/2026, na conta Itaú.");
    const createConfirm = await waitCard("Criar conta a pagar", /Confirmar R\$ 99,00/, "Prossiga com a proposta de criar a conta a pagar de R$ 99,00 para Internet, vencendo em 20/11/2026, na conta Itaú.");
    const createRes = await decide(page, createConfirm);
    expect(createRes.status()).toBe(200);
    const createBody = (await createRes.json()) as { status?: string; receipt?: { mutationKind?: string; entity?: { id?: string } } };
    expect(createBody.status).toBe("succeeded");
    expect(createBody.receipt?.mutationKind).toBe("payables.create");
    expect(typeof createBody.receipt?.entity?.id).toBe("string");
    mark("payable-create", { receipt: createBody.receipt });
    await persist({ verdict: "IN_PROGRESS" });

    // Journey 5 — pay that payable: exactly one expense, one balance debit.
    const beforePay = await state();
    const itauBalanceBefore = balance(beforePay.accounts, itau!.id)!;
    const txBeforePay = beforePay.transactions.length;
    await send(page, "Pague a conta a pagar Internet de R$ 99,00 usando a conta Itaú.");
    const payConfirm = await waitCard("Pagar conta", /Confirmar R\$ 99,00/, "Prossiga com a proposta de pagar a conta a pagar Internet de R$ 99,00 usando a conta Itaú.");
    const payRes = await decide(page, payConfirm);
    expect(payRes.status()).toBe(200);
    const payBody = (await payRes.json()) as { status?: string; receipt?: { mutationKind?: string; entity?: { id?: string } } };
    expect(payBody.status).toBe("succeeded");
    expect(payBody.receipt?.mutationKind).toBe("payables.pay");
    await expect.poll(async () => (await state()).transactions.length, { timeout: 60000 }).toBe(txBeforePay + 1);
    expect(balance((await state()).accounts, itau!.id)).toBe(itauBalanceBefore - 9900);
    mark("payable-pay", { receipt: payBody.receipt, itauDelta: -9900 });
    await persist({ verdict: "IN_PROGRESS" });

    // Journey 6 — ambiguous date must ask before proposing (issue #280).
    const proposalsBefore = proposalCount(await journal());
    const writesBefore = (await journal()).financialWrites?.length ?? 0;
    await send(page, "Gastei R$ 20 em 15/03.");
    await waitTurnEnd();
    // Authoritative signals: an ambiguous date must NOT create a proposal and
    // must NOT write. The card is only a projection of a proposal, so polling
    // it here raced the history refresh; the journal is the source of truth.
    expect(proposalCount(await journal())).toBe(proposalsBefore);
    expect(((await journal()).financialWrites ?? []).length).toBe(writesBefore);
    mark("ambiguous-date-clarification", { proposalsBefore, proposalsAfter: proposalCount(await journal()) });

    await persist({ verdict: "V1_FUNCTIONAL_REAL_PASS", "V1_FUNCTIONAL_REAL_PASS": "SIM" });
  } catch (err) {
    await persist({ verdict: "FAIL", "V1_FUNCTIONAL_REAL_PASS": "NÃO", error: String((err as Error)?.message || err).slice(0, 400) }).catch(() => {});
    throw err;
  }
});
