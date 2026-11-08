/**
 * Narrow opt-in real-model P3 pilot: one expense proposal (without approval)
 * and one contextual question. This is NOT proof of all six P3 flows.
 * Structural evidence only; never reads or records a credential.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { resolveP2dPorts } from "../support/ports";

const CTL = `http://127.0.0.1:${resolveP2dPorts(process.env).ctlPort}`;
test.skip(process.env.P2D_LIVE_REAL !== "1" || process.env.P2D_P3_PILOT !== "1", "requires explicit P2D live-real P3 pilot opt-in");

async function ctl<T>(route: string): Promise<T> {
  const response = await fetch(`${CTL}${route}`);
  if (!response.ok) throw new Error(`control ${route}: ${response.status}`);
  return response.json() as Promise<T>;
}

async function openTed(page: Page) {
  await page.goto("/");
  await expect(page.locator("#email")).toBeVisible({ timeout: 120000 });
  const email = "ted-p3-real-pilot@example.test";
  const status = await page.evaluate(async (userEmail) => (await fetch("/api/backend/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: userEmail, password: "test-password-123", name: "TED P3 real pilot" }),
  })).status, email);
  expect(status).toBe(200);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("test-password-123");
  await page.getByRole("button", { name: "Entrar" }).click();
  const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  await expect(launcher).toBeVisible({ timeout: 120000 });
  await launcher.click();
  const input = page.getByPlaceholder("Pergunte sobre gastos, metas ou pagamentos…");
  await expect(input).toBeVisible({ timeout: 120000 });
  await expect(page.getByText("conectando.", { exact: false })).toHaveCount(0, { timeout: 120000 });
  return input;
}

test("real model chooses an expense proposal and retains conversational context", async ({ page }, info) => {
  test.setTimeout(600000);
  expect(await ctl("/health")).toMatchObject({ ok: true, agentRunning: true, probeRunning: true });
  const baseline = await ctl<{ promptCalls: number; transportCalls: number }>("/p2d/stats");
  const journalBefore = await ctl<{ requests: unknown[]; financialWrites: unknown[] }>("/p2d/journal");
  const input = await openTed(page);

  await input.fill("Registre uma despesa de R$ 65,00 no mercado na conta Itaú em 07/11/2026.");
  await page.getByRole("button", { name: /enviar mensagem/i }).click();
  await expect(page.getByRole("button", { name: /Confirmar R\$ 65,00/ })).toBeVisible({ timeout: 300000 });
  expect(await ctl("/p2d/journal")).toMatchObject({ financialWrites: [] });

  await input.fill("Qual conta usei para essa despesa?");
  await page.getByRole("button", { name: /enviar mensagem/i }).click();
  await expect(page.getByText(/Itaú/i).last()).toBeVisible({ timeout: 300000 });
  await expect(page.getByRole("button", { name: /Confirmar/ })).toHaveCount(1);

  await expect.poll(async () => (await ctl<{ promptCalls: number }>("/p2d/stats")).promptCalls - baseline.promptCalls, { timeout: 300000 }).toBe(2);
  const stats = await ctl<{ promptCalls: number; transportCalls: number; financeReads?: Array<{ method?: string; route?: string }> }>("/p2d/stats");
  expect(stats.transportCalls).toBeGreaterThan(baseline.transportCalls);
  expect((stats.financeReads ?? []).every((read) => read.method === "GET")).toBe(true);
  const journal = await ctl<{ requests: Array<{ method: string; url: string }>; financialWrites: unknown[] }>("/p2d/journal");
  expect(journal.financialWrites).toEqual([]);
  const delta = journal.requests.slice(journalBefore.requests.length);
  const proposals = delta.filter((request) => request.method === "POST" && /^\/pending-operations\/v2\/propose(?:\?|$)/.test(request.url));
  expect(proposals).toHaveLength(1);
  expect(delta.filter((request) => request.method !== "GET" && /^(\/accounts|\/categories|\/dashboard|\/cards)/.test(request.url))).toEqual([]);

  const evidence = {
    scope: "p3-integrated-real-narrow-pilot",
    scenarios: ["single expense proposal without confirmation", "contextual account question"],
    promptCalls: stats.promptCalls - baseline.promptCalls,
    toolRouteReads: stats.financeReads ?? [],
    proposalRequests: proposals.length,
    financialWrites: journal.financialWrites.length,
    fullSixFlowProof: false,
  };
  const output = path.resolve(process.cwd(), "test-results", "p3-integrated-real", "evidence.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await info.attach("p3-integrated-real-evidence", { path: output, contentType: "application/json" });
});
