/** One authenticated P3 journey against a local scripted provider; not model-quality evidence. */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { resolveP2dPorts } from "../support/ports";

const CTL = `http://127.0.0.1:${resolveP2dPorts(process.env).ctlPort}`;
const turns = [
  ["Gastei R$ 65 no almoço pela conta Itaú.", /Confirmar R\$ 65,00/, "transactions.expense.create"],
  ["Recebi R$ 800 na conta Itaú.", /Confirmar R\$ 800,00/, "transactions.income.create"],
  ["Transfira R$ 150 do Itaú para o Neon.", /Confirmar R\$ 150,00/, "transactions.transfer.create"],
  ["Comprei R$ 120 no Nubank, à vista.", /Confirmar R\$ 120,00/, "cards.purchase.create"],
  ["Comprei R$ 600 em 3x no Nubank.", /Confirmar R\$ 600,00/, "cards.purchase.create"],
  ["Pague R$ 300 da fatura do Nubank usando o Itaú.", /Confirmar R\$ 300,00/, "cards.statement.pay"],
  ["Agora quite o restante dessa fatura com a mesma conta.", /Confirmar R\$ 20,00/, "cards.statement.pay"],
] as const;
type Tx = { id: string; kind: string; amountCents: number; description: string; date: string; accountId: string; transferToAccountId?: string; statementPaymentId?: string };
type State = { transactions: Tx[]; accounts: Array<{ id: string; name: string; kind: string; balanceCents: number }> };
type Statement = { id: string; accountId: string; cycleYearMonth: string; totalCents: number; paidCents: number; status: string };
async function ctl<T>(route: string): Promise<T> { const r = await fetch(`${CTL}${route}`); if (!r.ok) throw Error(`ctl ${route}: ${r.status}`); return r.json() as Promise<T>; }
const state = () => ctl<State>("/p2d/expense-state");
const statements = () => ctl<{ statements: Statement[]; cardBalanceCents: number }>("/p2d/statement-state");
const journal = () => ctl<{ requests: Array<{ method: string; url: string }>; financialWrites: Array<{ method: string; url: string }> }>("/p2d/journal");
const stats = () => ctl<{ promptCalls: number; stubTurns: number; stubMismatches: string[] }>("/p2d/stats");
const countPath = (j: Awaited<ReturnType<typeof journal>>, re: RegExp) => j.requests.filter(x => x.method === "POST" && re.test(x.url)).length;
async function openTed(page: Page) {
  const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  await expect(launcher).toBeVisible({ timeout: 120000 }); await launcher.click(); await page.waitForURL(/\/ted/);
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 300000 }); await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 300000 }); return input;
}
async function send(page: Page, text: string) { const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…"); await input.fill(text); await page.getByRole("button", { name: /enviar mensagem/i }).click(); }
async function decide(page: Page, button: ReturnType<Page["getByRole"]>) {
  const response = page.waitForResponse(r => r.request().method() === "POST" && /\/rpc\/pending-operations\/[^/]+\/decision$/.test(new URL(r.url()).pathname), { timeout: 180000 });
  await button.click(); return response;
}

test("integrated P3 journey: seven confirmed turns, recovery and context", async ({ page }, info) => {
  test.setTimeout(1_800_000);
  expect(await ctl<{ ok: boolean; agentRunning: boolean; probeRunning: boolean }>("/health")).toMatchObject({ ok: true, agentRunning: true, probeRunning: true });
  const initial = await state();
  const a1 = initial.accounts.find(a => a.name === "Itaú")!; const a2 = initial.accounts.find(a => a.name === "Nubank")!;
  const card = initial.accounts.find(a => a.kind === "credit_card")!;
  const initialA1 = a1.balanceCents; const initialA2 = a2.balanceCents; const initialDebt = card.balanceCents;
  const initialCount = initial.transactions.length;
  await page.goto("/"); await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
  const email = "ted-p3-integrated@example.test";
  expect(await page.evaluate(async e => (await fetch("/api/backend/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: "test-password-123", name: "TED P3 Pilot" }) })).status, email)).toBe(200);
  await page.locator("#email").fill(email); await page.locator("#password").fill("test-password-123"); await page.getByRole("button", { name: "Entrar" }).click(); await openTed(page);
  const approved: Array<{ index: number; receipt?: string }> = [];
  for (let i = 0; i < turns.length; i++) {
    const [text, label, mutation] = turns[i]!; const before = await state(); const beforeJournal = await journal();
    await send(page, text); const confirm = page.getByRole("button", { name: label }); await expect(confirm).toBeVisible({ timeout: 300000 });
    const proposed = await state(); expect(proposed.transactions).toHaveLength(before.transactions.length);
    expect((await journal()).financialWrites).toHaveLength(beforeJournal.financialWrites.length);
    const decision = await decide(page, confirm); expect(decision.status()).toBe(200);
    const body = await decision.json() as { status?: string; receipt?: { mutationKind?: string; entity?: { id?: string } } };
    expect(body.status).toBe("succeeded"); expect(body.receipt?.mutationKind).toBe(mutation);
    await expect.poll(async () => (await state()).transactions.length, { timeout: 120000 }).toBe(before.transactions.length + (i === 4 ? 3 : 1));
    approved.push({ index: i, receipt: body.receipt?.entity?.id });
    if (i === 4) {
      const current = await state(); const parcels = current.transactions.filter(t => t.accountId === card.id && t.date >= "2026-11-07" && t.description === "compra parcelada").sort((x,y)=>x.date.localeCompare(y.date));
      expect(parcels.map(t => [t.amountCents,t.date])).toEqual([[20000,"2026-11-07"],[20000,"2026-12-07"],[20000,"2027-01-07"]]);
      expect(body.receipt?.entity?.id).toBe(parcels[0]!.id);
      expect(current.accounts.find(a=>a.id===card.id)!.balanceCents).toBe(initialDebt+72000);
      expect(current.accounts.find(a=>a.id===a1.id)!.balanceCents).toBe(initialA1+80000-6500-15000);
    }
    if (i === 5 || i === 6) {
      const current = await state(); const ss = await statements(); const nov = ss.statements.find(s=>s.cycleYearMonth==="2026-11")!;
      expect(nov.totalCents).toBe(32000); expect(nov.paidCents).toBe(i===5?30000:32000);
      expect(nov.status).toBe(i===5?"partial":"paid");
      expect(current.accounts.find(a=>a.id===a1.id)!.balanceCents).toBe(initialA1+80000-6500-15000-(i===5?30000:32000));
      expect(ss.cardBalanceCents).toBe(initialDebt+72000-(i===5?30000:32000));
      const payments=current.transactions.filter(t=>t.statementPaymentId===nov.id); expect(payments.map(t=>t.amountCents).sort((x,y)=>x-y)).toEqual(i===5?[30000]:[2000,30000]);
    }
  }
  const summary = await page.evaluate(async () => {
    const get = async (basis: string) => { const r=await fetch(`/api/backend/dashboard/month-summary?yearMonth=2026-11${basis?`&basis=${basis}`:""}`,{credentials:"include",headers:{"X-Workspace-Id":"00000000-0000-4000-8000-00000000000a"}}); return {status:r.status,body:await r.json() as Record<string,unknown>}; };
    return { liquidity: await get(""), competence: await get("competencia") };
  });
  expect(summary.liquidity.status).toBe(200); expect(summary.competence.status).toBe(200);
  const expenseValue = (x: Record<string,unknown>) => Number(x.expenseCents ?? (x.summary as Record<string,unknown>|undefined)?.expenseCents);
  expect(expenseValue(summary.competence.body)).toBe(38500); expect(expenseValue(summary.liquidity.body)).toBe(70500);
  await send(page,"Quanto falta pagar dessa fatura?"); await expect(page.getByText(/quitada|restante.*0|0.*restante/i)).toBeVisible({timeout:120000});
  await send(page,"Qual conta usei para pagar?"); await expect(page.getByText(/Itaú/).last()).toBeVisible({timeout:120000});
  await expect(page.getByRole("button",{name:/Confirmar/})).toHaveCount(0);
  await send(page,"despesa extra"); const extra=page.getByRole("button",{name:/Confirmar R\$ 1\.000,00/}); await expect(extra).toBeVisible({timeout:300000});
  expect((await state()).transactions.filter(t=>t.description==="piloto extra")).toHaveLength(0);
  const promptsBeforeReload=(await stats()).promptCalls;
  await page.reload({waitUntil:"domcontentloaded"}); await expect(page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…")).toBeVisible({timeout:300000});
  await expect(page.getByRole("button",{name:/Confirmar R\$ 1\.000,00/})).toBeVisible({timeout:300000}); expect((await stats()).promptCalls).toBe(promptsBeforeReload);
  const cancelled=await decide(page,page.getByRole("button",{name:"Cancelar"})); expect(cancelled.status()).toBe(200); expect((await cancelled.json()).status).toBe("cancelled");
  expect((await state()).transactions.filter(t=>t.description==="piloto extra")).toHaveLength(0);
  const beforeGeneric=await journal(); await send(page,"Pague a fatura"); await expect(page.getByText(/qual fatura e período/i)).toBeVisible({timeout:120000});
  await expect(page.getByRole("button",{name:/Confirmar/})).toHaveCount(0); expect(countPath(await journal(),/^\/pending-operations\/v2\/propose$/)).toBe(countPath(beforeGeneric,/^\/pending-operations\/v2\/propose$/));
  const finalState=await state(); const finalStatements=await statements(); const nov=finalStatements.statements.find(s=>s.cycleYearMonth==="2026-11")!;
  expect(finalState.accounts.find(a=>a.id===a1.id)!.balanceCents).toBe(initialA1+80000-6500-15000-32000);
  expect(finalState.accounts.find(a=>a.id===a2.id)!.balanceCents).toBe(initialA2+15000);
  expect(finalStatements.cardBalanceCents).toBe(initialDebt+72000-32000);
  const finalJournal=await journal(); const proposes=countPath(finalJournal,/^\/pending-operations\/v2\/propose$/); const confirms=countPath(finalJournal,/^\/pending-operations\/v2\/[^/]+\/confirm$/); const executes=countPath(finalJournal,/^\/pending-operations\/v2\/[^/]+\/execute$/); const cancels=countPath(finalJournal,/^\/pending-operations\/v2\/[^/]+\/(cancel|reject)$/);
  expect(proposes).toBeGreaterThanOrEqual(8); expect([confirms,executes,cancels]).toEqual([7,7,1]); const directFinancialWrites=finalJournal.financialWrites.filter(w=>/^\/(transactions\/|transfers|cards\/purchases|cards\/.*\/pay)/.test(w.url)); expect(directFinancialWrites).toHaveLength(0);
  expect(finalState.transactions.filter(t=>t.description==="piloto extra")).toHaveLength(0);
  const finalStats=await stats(); expect(finalStats.stubMismatches).toEqual([]);
  const evidence={scope:"p3-integrated-pilot",provider:"local-scripted-only",modelQualityProven:false,balancesCents:{a1:finalState.accounts.find(a=>a.id===a1.id)?.balanceCents,a2:finalState.accounts.find(a=>a.id===a2.id)?.balanceCents,cardDebt:finalStatements.cardBalanceCents},statement:{novemberTotalCents:nov.totalCents,paidCents:nov.paidCents,remainingCents:nov.totalCents-nov.paidCents,status:nov.status},installments:finalState.transactions.filter(t=>t.description==="compra parcelada").map(t=>({amountCents:t.amountCents,date:t.date})),monthSummary:{liquidityExpenseCents:expenseValue(summary.liquidity.body),competenceExpenseCents:expenseValue(summary.competence.body)},journal:{proposes,confirms,executes,cancels,directFinancialWrites:directFinancialWrites.length},stubMismatches:finalStats.stubMismatches,promptCalls:finalStats.promptCalls,stubTurns:finalStats.stubTurns,confirmedTurns:approved.length,initialLedgerRows:initialCount,observedLedgerRows:finalState.transactions.length};
  const output=path.resolve(process.cwd(),"test-results","p3-integrated","evidence.json"); fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,`${JSON.stringify(evidence,null,2)}\n`); await info.attach("p3-integrated-evidence",{path:output,contentType:"application/json"});
});
