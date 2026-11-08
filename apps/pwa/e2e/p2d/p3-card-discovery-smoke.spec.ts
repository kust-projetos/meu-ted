/**
 * P3.8 card discovery smoke (real provider, opt-in only) — focused, no full pilot.
 *
 * Runs ONLY via the P2D live-real stack with P3 writes + card-smoke selection
 * (P2D_LIVE_REAL=1, P2D_P38_CARD_SMOKE=1). The file-level skip keeps every
 * other P2D run unaffected. The financial API/Agent/PWA are the synthetic
 * loopback stack; inference is real (DeepSeek via opencode-go). Never run by CI.
 *
 * Secrecy: never read/log/record credentials. Evidence is structural
 * (routes/counts/statuses/ids) only.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { resolveP2dPorts } from "../support/ports";

const ports = resolveP2dPorts(process.env);
const CTL = `http://127.0.0.1:${ports.ctlPort}`;
const WORKSPACE_ID = "00000000-0000-4000-8000-00000000000a";
const USER_TEXT = "Comprei R$ 120 à vista no Nubank Card em 07/11/2026.";
const CONFIRM_LABEL = /Confirmar R\$ 120,00/;
const CRITERION = "P3_CARD_REAL_SMOKE_PASS";

type Stats = {
  mode?: string;
  profile?: string;
  provider?: string;
  model?: string;
  promptCalls?: number;
  transportCalls?: number;
  financeReads?: Array<{ route?: string; method?: string; statusCode?: number }>;
  financeToolNames?: string[] | null;
  stubMismatches?: string[];
  retryVetoes?: number;
};
type Journal = {
  requests?: Array<{ method?: string; url?: string }>;
  financialWrites?: Array<{ method?: string; url?: string }>;
};
type LedgerTxn = {
  id: string;
  kind: string;
  amountCents: number;
  description: string;
  date: string;
  accountId: string;
};
type LedgerAccount = { id: string; name: string; kind: string; balanceCents: number };

async function ctlGet<T>(pathname: string): Promise<T> {
  const res = await fetch(`${CTL}${pathname}`);
  if (!res.ok) throw new Error(`ctl GET ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}
const ctlStats = () => ctlGet<Stats>("/p2d/stats");
const ctlJournal = () => ctlGet<Journal>("/p2d/journal");
const ctlState = () =>
  ctlGet<{ transactions: LedgerTxn[]; total: number; accounts: LedgerAccount[] }>("/p2d/expense-state");

function readsFor(stats: Stats, routePath: string) {
  return (stats.financeReads ?? []).filter(
    (r) => r.method === "GET" && String(r.route ?? "").split("?")[0] === routePath,
  );
}

function failureEvidence(extra: Record<string, unknown>) {
  const evidence = {
    scope: "p3-card-discovery-smoke",
    criterion: CRITERION,
    pass: false,
    prompt: USER_TEXT,
    ...extra,
  };
  const outDir = path.resolve(process.cwd(), "test-results", "p3-card-discovery-smoke");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "failure-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

async function openTed(page: Page) {
  const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  await expect(launcher).toBeVisible({ timeout: 120000 });
  await launcher.click();
  await page.waitForURL(/\/ted/);
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 300000 });
  await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 300000 });
  return input;
}

test.describe.configure({ mode: "serial" });

test.describe("p3.8 card discovery smoke (real provider, opt-in only)", () => {
  test.skip(
    process.env.P2D_LIVE_REAL !== "1" || process.env.P2D_P38_CARD_SMOKE !== "1",
    "opt-in only: run with P2D_LIVE_REAL=1 P2D_P38_CARD_SMOKE=1",
  );

  test("discovers Nubank Card → proposes R$120 1x → approval writes one November purchase", async ({ page }, testInfo) => {
    test.setTimeout(900000);
    let lastStats: Stats = {};

    try {
      const health = await ctlGet<{ ok: boolean; probeRunning: boolean; agentRunning: boolean }>("/health");
      expect(health.ok).toBe(true);
      expect(health.probeRunning).toBe(true);
      expect(health.agentRunning).toBe(true);

      const baseline = await ctlStats();
      expect(baseline.mode).toBe("live-real");
      expect(baseline.profile).toBe("live");
      expect(baseline.promptCalls ?? 0).toBe(0);

      const initialState = await ctlState();
      const card = initialState.accounts.find((a) => a.kind === "credit_card" && a.name === "Nubank Card");
      expect(card, "synthetic ledger must expose the Nubank Card").toBeTruthy();
      expect(
        initialState.transactions.filter((t) => t.kind === "expense" && t.accountId === card!.id && t.amountCents === 12000),
      ).toHaveLength(0);
      const journalBefore = await ctlJournal();
      const journalBaseLen = (journalBefore.requests ?? []).length;

      // Synthetic user, real Better-Auth login through the UI.
      const email = "ted-p38-card-smoke@example.test";
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
      const signupStatus = await page.evaluate(async (userEmail) => {
        const res = await fetch("/api/backend/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P3.8 Smoke" }),
        });
        return res.status;
      }, email);
      expect(signupStatus).toBe(200);
      await page.locator("#email").fill(email);
      await page.locator("#password").fill("test-password-123");
      await page.getByRole("button", { name: "Entrar" }).click();

      // Send the exact prompt to the real model.
      const input = await openTed(page);
      await input.fill(USER_TEXT);
      await page.getByRole("button", { name: /enviar mensagem/i }).click();

      // Wait for an approval card (model must produce a proposal intent).
      const confirmButton = page.getByRole("button", { name: CONFIRM_LABEL });
      await expect(confirmButton).toBeVisible({ timeout: 300000 });

      lastStats = await ctlStats();
      const cardReads = readsFor(lastStats, "/cards/accounts");
      expect(
        cardReads.length,
        "model must call list_credit_cards (GET /cards/accounts)",
      ).toBeGreaterThanOrEqual(1);
      expect(
        cardReads.every((r) => r.statusCode === 200),
        "list_credit_cards read must return 200 (Nubank Card present)",
      ).toBe(true);

      // No purchase registered before approval.
      const beforeApproval = (await ctlState()).transactions.filter(
        (t) => t.kind === "expense" && t.accountId === card!.id && t.amountCents === 12000,
      );
      expect(beforeApproval, "no R$120 purchase before approval").toHaveLength(0);

      // Approval card shows R$120 and 1x (proves propose_card_purchase args).
      const approvalCard = page
        .locator('div[id^="ted-op-"]')
        .filter({ hasText: "Confirmar compra no cartão" })
        .first();
      await expect(approvalCard.getByText("R$ 120,00", { exact: true })).toBeVisible({ timeout: 60000 });
      await expect(approvalCard.getByText("1x", { exact: true })).toBeVisible({ timeout: 60000 });
      await expect(approvalCard.getByText(/Nubank/i).first()).toBeVisible({ timeout: 60000 });

      // Approve through the PWA card.
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

      await expect
        .poll(
          async () =>
            (await ctlState()).transactions.filter(
              (t) => t.kind === "expense" && t.accountId === card!.id && t.amountCents === 12000,
            ).length,
          { timeout: 120000 },
        )
        .toBe(1);

      const after = await ctlState();
      const purchase = after.transactions.find(
        (t) => t.kind === "expense" && t.accountId === card!.id && t.amountCents === 12000,
      )!;
      expect(purchase).toBeTruthy();
      expect(purchase.accountId).toBe(card!.id); // UUID correto (Nubank Card)
      expect(purchase.amountCents).toBe(12000);
      expect(decisionBody.receipt?.entity?.id).toBe(purchase.id);

      // Exactly one purchase in the November statement (2026-11, from 07/11/2026).
      const statements = await page.evaluate(
        async ({ accountId, workspaceId }) => {
          const response = await fetch(`/api/backend/cards/statements?accountId=${accountId}`, {
            credentials: "include",
            headers: { "X-Workspace-Id": workspaceId },
          });
          return { status: response.status, body: (await response.json().catch(() => null)) as
            | { items?: Array<{ id?: string; cycleYearMonth?: string; totalCents?: number }> }
            | null };
        },
        { accountId: card!.id, workspaceId: WORKSPACE_ID },
      );
      expect(statements.status).toBe(200);
      const november = (statements.body?.items ?? []).find((s) => s.cycleYearMonth === "2026-11");
      expect(november, "November 2026 statement must exist").toBeTruthy();

      const detail = await page.evaluate(
        async ({ statementId, workspaceId }) => {
          const response = await fetch(`/api/backend/cards/statements/${statementId}`, {
            credentials: "include",
            headers: { "X-Workspace-Id": workspaceId },
          });
          return { status: response.status, body: (await response.json().catch(() => null)) as
            | { purchases?: Array<{ id?: string; amountCents?: number }> }
            | null };
        },
        { statementId: november!.id!, workspaceId: WORKSPACE_ID },
      );
      expect(detail.status).toBe(200);
      const purchases120 = (detail.body?.purchases ?? []).filter((p) => p.amountCents === 12000);
      expect(purchases120).toHaveLength(1);

      const journal = await ctlJournal();
      const delta = (journal.requests ?? []).slice(journalBaseLen);
      expect((journal.financialWrites ?? []).length).toBe(0);
      expect(delta.filter((r) => r.method === "POST" && /^\/pending-operations\/v2\/propose/.test(String(r.url ?? ""))).length).toBeGreaterThanOrEqual(1);

      const evidence = {
        scope: "p3-card-discovery-smoke",
        criterion: CRITERION,
        pass: true,
        prompt: USER_TEXT,
        modelCalledListCreditCards: cardReads.length >= 1,
        listCreditCardsRoutes: cardReads.map((r) => r.route),
        listCreditCardsStatuses: cardReads.map((r) => r.statusCode),
        nubankCardId: card!.id,
        proposeCardPurchase: { accountId: card!.id, amountCents: 12000, installmentsTotal: 1 },
        purchaseRegisteredBeforeApproval: 0,
        purchasesInNovember: purchases120.length,
        novemberStatementId: november!.id,
        transactionId: purchase.id,
        financialWrites: (journal.financialWrites ?? []).length,
        promptCalls: lastStats.promptCalls ?? 0,
        transportCalls: lastStats.transportCalls ?? 0,
        financeReads: lastStats.financeReads ?? [],
      };
      const serialized = JSON.stringify(evidence, null, 2);
      expect(serialized).not.toMatch(/cookie|token|secret|password|bearer|authorization/i);
      const outDir = path.resolve(process.cwd(), "test-results", "p3-card-discovery-smoke");
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, "evidence.json");
      fs.writeFileSync(outPath, `${serialized}\n`, "utf8");
      await testInfo.attach("p3-card-discovery-smoke-evidence", { path: outPath, contentType: "application/json" });
    } catch (err) {
      let stats: Stats = lastStats;
      let journal: Journal = {};
      try {
        stats = await ctlStats();
      } catch {
        /* keep last */
      }
      try {
        journal = await ctlJournal();
      } catch {
        /* best effort */
      }
      failureEvidence({
        error: String((err as Error)?.message || err).slice(0, 500),
        stats: {
          promptCalls: stats.promptCalls,
          transportCalls: stats.transportCalls,
          financeReads: stats.financeReads ?? [],
          financeToolNames: stats.financeToolNames ?? null,
        },
        journalRequests: (journal.requests ?? []).slice(-20),
        financialWrites: journal.financialWrites ?? [],
      });
      throw err;
    }
  });
});
