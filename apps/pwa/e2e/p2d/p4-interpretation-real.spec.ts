import { test, expect, type Page } from "@playwright/test";
import { resolveP2dPorts } from "../support/ports";

const ports = resolveP2dPorts(process.env);
const CTL = `http://127.0.0.1:${ports.ctlPort}`;
const PROMPTS = [
  { text: "Recebi 3200 de décimo", tool: "transactions.income.create", amountCents: 320000, description: /décimo|13º/i, category: "income" },
  { text: "Gastei 45 no Uber", tool: "transactions.expense.create", amountCents: 4500, description: /uber/i, category: "transport" },
  { text: "Recebi 900 de cashback", tool: "transactions.income.create", amountCents: 90000, description: /cashback/i },
  { text: "Paguei 150 de luz ontem", tool: "transactions.expense.create", amountCents: 15000, description: /luz/i, yesterday: true },
];
const SALARY_CATEGORY = "22222222-2222-4222-8222-222222222223";
const FOOD_CATEGORY = "22222222-2222-4222-8222-222222222221";
const CLARIFICATION_ANSWER = "Pode usar a conta Itaú. Para a categoria, use a existente mais adequada; não precisa criar nova.";

test.describe.configure({ mode: "serial" });
test.skip(process.env.P2D_LIVE_REAL !== "1" || process.env.P2D_FINANCE_INTERPRETATION_REAL !== "1", "requires explicit live-real interpretation opt-in");

type Args = { amountCents?: number; description?: string; categoryId?: string; date?: string };
type Proposal = { tool: string; normalizedArgs: Args };
type Journal = { financialWrites?: Array<{ method?: string; url?: string }> };
type State = { transactions: Array<{ id: string }> };
type Stats = { promptCalls?: number; transportCalls?: number };
async function ctl<T>(route: string): Promise<T> {
  const response = await fetch(`${CTL}${route}`);
  if (!response.ok) throw new Error(`P2D control request failed (${response.status})`);
  return response.json() as Promise<T>;
}
async function openTed(page: Page, baseURL?: string) {
  await page.goto(baseURL || `http://127.0.0.1:${ports.nextPort}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
  const email = "ted-p2d-interpretation-real@example.test";
  const status = await page.evaluate(async (userEmail) => (await fetch("/api/backend/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P2D Interpretation" }),
  })).status, email);
  expect([200, 422]).toContain(status);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("test-password-123");
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByRole("button", { name: /abrir assistente ted/i }).last().click();
  await page.waitForURL(/\/ted/);
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 120000 });
  await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 300000 });
  return input;
}

test("live-real: interprets four financial messages without executing proposals", async ({ page }, testInfo) => {
  test.setTimeout(1500000);
  const baseline = await ctl<State>("/p2d/expense-state");
  const initialIds = new Set(baseline.transactions.map((tx) => tx.id));
  const beforeStats = await ctl<Stats>("/p2d/stats");
  const proposals: Proposal[] = [];
  const requestListener = (request: import("@playwright/test").Request) => {
    if (request.method() !== "POST" || !request.url().includes("/pending-operations/v2/propose")) return;
    const raw = request.postData();
    if (!raw) return;
    try {
      const body = JSON.parse(raw) as Proposal;
      if (body.tool && body.normalizedArgs) proposals.push(body);
    } catch { /* ignore unrelated/malformed request bodies */ }
  };
  page.on("request", requestListener);
  const baseURL = typeof testInfo.project.use.baseURL === "string" ? testInfo.project.use.baseURL : undefined;
  const input = await openTed(page, baseURL);
  const evidence: Array<Record<string, unknown>> = [];
  for (const [index, expected] of PROMPTS.entries()) {
    const beforeCount = proposals.length;
    const assistantMessages = page.getByText("TED", { exact: true }).locator("xpath=../../..");
    const assistantMessageCount = await assistantMessages.count();
    await input.fill(expected.text);
    const send = page.getByRole("button", { name: /enviar mensagem/i });
    await expect(send).toBeEnabled({ timeout: 120000 });
    await send.click();
    await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 300000 });
    const clarificationPattern = /confirmar|qual conta|Itaú|Nubank|categoria|prefere/i;
    const clarificationAnswered = (await assistantMessages.allTextContents())
      .slice(assistantMessageCount)
      .some((content) => clarificationPattern.test(content));
    if (clarificationAnswered) {
      await input.fill(CLARIFICATION_ANSWER);
      await expect(send).toBeEnabled({ timeout: 120000 });
      await send.click();
      await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 300000 });
    }
    await expect.poll(() => proposals.length, { timeout: 300000 }).toBeGreaterThanOrEqual(beforeCount + 1);
    const newProposals = proposals.slice(beforeCount);
    const proposalToolsSeen = newProposals.map(({ tool }) => tool);
    const proposal = newProposals.find(({ tool }) => tool === expected.tool);
    expect(
      proposal,
      `expected proposal tool ${expected.tool}; tools seen: ${proposalToolsSeen.join(", ") || "(none)"}`,
    ).toBeTruthy();
    const selectedProposal = proposal!;
    const args = selectedProposal.normalizedArgs;
    expect(selectedProposal.tool).toBe(expected.tool);
    expect(args.amountCents).toBe(expected.amountCents);
    expect(args.description).toMatch(expected.description);
    if (expected.category === "income" && args.categoryId) expect(args.categoryId).toBe(SALARY_CATEGORY);
    if (expected.category === "transport" && args.categoryId) expect(args.categoryId).not.toBe(FOOD_CATEGORY);
    let observedYesterdayDate: string | undefined;
    if (expected.yesterday) {
      const now = new Date();
      const utcYesterdayDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
        .toISOString().slice(0, 10);
      const saoPauloToday = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now).reduce<Record<string, string>>((parts, part) => {
        if (part.type !== "literal") parts[part.type] = part.value;
        return parts;
      }, {});
      const saoPauloYesterdayDate = new Date(Date.UTC(
        Number(saoPauloToday.year),
        Number(saoPauloToday.month) - 1,
        Number(saoPauloToday.day) - 1,
      )).toISOString().slice(0, 10);
      expect([utcYesterdayDate, saoPauloYesterdayDate]).toContain(args.date);
      observedYesterdayDate = args.date;
    }
    evidence.push({ tool: selectedProposal.tool, proposalToolsSeen, amountCents: args.amountCents, description: args.description,
      clarificationAnswered, clarificationResponse: clarificationAnswered ? CLARIFICATION_ANSWER : null,
      categoryId: args.categoryId ?? "NOT_OBSERVED", date: args.date ?? null,
      ...(observedYesterdayDate ? { observedYesterdayDate } : {}),
      ...(index === 0 ? { categoryResolution: args.categoryId ? "OBSERVED" : "NOT_OBSERVED" } : {}) });
  }
  page.off("request", requestListener);
  const finalJournal = await ctl<Journal>("/p2d/journal");
  expect(finalJournal.financialWrites ?? []).toHaveLength(0);
  const finalState = await ctl<State>("/p2d/expense-state");
  expect(finalState.transactions.filter((tx) => !initialIds.has(tx.id))).toHaveLength(0);
  const finalStats = await ctl<Stats>("/p2d/stats");
  expect((finalStats.promptCalls ?? 0)).toBeGreaterThanOrEqual((beforeStats.promptCalls ?? 0) + 4);
  await testInfo.attach("p4-financial-interpretation-evidence", {
    body: Buffer.from(JSON.stringify({ proposals: evidence, financialWrites: 0, newTransactions: 0,
      promptCalls: finalStats.promptCalls ?? 0, transportCalls: finalStats.transportCalls ?? 0 }, null, 2)),
    contentType: "application/json",
  });
});
