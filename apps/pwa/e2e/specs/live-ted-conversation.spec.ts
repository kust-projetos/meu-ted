/**
 * Live TED CONVERSATION — 5+ turnos diversificados em produção (viewport mobile).
 *
 * Fluxo MESMO-DRAFT (fix #178 — sem re-proposta explícita):
 *  T1 leitura com grounding (saldo) + T2 proposta ("gastei 90 com <item>",
 *  exige pergunta de categoria — INT-12) + T3 resposta curta de categoria
 *  (bare-name — INT-13) com expect DURO no card do draft original (MARK,
 *  binding autoritativo pelo pendingOperation.id do turno; loop de pergunta
 *  idêntica FALHA) + T5 confirmação do card do T3 (operationId do draft
 *  original → decision succeeded → exatamente 1 TX do draft original com
 *  categoryId == categoria de T3) + T4 negação num SEGUNDO draft
 *  ("não confirmo" => zero escrita nova, contagem segue 1) + T5b reload
 *  (bolhas do draft original persistem) + T6 desfazer via TED (extrato
 *  atualizado, undo vinculado ao TX correto). Limpeza idempotente em
 *  finally (zero resíduo RUN_ID desta execução mesmo em falha/skip,
 *  DELETE/deactivate com Idempotency-Key, verificada).
 *
 * Sem provider/relay/modelo autorizado o teste faz SKIP com motivo
 * INCONCLUSIVE — nunca PASS. Se o fluxo mesmo-draft não progredir
 * (sem sinal de provider indisponível), o teste FALHA.
 *
 * Opt-in: PWA_LIVE_E2E=1 + PWA_LIVE_ADMIN_EMAIL + PWA_LIVE_ADMIN_PASSWORD.
 * Todos os writes levam o marker do RUN_ID para identificação/limpeza.
 */
import { test, expect, type Page } from "@playwright/test";
import { validateNoHistoricReuse, validateReceiptBinding } from "../support/live-closure-guards";

const LIVE = process.env.PWA_LIVE_E2E === "1";
const EMAIL = process.env.PWA_LIVE_ADMIN_EMAIL || "";
const PASSWORD = process.env.PWA_LIVE_ADMIN_PASSWORD || "";
const LIVE_BASE_URL = process.env.PWA_LIVE_BASE_URL || "";

const RUN_ID = Date.now().toString(36);
const MARK = `Teste E2E conversa ${RUN_ID}`;
const ACCOUNT_NAME = `Conta E2E conversa ${RUN_ID}`;
const ACTIVE_WS = "550e8400-e29b-41d4-a716-446655440000"; // Test Family

// Sinais de provider/relay/modelo indisponível — avaliados SOMENTE no texto
// do turno corrente (ou no erro estruturado da resposta do turno), nunca no
// chat inteiro. Números soltos (ex. \b401\b, \b429\b, \b5\d\d\b) são
// proibidos aqui: casariam com valores financeiros de um grounding válido
// (ex. "Saldo R$ 401,00"). Códigos 401/429 classificam-se SOMENTE via erro
// estruturado do turno (readChatTurnError: HTTP status / code do corpo).
const PROVIDER_DOWN_RE =
  /indispon[íi]vel|n[ãa]o autorizado|unauthorized|forbidden|rate.?limit|limite de (uso|cota|requisi|token)|tente (mais tarde|novamente)|provedor|relay|modelo .* (falhou|erro|indispon[íi]vel)|(servidor|serviço) .* (falhou|erro)|erro (interno|do servidor)/i;

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

  type MarkedTx = { id: string; description: string; categoryId: string | null };

  const readTxByMark = async (page: Page): Promise<MarkedTx[] | null> =>
    page.evaluate(async ({ workspaceId, mark }: { workspaceId: string; mark: string }) => {
      const out: { id: string; description: string; categoryId: string | null }[] = [];
      let offset = 0;
      let total = 0;
      for (let guard = 0; guard < 20; guard++) {
        const res = await fetch(`/api/backend/transactions?limit=100&offset=${offset}`, {
          credentials: "include",
          headers: { "X-Workspace-Id": workspaceId },
        });
        if (!res.ok) return null;
        const body = await res.json() as {
          items?: { id?: unknown; description?: unknown; categoryId?: unknown; category_id?: unknown }[];
          total?: number;
        };
        if (!Array.isArray(body.items) || typeof body.total !== "number") return null;
        total = body.total;
        for (const t of body.items) {
          if (typeof t.description !== "string" || !t.description.includes(mark)) continue;
          if (typeof t.id !== "string") return null;
          const cat = t.categoryId ?? t.category_id;
          out.push({ id: t.id, description: t.description, categoryId: typeof cat === "string" ? cat : null });
        }
        offset += body.items.length;
        if (offset >= total) break;
      }
      return out;
    }, { workspaceId: ACTIVE_WS, mark: MARK });

  const countTxByMark = async (page: Page): Promise<number> => {
    const items = await readTxByMark(page);
    expect(items, "ledger ilegível ao contar lançamentos do marker").not.toBeNull();
    return items!.length;
  };

  const dialogText = (page: Page): Promise<string> =>
    page.evaluate(() => document.querySelector("[data-testid=ted-chat]")?.textContent ?? "");

  // Falha de progresso: SKIP INCONCLUSIVE quando há sinal de provider/
  // relay/modelo indisponível; FAIL explícito caso contrário (o fluxo
  // mesmo-draft não progrediu — nunca PASS vacilante). A evidência é
  // SEMPRE do turno corrente: erro estruturado da resposta do turno
  // (preferido) ou texto novo desde o início do turno — nunca o chat
  // inteiro, cujos valores financeiros (ex. "R$ 500") gerariam falso
  // INCONCLUSIVE.
  type TurnEvidence = { turnText?: string; turnError?: string | null };
  const failOrSkip = async (page: Page, context: string, failMessage: string, evidence?: TurnEvidence): Promise<never> => {
    if (evidence?.turnError) {
      test.info().annotations.push({ type: context, description: `INCONCLUSIVE (turno com erro estruturado: ${evidence.turnError}): ${failMessage}` });
      test.skip(true, `INCONCLUSIVE (sem provider/relay/modelo autorizado) em ${context}: ${failMessage}`);
    }
    const text = evidence?.turnText ?? await dialogText(page).catch(() => "");
    if (PROVIDER_DOWN_RE.test(text)) {
      test.info().annotations.push({ type: context, description: `INCONCLUSIVE (sem provider/relay/modelo autorizado): ${failMessage}` });
      test.skip(true, `INCONCLUSIVE (sem provider/relay/modelo autorizado) em ${context}: ${failMessage}`);
    }
    throw new Error(failMessage);
  };

  // Texto novo do chat desde um snapshot anterior (vincula pergunta/resposta
  // ao turno corrente, excluindo mensagens anteriores).
  const suffixText = (full: string, before: string): string =>
    full.length >= before.length && full.startsWith(before) ? full.slice(before.length) : full;

  // Erro estruturado da resposta de um turno de chat (HTTP >= 400, status
  // failed, ou campo error/code) — null quando o turno respondeu sem erro.
  const readChatTurnError = async (resp: Awaited<ReturnType<Page["waitForResponse"]>>): Promise<string | null> => {
    const status = resp.status();
    const body = await resp.json().catch(() => ({})) as {
      status?: unknown; error?: unknown; code?: unknown; message?: unknown;
    };
    if (status >= 400) return `chat turn HTTP ${status} ${String(body.code ?? body.error ?? body.message ?? "")}`.trim();
    if (body.status === "failed") return `chat turn status=failed ${String(body.code ?? body.message ?? "")}`.trim();
    if (typeof body.error === "string" && body.error) return `chat turn error: ${body.error}`;
    if (typeof body.code === "string" && /unauthor|forbidden|rate|limit|unavailable|5\d\d/i.test(body.code)) {
      return `chat turn code: ${body.code}`;
    }
    return null;
  };

  const chatPath = (url: string) => {
    const u = new URL(url);
    return u.pathname.endsWith("/rpc/chat");
  };

  const readPendingOpId = async (resp: Awaited<ReturnType<Page["waitForResponse"]>>): Promise<string> => {
    const body = await resp.json().catch(() => ({})) as { pendingOperation?: { id?: unknown } };
    return typeof body.pendingOperation?.id === "string" ? body.pendingOperation.id : "";
  };

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

  test("conversa longa mesmo-draft: leitura, proposta, categoria, confirmação, negação, reload, undo", async ({ page }) => {
    test.setTimeout(600_000);
    let testAccountId = "";
    let flowOk = false;

    // Limpeza idempotente dos resíduos DESTA execução (marker RUN_ID):
    // apaga TXs marcados (best-effort por item, 404 tolerado), desativa a
    // conta criada e verifica resíduo zero. Roda no finally mesmo em
    // falha/skip; no caminho de falha só reporta (não mascara o erro raiz).
    const cleanupRun = async (phase: string) => {
      const marked = await readTxByMark(page).catch(() => null);
      for (const t of marked ?? []) {
        await apiJson(page, "DELETE", `/api/backend/transactions/${t.id}`, undefined, `conv-clean-${RUN_ID}-${t.id}`).catch(() => ({}));
      }
      if (testAccountId) {
        await apiJson(page, "POST", `/api/backend/accounts/${testAccountId}/deactivate`, {}, `conv-deact-${RUN_ID}`).catch(() => ({}));
      }
      const check = await readTxByMark(page).catch(() => null);
      expect(check, `limpeza ${phase}: ledger ilegível`).not.toBeNull();
      expect(check!, `limpeza ${phase}: resíduo desta execução: ${JSON.stringify(check)}`).toHaveLength(0);
      if (testAccountId) {
        const accCheck = await apiJson(page, "GET", "/api/backend/accounts").catch(() => null) as {
          status: number; body: { items?: { id?: unknown; name?: unknown; isActive?: unknown }[] };
        } | null;
        expect(accCheck, `limpeza ${phase}: catálogo de contas ilegível`).not.toBeNull();
        expect(accCheck!.status, `limpeza ${phase}: GET /accounts sem HTTP 200`).toBe(200);
        expect(Array.isArray(accCheck!.body.items), `limpeza ${phase}: catálogo de contas sem items array`).toBe(true);
        const ghost = accCheck!.body.items!.find((a) => a.name === ACCOUNT_NAME && a.isActive !== false);
        expect(ghost, `limpeza ${phase}: conta desta execução segue ativa`).toBeUndefined();
      }
    };

    try {
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
    testAccountId = (acc.body as { id?: unknown }).id as string;
    expect(typeof testAccountId).toBe("string");
    const defs = await apiJson(page, "POST", "/api/backend/categories/apply-defaults", {}, `conv-cat-${RUN_ID}`);
    expect(defs.status).toBe(200);
    const catalog = await apiJson(page, "GET", "/api/backend/categories");
    expect(catalog.status).toBe(200);
    const catItems = ((catalog.body as { items?: { id?: unknown; name?: unknown }[] }).items ?? [])
      .filter((c) => typeof c.name === "string" && typeof c.id === "string");
    const names = catItems.map((c) => String(c.name));
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
    // Categoria esperada no TX do draft original: resolve o id pelo nome
    // (exato, depois bare-name) — sem id não há como provar o vínculo T3.
    const expectedCategory = catItems.find((c) => c.name === pick.short)
      ?? catItems.find((c) => String(c.name).split(/[>/]/).pop()!.trim() === pick.short);
    if (!expectedCategory || typeof expectedCategory.id !== "string") {
      throw new Error(`categoria de T3 "${pick.short}" sem id no catálogo — vínculo categoryId improvável`);
    }
    const expectedCategoryId = expectedCategory.id as string;
    const T2_TEXT = `Na conta ${ACCOUNT_NAME} gastei 90 com ${pick.item} ${MARK}`;
    const T4_TEXT = `Na conta ${ACCOUNT_NAME} gastei 45 com pão ${MARK}`;
    const DESC = `${MARK} ${pick.item}`;

    const dialog = await openTed(page);

    // ── T1: leitura com grounding ──────────────────────────────────
    const preT1 = await dialogText(page).catch(() => "");
    const chat1 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 200_000 });
    await sendTedMessage(page, dialog, "Qual o saldo total das minhas contas hoje? Responda citando o valor em reais.");
    try {
      await expect(dialog.getByText(/R\$\s*\d/).first()).toBeVisible({ timeout: 180_000 });
    } catch {
      const t1Resp = await chat1.then((r) => r).catch(() => null);
      const t1Error = t1Resp ? await readChatTurnError(t1Resp) : null;
      const t1Text = suffixText(await dialogText(page).catch(() => ""), preT1);
      await failOrSkip(page, "conv-t1", "T1 sem grounding (saldo em R$ ausente após 180s)",
        { turnText: t1Text, turnError: t1Error });
    }
    await shot(page, "conv-01-leitura");

    // ── T2: proposta de mutação — EXIGE pergunta de categoria ───────
    // Mesmo-draft: sem categoria informada o TED deve perguntar (INT-12);
    // card direto aqui significaria categorização presumida — FALHA, pois o
    // restante do fluxo prova o caminho pergunta→bare-name→card (INT-13).
    const preT2 = await dialogText(page).catch(() => "");
    const chat2 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 200_000 });
    await sendTedMessage(page, dialog, T2_TEXT);
    const progress2 = await page.waitForFunction(() => {
      const dlg = document.querySelector("[data-testid=ted-chat]");
      if (!dlg) return null;
      const html = dlg.innerHTML;
      if (/qual\s+(a\s+)?categoria/i.test(dlg.textContent || "")) return "question";
      if (html.includes("ted-approval-item") || html.includes("ted-approval-focused")) return "card";
      return null;
    }, undefined, { timeout: 180_000 }).then((h) => h.jsonValue()).catch(() => "timeout") as string;
    test.info().annotations.push({ type: "conv-t2", description: `progresso T2: ${progress2}` });
    const t2Resp = await chat2.then((r) => r).catch(() => null);
    const t2Evidence = {
      turnText: suffixText(await dialogText(page).catch(() => ""), preT2),
      turnError: t2Resp ? await readChatTurnError(t2Resp) : null,
    };
    if (progress2 === "timeout") {
      await failOrSkip(page, "conv-t2", "TED não progrediu após proposta (nem pergunta de categoria, nem card)", t2Evidence);
    }
    if (progress2 !== "question") {
      await failOrSkip(page, "conv-t2",
        `T2 produziu card direto em vez da pergunta de categoria (progresso: ${progress2}) — mesmo-draft exige o caminho pergunta→bare-name (INT-12/INT-13)`,
        t2Evidence);
    }
    // Pergunta vinculada ao turno T2: só o texto novo desde o envio de T2
    // (mensagens anteriores a T2 excluídas). A pergunta deve estar DENTRO
    // deste sufixo — casar no diálogo inteiro permitiria reusar pergunta de
    // turno anterior (falso-positivo).
    const t2Question = suffixText(await dialogText(page), preT2);
    if (!/qual\s+(a\s+)?categoria/i.test(t2Question)) {
      await failOrSkip(page, "conv-t2",
        "pergunta de categoria ausente no sufixo do turno T2 (diálogo inteiro não vale)",
        t2Evidence);
    }
    await shot(page, "conv-02-proposta");

    // ── T3: resposta curta de categoria — EXPECT DURO no card ───────
    // Binding autoritativo: o id da pendingOperation do TURNO T3 (nunca o
    // primeiro card com MARK, nunca stale de outro run). Loop de pergunta
    // idêntica FALHA em vez de passar adiante.
    const preT3 = await dialogText(page).catch(() => "");
    const chat3 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 120_000 });
    await sendTedMessage(page, dialog, pick.short);
    const t3Resp = await chat3;
    const t3opId = await readPendingOpId(t3Resp);
    if (!t3opId) {
      await failOrSkip(page, "conv-t3", "turno T3 não emitiu pendingOperation — draft original não progrediu",
        { turnText: suffixText(await dialogText(page).catch(() => ""), preT3), turnError: await readChatTurnError(t3Resp) });
    }
    validateNoHistoricReuse([t3opId]);
    const card = dialog.locator(`[id="ted-op-${t3opId}"]`);
    try {
      await expect(card).toBeVisible({ timeout: 180_000 });
      await expect(card.getByText(MARK, { exact: false })).toBeVisible({ timeout: 30000 });
    } catch {
      const afterText = suffixText(await dialogText(page).catch(() => ""), preT3);
      const sameQuestion = /qual\s+(a\s+)?categoria/i.test(afterText) &&
        t2Question.split(/qual\s+(a\s+)?categoria/i)[1]?.slice(0, 80) ===
        afterText.split(/qual\s+(a\s+)?categoria/i)[1]?.slice(0, 80);
      await failOrSkip(page, "conv-t3",
        sameQuestion
          ? `TED repetiu a MESMA pergunta de categoria após a resposta curta "${pick.short}" (loop) — card ted-op-${t3opId} ausente`
          : `card do draft original ausente após resposta curta "${pick.short}" (ted-op-${t3opId} sem MARK visível em 180s)`,
        { turnText: afterText, turnError: await readChatTurnError(t3Resp) });
    }
    test.info().annotations.push({ type: "conv-t3", description: `card mesmo-draft visível: ted-op-${t3opId}` });
    await shot(page, "conv-03-categoria");

    // ── T5: confirmação do card do T3 (operationId do draft original) ─
    // Sem re-proposta: o clique confirma o MESMO draft. Prova: decision
    // succeeded + recibo vinculado (entity.id) + exatamente 1 TX com o
    // marker, cujo id == recibo e cujo categoryId == categoria de T3.
    const operationId = t3opId;
    const decisionWait = page.waitForResponse((r) => {
      const p = new URL(r.url()).pathname;
      return r.request().method() === "POST" &&
        p === `/api/agent/agents/finance-chat-agent/${ACTIVE_WS}/rpc/pending-operations/${operationId}/decision`;
    }, { timeout: 120_000 });
    const confirmBtn = card.getByRole("button", { name: /Confirmar/i });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.evaluate((b) => (b as HTMLButtonElement).click());
    const decisionRes = await decisionWait;
    expect(decisionRes.status()).toBeLessThan(300);
    const decisionBody = await decisionRes.json() as {
      operationId?: unknown; status?: unknown;
      receipt?: { status?: unknown; operationId?: unknown; mutationId?: unknown; entity?: { type?: unknown; id?: unknown } };
    };
    expect(decisionBody.status).toBe("succeeded");
    // Recibo estrito e incondicional: operationId + status succeeded +
    // receipt.operationId + receipt.status + receipt.mutationId +
    // entity {type:'transaction', id} — via validateReceiptBinding.
    const tedTxId = validateReceiptBinding(decisionBody, operationId);
    validateNoHistoricReuse([tedTxId, operationId]);
    // Exatamente UM lançamento com o marker — e é o do draft original.
    const marked = await readTxByMark(page);
    expect(marked, "ledger ilegível após confirmação").not.toBeNull();
    expect(marked!.length, `esperado 1 TX do draft original, achado ${marked!.length}`).toBe(1);
    expect(marked![0]!.id, "TX confirmado não é o do recibo do draft original").toBe(tedTxId);
    expect(marked![0]!.description).toContain(DESC);
    expect(marked![0]!.categoryId, `categoryId do TX (${marked![0]!.categoryId}) != categoria de T3 (${expectedCategoryId})`).toBe(expectedCategoryId);
    test.info().annotations.push({ type: "conv-t5", description: `mesmo-draft confirmado: op ${operationId} tx ${tedTxId} cat ${expectedCategoryId}` });
    await shot(page, "conv-05-confirmacao");

    // ── T4: NEGAÇÃO num segundo draft — "não confirmo" não executa ───
    // A negação roda DEPOIS da confirmação do draft original (negar o
    // próprio card do T3 o cancelaria e inviabilizaria o mesmo-draft).
    // Jornada negar→cancelar (INT-22) num draft próprio: zero escrita nova.
    const preT4 = await dialogText(page).catch(() => "");
    const chat4 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 120_000 });
    await sendTedMessage(page, dialog, T4_TEXT);
    const t4Resp = await chat4;
    const t4opId = await readPendingOpId(t4Resp);
    if (!t4opId) {
      await failOrSkip(page, "conv-t4", "turno T4 não emitiu pendingOperation — draft da negação não progrediu",
        { turnText: suffixText(await dialogText(page).catch(() => ""), preT4), turnError: await readChatTurnError(t4Resp) });
    }
    validateNoHistoricReuse([t4opId]);
    expect(t4opId, "draft da negação reutilizou o operationId do draft original").not.toBe(operationId);
    const card4 = dialog.locator(`[id="ted-op-${t4opId}"]`);
    try {
      await expect(card4).toBeVisible({ timeout: 180_000 });
    } catch {
      await failOrSkip(page, "conv-t4", `card do draft da negação ausente (ted-op-${t4opId})`,
        { turnText: suffixText(await dialogText(page).catch(() => ""), preT4), turnError: await readChatTurnError(t4Resp) });
    }
    const before = await countTxByMark(page);
    expect(before, "contagem pré-negação divergiu do TX do draft original").toBe(1);
    const denyChat = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 120_000 });
    await sendTedMessage(page, dialog, "não confirmo");
    const denyResp = await denyChat;
    const denyBody = await denyResp.json().catch(() => ({})) as {
      status?: unknown; output?: unknown;
      pendingOperation?: { id?: unknown; status?: unknown };
    };
    // Estado terminal cancelled do draft da negação, VINCULADO ao t4opId
    // por resposta estruturada: o turno de negação deve materializar
    // pendingOperation { id: t4opId, status: 'cancelled' }. Cópia textual
    // ("Operação cancelada") sozinha NÃO basta — sem vínculo estruturado ao
    // t4opId, FALHA (ou SKIP INCONCLUSIVE com sinal de provider).
    const denyOp = denyBody.pendingOperation;
    if (denyOp?.id !== t4opId) {
      await failOrSkip(page, "conv-t4",
        `negação sem vínculo estruturado ao draft ${t4opId} (pendingOperation ausente ou id divergente) — texto sozinho não prova cancelamento`,
        { turnText: suffixText(await dialogText(page).catch(() => ""), preT4), turnError: await readChatTurnError(denyResp) });
    }
    expect(denyOp.status, `draft da negação ${t4opId} sem estado terminal cancelled`).toBe("cancelled");
    validateNoHistoricReuse([JSON.stringify(denyBody).slice(0, 4000)]);
    await page.waitForTimeout(25000); // dá tempo a qualquer execução indevida
    const afterDeny = await countTxByMark(page);
    expect(afterDeny, "negação executou mutação contra vontade expressa").toBe(before);
    // Identidade do TX original revalidada após a negação: o único marcado
    // segue sendo o do recibo do draft original (id + descrição + categoria).
    const afterDenyMarked = await readTxByMark(page);
    expect(afterDenyMarked, "ledger ilegível após negação").not.toBeNull();
    expect(afterDenyMarked!.length, "negação alterou o conjunto de TXs marcados").toBe(1);
    expect(afterDenyMarked![0]!.id, "negação trocou o TX do draft original").toBe(tedTxId);
    expect(afterDenyMarked![0]!.description).toContain(DESC);
    expect(afterDenyMarked![0]!.categoryId, "negação alterou a categoria do TX original").toBe(expectedCategoryId);
    await shot(page, "conv-04-negacao");

    // ── T5b: RELOAD — histórico persiste (user + TED, sem sumiço) ────
    await page.goto("/ted", { waitUntil: "domcontentloaded" });
    const dialog2 = page.getByRole("region", { name: /chat com ted/i });
    await expect(dialog2).toBeVisible({ timeout: 15000 });
    for (const bubble of [T2_TEXT, pick.short, T4_TEXT, "não confirmo"]) {
      await expect(dialog2.getByText(bubble, { exact: true }).first()).toBeVisible({ timeout: 30000 });
    }
    await shot(page, "conv-05b-historico");

    // ── T6: DESFAZER via TED (vinculado ao TX correto) ───────────────
    // O único TX com o marker é o do draft original (o draft da negação
    // foi cancelado sem escrever): zerar a contagem prova que o undo
    // atingiu o TX certo (tedTxId).
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
    const afterUndo = await readTxByMark(page);
    expect(afterUndo, "ledger ilegível após undo").not.toBeNull();
    expect(afterUndo!.length, `undo não removeu o TX do draft original (${tedTxId}) do extrato`).toBe(0);
    await shot(page, "conv-06b-undo-ok");

    // ── LIMPEZA verificada (Idempotency-Key em cada escrita) ──────────
    // Idempotente e verificada (resíduo zero desta execução + conta
    // desativada); o finally abaixo repete a garantia em falha/skip.
    await cleanupRun("final");
    await shot(page, "conv-07-limpeza");
    flowOk = true;
    } finally {
      if (!flowOk) {
        // Falhar alto: limpeza incompleta em falha/skip impede conclusão
        // limpa — anota E propaga (nunca engole).
        try {
          await cleanupRun("finally");
        } catch (e) {
          test.info().annotations.push({ type: "conv-cleanup", description: `limpeza pós-falha/skip incompleta: ${(e as Error).message}` });
          throw e;
        }
      } else {
        await cleanupRun("finally");
      }
    }
  });
});
