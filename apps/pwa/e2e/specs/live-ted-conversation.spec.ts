/**
 * Live TED CONVERSATION — 5+ turnos diversificados em produção (viewport mobile).
 *
 * Cobre, contra o workspace Test Family e com o modelo real:
 *  T1 leitura com grounding (saldo) + T2 proposta ("gastei 90 com <item>")
 *  + T3 resposta curta de categoria + T4 negação ("não confirmo" =>
 *  zero execução, zero escrita) + T5 confirmação com recibo + reload
 *  (histórico persiste) + T6 desfazer via TED (extrato atualizado).
 * Limpeza verificada no fim (zero resíduo "Teste E2E conversa").
 *
 * Opt-in: PWA_LIVE_E2E=1 + PWA_LIVE_ADMIN_EMAIL + PWA_LIVE_ADMIN_PASSWORD.
 * Todos os writes levam o marker do RUN_ID para identificação/limpeza.
 */
import { test, expect, type Page } from "@playwright/test";

const LIVE = process.env.PWA_LIVE_E2E === "1";
const EMAIL = process.env.PWA_LIVE_ADMIN_EMAIL || "";
const PASSWORD = process.env.PWA_LIVE_ADMIN_PASSWORD || "";
const LIVE_BASE_URL = process.env.PWA_LIVE_BASE_URL || "";

const RUN_ID = Date.now().toString(36);
const MARK = `Teste E2E conversa ${RUN_ID}`;
const ACCOUNT_NAME = `Conta E2E conversa ${RUN_ID}`;
const ACTIVE_WS = "550e8400-e29b-41d4-a716-446655440000"; // Test Family

test.describe.configure({ mode: "serial" });

test.describe("live-ted-conversation (5+ turnos, modelo real)", () => {
  test.skip(!LIVE || !EMAIL || !PASSWORD || !LIVE_BASE_URL, "Opt-in: PWA_LIVE_E2E=1 + credenciais + base URL via env");

  const shot = async (page: Page, name: string) => {
    await page.screenshot({ path: `test-results/live-conv/${name}.png`, fullPage: false });
  };

  const openTed = async (page: Page) => {
    const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
    await expect(launcher).toBeVisible({ timeout: 20000 });
    await launcher.click();
    await page.waitForURL(/\/ted/);
    const dialog = page.getByRole("region", { name: /chat com ted/i });
    await expect(dialog).toBeVisible({ timeout: 15000 });
    return dialog;
  };

  const sendTedMessage = async (page: Page, dialog: ReturnType<Page["getByRole"]>, text: string) => {
    for (let i = 0; i < 5; i++) {
      await page.evaluate(({ text }: { text: string }) => {
        const dlg = document.querySelector("[data-testid=ted-chat]");
        if (!dlg) return;
        const ta = dlg.querySelector("textarea");
        if (!ta) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(ta, text);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }, { text });
      await page.waitForTimeout(300);
      const enabled = await page.evaluate(() => {
        const dlg = document.querySelector("[data-testid=ted-chat]");
        const btn = dlg && [...dlg.querySelectorAll("button")].find((b) =>
          (b.getAttribute("aria-label") || "").includes("Enviar mensagem"),
        );
        return Boolean(btn && !btn.disabled);
      });
      if (enabled) break;
      if (i === 4) throw new Error(`botão Enviar nunca habilitou para: ${text}`);
      await page.waitForTimeout(1500);
    }
    const dispatched = await page.evaluate(() => {
      const dlg = document.querySelector("[data-testid=ted-chat]");
      const btn = dlg && [...dlg.querySelectorAll("button")].find((b) =>
        (b.getAttribute("aria-label") || "").includes("Enviar mensagem"),
      );
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    });
    if (!dispatched) throw new Error(`mensagem TED não pôde ser enviada: ${text}`);
    await expect(dialog.getByText(text, { exact: true }).first()).toBeVisible({ timeout: 30000 });
  };

  const countTxByMark = async (page: Page): Promise<number> =>
    page.evaluate(async ({ workspaceId, mark }: { workspaceId: string; mark: string }) => {
      let offset = 0;
      let total = 0;
      let found = 0;
      for (let guard = 0; guard < 20; guard++) {
        const res = await fetch(`/api/backend/transactions?limit=100&offset=${offset}`, {
          credentials: "include",
          headers: { "X-Workspace-Id": workspaceId },
        });
        if (!res.ok) return -1;
        const body = await res.json() as { items?: { description?: unknown }[]; total?: number };
        if (!Array.isArray(body.items) || typeof body.total !== "number") return -1;
        total = body.total;
        found += body.items.filter((t) => typeof t.description === "string" && t.description.includes(mark)).length;
        offset += body.items.length;
        if (offset >= total) break;
      }
      return found;
    }, { workspaceId: ACTIVE_WS, mark: MARK });

  const apiJson = async (page: Page, method: string, path: string, body?: unknown, idemKey?: string) =>
    page.evaluate(async ({ method, path, body, idemKey, workspaceId }:
      { method: string; path: string; body?: unknown; idemKey?: string; workspaceId: string }) => {
      const headers: Record<string, string> = { "X-Workspace-Id": workspaceId };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (idemKey) headers["Idempotency-Key"] = idemKey;
      const res = await fetch(path, {
        method,
        credentials: "include",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, { method, path, body, idemKey, workspaceId: ACTIVE_WS });

  test("conversa longa: leitura, proposta, categoria, negação, confirmação, reload, undo", async ({ page }) => {
    test.setTimeout(600_000);

    // ── LOGIN + workspace ──────────────────────────────────────────
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const emailInput = page.locator("#email").or(page.getByLabel("E-mail")).or(page.getByPlaceholder(/email/i));
    const passwordInput = page.locator("#password").or(page.getByLabel("Senha"));
    await expect(emailInput.first()).toBeVisible({ timeout: 30000 });
    await emailInput.first().fill(EMAIL);
    await passwordInput.first().fill(PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("button", { name: "Nova transação" })).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Selecionar espaço" }).click();
    await page.getByRole("option", { name: /Test Family/ }).click();
    await expect(page.getByRole("button", { name: "Selecionar espaço" })).toContainText("Test Family", { timeout: 15000 });

    // ── Preparação: conta de teste + categorias default + catálogo ──
    const acc = await apiJson(page, "POST", "/api/backend/accounts",
      { name: ACCOUNT_NAME, kind: "bank", initialBalanceCents: 10000 }, `conv-acc-${RUN_ID}`);
    expect(acc.status, `POST /accounts ${JSON.stringify(acc.body)}`).toBeLessThan(300);
    const testAccountId = (acc.body as { id?: unknown }).id as string;
    expect(typeof testAccountId).toBe("string");
    const defs = await apiJson(page, "POST", "/api/backend/categories/apply-defaults", {}, `conv-cat-${RUN_ID}`);
    expect(defs.status).toBe(200);
    const catalog = await apiJson(page, "GET", "/api/backend/categories");
    expect(catalog.status).toBe(200);
    const names = ((catalog.body as { items?: { name?: unknown }[] }).items ?? []).map((c) => String(c.name));
    // Estratégia live: a resposta curta (T3) usa um nome REAL do catálogo
    // (bare-name de categoria existente), provando o caminho bare-name de
    // ponta a ponta; a descrição usa "carne" para exercitar a sugestão
    // (quando houver candidato) ou a pergunta genérica honesta.
    const pick = (() => {
      const simples = names.map((n) => n.split(/[>/]/).pop()!.trim())
        .find((s) => /^[A-Za-zÀ-ÖØ-öø-ÿ ]{3,20}$/.test(s) && !/\d/.test(s));
      const short = names.find((n) => /mercado/i.test(n)) ?? simples ?? "Alimentação";
      return { item: "carne", short };
    })();
    const DESC = `${MARK} ${pick.item}`;

    const dialog = await openTed(page);

    // ── T1: leitura com grounding ──────────────────────────────────
    await sendTedMessage(page, dialog, "Qual o saldo total das minhas contas hoje? Responda citando o valor em reais.");
    await expect(dialog.getByText(/R\$\s*\d/).first()).toBeVisible({ timeout: 180_000 });
    await shot(page, "conv-01-leitura");

    // ── T2: proposta de mutação ────────────────────────────────────
    await sendTedMessage(page, dialog, `Na conta ${ACCOUNT_NAME} gastei 90 com ${pick.item} ${MARK}`);
    // TED deve pedir categoria ou propor (nunca sumir, nunca confirmar sozinho).
    // Aguarda progresso real: card de aprovação OU pergunta de categoria.
    const progress2 = await page.waitForFunction(() => {
      const dlg = document.querySelector("[data-testid=ted-chat]");
      if (!dlg) return null;
      const html = dlg.innerHTML;
      if (html.includes("ted-approval-item") || html.includes("ted-approval-focused")) return "card";
      if (/Qual categoria/i.test(dlg.textContent || "")) return "question";
      return null;
    }, { timeout: 180_000 }).then((h) => h.jsonValue()).catch(() => "timeout") as string;
    expect(progress2, "TED não progrediu após proposta (nem card, nem pergunta)").not.toBe("timeout");
    test.info().annotations.push({ type: "conv-t2", description: `progresso T2: ${progress2}` });
    await shot(page, "conv-02-proposta");

    // ── T3: resposta curta de categoria ────────────────────────────
    await sendTedMessage(page, dialog, pick.short);
    // Ou o card de aprovação aparece, ou uma nova pergunta (nunca a MESMA
    // pergunta idêntica em loop — ao menos o turno avança).
    await page.waitForTimeout(20000);
    const approvalCard = dialog.locator('[data-testid="ted-approval-item"], [data-testid="ted-approval-focused"]')
      .filter({ hasText: MARK }).first();
    const cardVisible = await approvalCard.isVisible().catch(() => false);
    await shot(page, "conv-03-categoria");
    test.info().annotations.push({ type: "conv-t3", description: `approval card visível após resposta curta: ${cardVisible}` });

    // ── T4: NEGAÇÃO — "não confirmo" não pode executar nada ────────
    const before = await countTxByMark(page);
    expect(before).toBeGreaterThanOrEqual(0);
    await sendTedMessage(page, dialog, "não confirmo");
    await page.waitForTimeout(25000); // dá tempo a qualquer execução indevida
    const afterDeny = await countTxByMark(page);
    expect(afterDeny, "negação executou mutação contra vontade expressa").toBe(before);
    await shot(page, "conv-04-negacao");

    // ── T5: confirmação explícita + recibo ──────────────────────────
    // Repropõe de forma determinística e confirma pelo card.
    await sendTedMessage(page, dialog, `Na conta ${ACCOUNT_NAME}, categoria ${pick.short}, hoje gastei R$ 90,00 ${MARK}`);
    const card2 = dialog.locator('[data-testid="ted-approval-item"], [data-testid="ted-approval-focused"]')
      .filter({ hasText: MARK }).first();
    await expect(card2).toBeVisible({ timeout: 180_000 });
    const wrapperId = await card2.getAttribute("id");
    expect(wrapperId).toMatch(/^ted-op-[0-9a-f-]{36}$/i);
    const operationId = wrapperId!.slice("ted-op-".length);
    const decisionWait = page.waitForResponse((r) => {
      const p = new URL(r.url()).pathname;
      return r.request().method() === "POST" &&
        p === `/api/agent/agents/finance-chat-agent/${ACTIVE_WS}/rpc/pending-operations/${operationId}/decision`;
    }, { timeout: 120_000 });
    const confirmBtn = card2.getByRole("button", { name: /Confirmar/i });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.evaluate((b) => (b as HTMLButtonElement).click());
    const decisionRes = await decisionWait;
    expect(decisionRes.status()).toBeLessThan(300);
    const decisionBody = await decisionRes.json() as { status?: unknown; receipt?: { entity?: { id?: unknown } } };
    expect(decisionBody.status).toBe("succeeded");
    const tedTxId = decisionBody.receipt?.entity?.id as string;
    expect(typeof tedTxId).toBe("string");
    // Exatamente UM lançamento com o marker.
    expect(await countTxByMark(page)).toBe(1);
    await shot(page, "conv-05-confirmacao");

    // ── T5b: RELOAD — histórico persiste (user + TED, sem sumiço) ───
    await page.goto("/ted", { waitUntil: "domcontentloaded" });
    const dialog2 = page.getByRole("region", { name: /chat com ted/i });
    await expect(dialog2).toBeVisible({ timeout: 15000 });
    for (const bubble of [`Na conta ${ACCOUNT_NAME}, categoria ${pick.short}, hoje gastei R$ 90,00 ${MARK}`, "não confirmo", pick.short]) {
      await expect(dialog2.getByText(bubble, { exact: true }).first()).toBeVisible({ timeout: 30000 });
    }
    await shot(page, "conv-05b-historico");

    // ── T6: DESFAZER via TED ───────────────────────────────────────
    await sendTedMessage(page, dialog2, "desfazer a última ação");
    const undoCard = dialog2.locator('[data-testid="ted-undo-item"], [data-testid="ted-undo-focused"], [data-testid="ted-undo-card"]').first();
    await expect(undoCard).toBeVisible({ timeout: 120_000 });
    await shot(page, "conv-06-undo-card");
    const undoConfirm = undoCard.getByRole("button", { name: /Confirmar|Desfazer|Sim/i });
    await expect(undoConfirm).toBeVisible({ timeout: 15000 });
    const undoWait = page.waitForResponse((r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname.includes("/rpc/undo"), { timeout: 120_000 });
    await undoConfirm.evaluate((b) => (b as HTMLButtonElement).click());
    const undoRes = await undoWait;
    expect(undoRes.status()).toBeLessThan(300);
    await page.waitForTimeout(10000);
    const afterUndo = await countTxByMark(page);
    expect(afterUndo, "undo não removeu o lançamento do extrato").toBe(0);
    await shot(page, "conv-06b-undo-ok");

    // ── LIMPEZA verificada ─────────────────────────────────────────
    const remaining = await countTxByMark(page);
    if (remaining > 0) {
      const list = await apiJson(page, "GET", "/api/backend/transactions?limit=100");
      const items = ((list.body as { items?: { id?: unknown; description?: unknown }[] }).items ?? [])
        .filter((t) => typeof t.description === "string" && t.description.includes(MARK));
      for (const item of items) {
        await apiJson(page, "DELETE", `/api/backend/transactions/${String(item.id)}`, undefined, `conv-clean-${RUN_ID}-${String(item.id)}`);
      }
    }
    const deact = await apiJson(page, "POST", `/api/backend/accounts/${testAccountId}/deactivate`, {}, `conv-deact-${RUN_ID}`);
    expect(deact.status).toBeLessThan(300);
    const final = await apiJson(page, "GET", "/api/backend/transactions?limit=100");
    const leftovers = ((final.body as { items?: { description?: unknown }[] }).items ?? [])
      .filter((t) => typeof t.description === "string" && t.description.includes("Teste E2E conversa"));
    expect(leftovers, `resíduo de conversa: ${JSON.stringify(leftovers)}`).toHaveLength(0);
    await shot(page, "conv-07-limpeza");
  });
});
