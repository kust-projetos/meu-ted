/**
 * Live-real correction with an explicit account avoids a clarification turn;
 * the pending expense must reflect the corrected amount and execute exactly once.
 */
import { test, expect, type Page } from "@playwright/test";
import { resolveP2dPorts } from "../support/ports";

const ports = resolveP2dPorts(process.env);
const CTL = `http://127.0.0.1:${ports.ctlPort}`;
const USER_TEXT = "Gastei R$ 50,00 no mercado ontem no Nubank.";
const CORRECTION_TEXT = "Na verdade, foram R$ 55,00.";
const CONFIRM_LABEL = /Confirmar R\$ 55,00/;

test.describe.configure({ mode: "serial" });
test.skip(
  process.env.P2D_LIVE_REAL !== "1" || process.env.P2D_CATEGORY_CORRECTION_REAL !== "1",
  "requires explicit P2D live-real category-correction opt-in",
);

type Tx = { id: string; kind: string; amountCents: number; description: string };
type State = { transactions: Tx[]; total: number };
type Journal = { requests?: Array<{ method?: string; url?: string }> };
type Stats = { promptCalls?: number; financeToolNames?: string[] | null };
type Decision = { status?: string; receipt?: { mutationKind?: string; status?: string } };

async function ctlGet<T>(pathname: string): Promise<T> {
  const response = await fetch(`${CTL}${pathname}`);
  if (!response.ok) throw new Error(`ctl GET ${pathname} -> ${response.status}`);
  return (await response.json()) as T;
}

const expenseState = () => ctlGet<State>("/p2d/expense-state");
const journal = () => ctlGet<Journal>("/p2d/journal");
const stats = () => ctlGet<Stats>("/p2d/stats");
const matchingExpenses = (state: State) =>
  state.transactions.filter((tx) => tx.kind === "expense" && tx.amountCents === 5500);
const executionPosts = (value: Journal) =>
  (value.requests ?? []).filter(
    (request) =>
      request.method === "POST" &&
      /^\/pending-operations\/v2\/[^/]+\/execute(?:\?|$)/.test(String(request.url ?? "")),
  );

async function gotoWithStartupRetry(page: Page, url: string, projectBaseURL?: string) {
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

async function openTed(page: Page, projectBaseURL?: string) {
  await gotoWithStartupRetry(page, "/", projectBaseURL);
  await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
  const email = "ted-p2d-category-correction-real@example.test";
  const signupStatus = await page.evaluate(async (userEmail) =>
    (await fetch("/api/backend/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P2D Category Correction" }),
    })).status, email);
  expect([200, 422]).toContain(signupStatus);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("test-password-123");
  await page.getByRole("button", { name: "Entrar" }).click();
  const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  await expect(launcher).toBeVisible({ timeout: 120000 });
  await launcher.click();
  await page.waitForURL(/\/ted/);
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 120000 });
  await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 300000 });
  return input;
}

test("live-real: correct expense amount before confirmation without creating a category", async ({ page }, testInfo) => {
  test.setTimeout(900000);

  expect(await ctlGet<{ ok: boolean; probeRunning: boolean }>("/health")).toMatchObject({
    ok: true,
    probeRunning: true,
  });
  const initial = await expenseState();
  const initialIds = new Set(initial.transactions.map((tx) => tx.id));
  const initialPromptCalls = (await stats()).promptCalls ?? 0;
  const proposalBodies: string[] = [];
  const proposalListener = (request: import("@playwright/test").Request) => {
    if (request.method() === "POST" && request.url().includes("/pending-operations/v2/propose")) {
      proposalBodies.push(request.postData() ?? "");
    }
  };
  page.on("request", proposalListener);
  const projectBaseURL = typeof testInfo.project.use.baseURL === "string" ? testInfo.project.use.baseURL : undefined;
  const input = await openTed(page, projectBaseURL);
  const sendButton = page.getByRole("button", { name: /enviar mensagem/i });

  await input.fill(USER_TEXT);
  await expect(sendButton).toBeEnabled({ timeout: 120000 });
  await sendButton.click();
  await expect(page.getByRole("button", { name: /Confirmar R\$ 50,00/ }).last()).toBeVisible({ timeout: 300000 });

  await input.fill(CORRECTION_TEXT);
  await expect(sendButton).toBeEnabled({ timeout: 120000 });
  await sendButton.click();
  await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 300000 });
  const confirm = page.getByRole("button", { name: CONFIRM_LABEL }).last();
  await expect(confirm).toBeVisible({ timeout: 300000 });

  const decisionResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/rpc\/pending-operations\/[^/]+\/decision$/.test(new URL(response.url()).pathname),
    { timeout: 180000 },
  );
  await confirm.click();
  const decisionResponse = await decisionResponsePromise;
  expect(decisionResponse.status()).toBe(200);
  const decisionUrl = new URL(decisionResponse.url()).pathname;
  const decisionBody = decisionResponse.request().postData();
  expect(decisionBody).toBeTruthy();
  const decision = (await decisionResponse.json()) as Decision;
  expect(decision.status).toBe("succeeded");
  expect(decision.receipt?.mutationKind).toBe("transactions.expense.create");
  expect(decision.receipt?.status).toBe("succeeded");

  await expect.poll(async () => matchingExpenses(await expenseState()).length, { timeout: 120000 }).toBe(1);
  const afterFirst = await expenseState();
  const launched = matchingExpenses(afterFirst);
  expect(launched).toHaveLength(1);
  expect(launched[0]?.description.toLowerCase()).toContain("mercado");
  expect(afterFirst.transactions.filter((tx) => !initialIds.has(tx.id))).toHaveLength(1);
  const firstJournal = await journal();
  expect(executionPosts(firstJournal)).toHaveLength(1);
  expect(proposalBodies.join("\n")).not.toMatch(/propose_category_create|categories\.create/i);
  expect((firstJournal.requests ?? []).filter((request) =>
    request.method === "POST" && /^\/categories(?:\/|$|\?)/.test(String(request.url ?? "")),
  )).toHaveLength(0);

  const replay = await page.evaluate(async ({ pathname, body }) => {
    const deviceToken = localStorage.getItem("pi-finance:token");
    if (!deviceToken) throw new Error("Cannot replay decision without persisted device token");
    const response = await fetch(pathname, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-device-token": deviceToken },
      body,
    });
    return { status: response.status };
  }, { pathname: decisionUrl, body: decisionBody! });
  expect([200, 409]).toContain(replay.status);
  await expect.poll(async () => matchingExpenses(await expenseState()).length, { timeout: 60000 }).toBe(1);
  expect(executionPosts(await journal())).toHaveLength(1);
  page.off("request", proposalListener);

  const finalStats = await stats();
  expect(finalStats.promptCalls ?? 0).toBeGreaterThanOrEqual(initialPromptCalls + 2);
  await testInfo.attach("p5-category-correction-evidence", {
    body: Buffer.from(JSON.stringify({
      routes: { decision: decisionUrl, ledger: "/p2d/expense-state", journal: "/p2d/journal" },
      decisionStatus: decisionResponse.status(),
      decisionOutcome: decision.status,
      mutationKind: decision.receipt?.mutationKind,
      receiptStatus: decision.receipt?.status,
      transactionIds: launched.map((tx) => tx.id),
      expenseCount: matchingExpenses(afterFirst).length,
      amountCents: launched[0]?.amountCents,
      executionPosts: executionPosts(firstJournal).length,
      categoryCreateProposalRequests: proposalBodies.filter((body) => /propose_category_create|categories\.create/i.test(body)).length,
      replayStatus: replay.status,
      finalExpenseCount: matchingExpenses(await expenseState()).length,
      finalExecutionPosts: executionPosts(await journal()).length,
      promptCalls: finalStats.promptCalls ?? 0,
    }, null, 2)),
    contentType: "application/json",
  });
});
