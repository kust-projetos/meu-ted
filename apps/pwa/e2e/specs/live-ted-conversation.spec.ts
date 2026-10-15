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
 *
 * R5 (fix #178 — anti-falso-vermelho de hidratação): o run real falhou em T2
 * (22.9s) porque o snapshot preT2 foi capturado durante a hidratação
 * ("conectando…" no header, dentro de [data-testid=ted-chat]) com histórico
 * de runs anteriores no workspace — o texto mutou entre snapshot e leitura e
 * o fail-closed de reidratação disparou sem que a resposta real de T2 fosse
 * avaliada. Endurecimento (só-teste): (a) waitForChatReady bloqueia qualquer
 * snapshot pré-turno e envio até a sessão sair de "conectando…"/"escrevendo…"
 * (timeout explícito com diagnóstico, nunca segue em estado transiente);
 * (b) isolamento de turno por IDENTIDADE (bolhas da message-list + ids
 * ted-op-*, multiset tolerante a reordem/reidratação), texto como fallback
 * secundário — reidratação que preserva o conjunto de ids não invalida o
 * turno; (c) pre-flight fail-fast (read-only) que lista contas "E2E conversa
 * *", markers e propostas pendentes de OUTROS runs sem deletar nada alheio.
 *
 * R6 (fix #178 — waits TURN-SCOPED): o run live R5 (19.9s, FAIL linha 508)
 * revelou falha sistêmica — progress2="question" veio do HISTÓRICO ("Qual
 * categoria devo usar?" de run anterior), não do nosso turno; nossa mensagem
 * T2 não constava no snapshot final; sufixo por identidade vazio; header
 * ainda "conectando.". Conclusão: waits de progresso que varrem o diálogo
 * inteiro são instantaneamente satisfeitos pelo histórico rico — o teste
 * nunca espera DE FATO o nosso turno. Endurecimento (só-teste): (a) TODOS
 * os waits de progresso (T1 R$, T2 pergunta/card, T3/T4 card, T6 undo)
 * passam a ser TURN-SCOPED via poll de snapshots comparando
 * turnSuffix(preTurn) até conter o sinal esperado (timeout com diagnóstico
 * que inclui o sufixo atual) — NENHUM wait pode ser satisfeito por conteúdo
 * pré-snapshot (card = approvalId novo vs preTurn, nunca innerHTML do
 * diálogo inteiro); (b) após cada envio, exigir a bolha PRÓPRIA no sufixo
 * antes de aguardar a resposta (bolha própria sumida = FAIL explícito
 * "bolha própria perdida", bug #169 ressurgido — nunca mascarado);
 * (c) T5 decision segue vinculado por URL com operationId do turno
 * (inerentemente turn-scoped); T5b é checagem de persistência pós-reload
 * (histórico esperado — âncoras de identidade do run preservadas). */
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
  type TurnEvidence = { turnText?: string | null; turnError?: string | null };
  const failOrSkip = async (_page: Page, context: string, failMessage: string, evidence?: TurnEvidence): Promise<never> => {
    if (evidence?.turnError) {
      test.info().annotations.push({ type: context, description: `INCONCLUSIVE (turno com erro estruturado: ${evidence.turnError}): ${failMessage}` });
      test.skip(true, `INCONCLUSIVE (sem provider/relay/modelo autorizado) em ${context}: ${failMessage}`);
    }
    // Disciplina do turno: SOMENTE o sufixo do turno corrente classifica
    // SKIP. Sufixo ausente (snapshot não-prefixo) FALHA fechado com
    // diagnóstico de reidratação — nunca lê o chat inteiro, cujo conteúdo
    // histórico produziria SKIP INCONCLUSIVE ou PASS indevido.
    const text = evidence?.turnText;
    if (text == null) {
      throw new Error(`${failMessage} (reidratação: snapshot do turno não é prefixo do texto atual — sufixo indisponível)`);
    }
    if (PROVIDER_DOWN_RE.test(text)) {
      test.info().annotations.push({ type: context, description: `INCONCLUSIVE (sem provider/relay/modelo autorizado): ${failMessage}` });
      test.skip(true, `INCONCLUSIVE (sem provider/relay/modelo autorizado) em ${context}: ${failMessage}`);
    }
    throw new Error(failMessage);
  };

  // Texto novo do chat desde um snapshot anterior (vincula pergunta/resposta
  // ao turno corrente, excluindo mensagens anteriores). Fail-closed: se o
  // snapshot NÃO for prefixo do texto atual (reidratação/reload/race),
  // devolve null — nunca o chat inteiro, que admitiria pergunta histórica
  // (falso-positivo) ou texto de provider histórico (falso INCONCLUSIVE).
  const suffixText = (full: string, before: string): string | null =>
    full.length >= before.length && full.startsWith(before) ? full.slice(before.length) : null;

  // R5 (fix #178): a sessão TED sai de "conectando…" SÓ DEPOIS que o snapshot
  // pré-turno seria capturado — o header vive dentro de [data-testid=ted-chat]
  // e sua hidratação muta dialogText sem mensagem nova. Bloqueia qualquer
  // snapshot pré-turno e envio até a sessão sair do estado transiente
  // ("conectando…" E "escrevendo…" ausentes com message-list montada).
  // Timeout explícito com diagnóstico — nunca segue em estado transiente.
  // Status de erro persistente ("indisponível"/sinal de provider) vira SKIP
  // INCONCLUSIVE estruturado (mesma disciplina de failOrSkip); transiente
  // preso vira FAIL fechado.
  const waitForChatReady = async (page: Page, context: string): Promise<void> => {
    const ready = await page.waitForFunction(() => {
      const list = document.querySelector('[data-testid="ted-message-list"]');
      if (!list) return false;
      const header = document.querySelector('[data-testid="ted-chat"]')?.textContent ?? "";
      return !/conectando/i.test(header) && !/escrevendo/i.test(header);
    }, undefined, { timeout: 60_000 }).then(() => true).catch(() => false);
    if (ready) return;
    const cur = await dialogText(page).catch(() => "");
    if (PROVIDER_DOWN_RE.test(cur) || /indispon[ií]vel/i.test(cur)) {
      test.info().annotations.push({ type: context, description: `INCONCLUSIVE (sessão TED nunca pronta): ${cur.slice(0, 300)}` });
      test.skip(true, `INCONCLUSIVE (sessão TED nunca pronta) em ${context}`);
      return;
    }
    throw new Error(
      `${context}: sessão TED não ficou pronta em 60s (conectando/escrevendo persistente) — ` +
      `snapshot/envio recusado em estado transiente (chat: ${JSON.stringify(cur.slice(0, 500))})`,
    );
  };

  // R5 (fix #178): fotografia de IDENTIDADE do turno. O DOM das mensagens
  // (TedMessage) não expõe id/intentionId — a identidade é o multiset das
  // bolhas filhas diretas da message-list + os ids dos cards ted-op-*
  // (pendingOperations autoritativas por id de turno). Reidratação que
  // reordene/rehidrate sem mudar o conjunto NÃO invalida o turno; perda de
  // bolha ou sumiço de card mantém o fail-closed.
  // R6: conta também os undo-items (data-testid ted-undo-*) para o wait
  // TURN-SCOPED de T6 — item pré-snapshot nunca satisfaz o progresso.
  type TurnSnapshot = { text: string; bubbles: string[]; approvalIds: string[]; undos: number };

  const snapshotTurn = async (page: Page): Promise<TurnSnapshot> =>
    page.evaluate(() => {
      const dlg = document.querySelector("[data-testid=ted-chat]");
      const list = document.querySelector("[data-testid=ted-message-list]");
      return {
        text: dlg?.textContent ?? "",
        bubbles: list ? [...list.children].map((c) => c.textContent ?? "") : [],
        approvalIds: dlg ? [...dlg.querySelectorAll('[id^="ted-op-"]')].map((el) => el.id).sort() : [],
        undos: dlg
          ? dlg.querySelectorAll('[data-testid="ted-undo-item"], [data-testid="ted-undo-focused"], [data-testid="ted-undo-card"]').length
          : 0,
      };
    });

  // Sufixo do turno por IDENTIDADE com texto como fallback secundário:
  // prefixo textual exato (caminho rápido, mesma semântica anterior) OU
  // reconciliação por identidade (todo o snapshot preservado como multiset
  // + mesmos cards → só o conteúdo novo; nada novo fora da message-list
  // conta como turno — header/notice não são resposta). null = divergência
  // real (bolha perdida/card sumido) — fail-closed como antes.
  const turnSuffix = (full: TurnSnapshot, before: TurnSnapshot): string | null => {
    const fast = suffixText(full.text, before.text);
    if (fast !== null) return fast;
    const remaining = [...full.bubbles];
    for (const b of before.bubbles) {
      const i = remaining.indexOf(b);
      if (i === -1) return null;
      remaining.splice(i, 1);
    }
    for (const id of before.approvalIds) {
      if (!full.approvalIds.includes(id)) return null;
    }
    return remaining.join("\n");
  };

  const readTurnSuffix = async (page: Page, before: TurnSnapshot): Promise<string | null> =>
    snapshotTurn(page).then((snap) => turnSuffix(snap, before)).catch(() => null);

  // R6 (fix #178): waits de progresso TURN-SCOPED. Todo sinal de progresso
  // (R$, pergunta de categoria, card, undo) é aguardado por poll de
  // snapshots comparando turnSuffix(preTurn) até conter o sinal esperado —
  // NENHUM wait varre o diálogo inteiro, que o histórico rico satisfaria
  // instantaneamente (falso-vermelho/máscara do run R5). Timeout devolve o
  // último sufixo (ou null em divergência de identidade) para diagnóstico
  // via failOrSkip — nunca lê o chat inteiro como evidência.
  const TURN_SIGNAL_TIMEOUT_MS = 180_000;
  const OWN_BUBBLE_TIMEOUT_MS = 30_000;

  const describeTurnSuffix = (suffix: string | null, max = 800): string =>
    suffix === null
      ? "<sufixo indisponível: divergência de identidade (bolha perdida ou card sumido)>"
      : JSON.stringify(suffix.slice(-max));

  const waitForTurnMatch = async (
    page: Page,
    before: TurnSnapshot,
    match: (suffix: string, full: TurnSnapshot) => boolean,
    timeoutMs = TURN_SIGNAL_TIMEOUT_MS,
  ): Promise<{ suffix: string | null; full: TurnSnapshot | null }> => {
    const deadline = Date.now() + timeoutMs;
    let lastSuffix: string | null = null;
    let lastFull: TurnSnapshot | null = null;
    for (;;) {
      const full = await snapshotTurn(page).catch(() => null);
      const suffix = full ? turnSuffix(full, before) : null;
      if (full && suffix !== null && match(suffix, full)) return { suffix, full };
      lastSuffix = suffix;
      lastFull = full;
      if (Date.now() >= deadline) return { suffix: lastSuffix, full: lastFull };
      await page.waitForTimeout(1000);
    }
  };

  // R6: após cada envio, exigir a bolha PRÓPRIA no sufixo do turno antes de
  // aguardar a resposta. Bolha própria sumida = FAIL explícito "bolha
  // própria perdida" (bug #169 ressurgido) — nunca mascarado como timeout
  // de progresso nem convertido em SKIP.
  const requireOwnBubble = async (
    page: Page,
    before: TurnSnapshot,
    ownText: string,
    context: string,
    timeoutMs = OWN_BUBBLE_TIMEOUT_MS,
  ): Promise<string> => {
    const { suffix } = await waitForTurnMatch(page, before, (s) => s.includes(ownText), timeoutMs);
    if (suffix !== null && suffix.includes(ownText)) return suffix;
    throw new Error(
      `${context}: bolha própria perdida após envio ("${ownText.slice(0, 120)}") — ` +
      `bug #169 ressurgido, sem mascaramento (sufixo atual: ${describeTurnSuffix(suffix)})`,
    );
  };

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

    // ── R5 pre-flight: isolamento do RUN_ID (fail-fast, read-only) ────
    // Workspace Test Family é compartilhado entre runs: conta "E2E conversa *"
    // ativa ou marker "Teste E2E conversa *" de OUTRO run invalida o
    // isolamento de turno — FALHA listando (nunca deleta nada alheio; a
    // limpeza do finally só toca o marker DESTE run).
    const accPre = await apiJson(page, "GET", "/api/backend/accounts");
    expect(accPre.status, "pre-flight: catálogo de contas ilegível").toBe(200);
    const accPreItems = ((accPre.body as { items?: { id?: unknown; name?: unknown; isActive?: unknown }[] }).items ?? []);
    const foreignAccounts = accPreItems
      .filter((a) => typeof a.name === "string" && /^Conta E2E conversa /.test(a.name) && a.name !== ACCOUNT_NAME && a.isActive !== false)
      .map((a) => `${String(a.name)} (id=${String(a.id)})`);
    const foreignMarks = await page.evaluate(async ({ workspaceId, runId }: { workspaceId: string; runId: string }) => {
      const seen = new Set<string>();
      for (let p = 0; p < 3; p++) {
        const res = await fetch(`/api/backend/transactions?limit=100&offset=${p * 100}`, {
          credentials: "include",
          headers: { "X-Workspace-Id": workspaceId },
        });
        if (!res.ok) return { unreadable: true, foreign: [] as string[] };
        const body = await res.json().catch(() => ({})) as { items?: { description?: unknown }[]; total?: number };
        if (!Array.isArray(body.items)) return { unreadable: true, foreign: [] as string[] };
        for (const t of body.items) {
          if (typeof t.description !== "string") continue;
          const m = /Teste E2E conversa (\S+)/.exec(t.description);
          if (m && m[1] !== runId) seen.add(m[1]!);
        }
        if (typeof body.total === "number" && (p + 1) * 100 >= body.total) break;
      }
      return { unreadable: false, foreign: [...seen] };
    }, { workspaceId: ACTIVE_WS, runId: RUN_ID });
    if (foreignMarks.unreadable) {
      throw new Error(`pre-flight: ledger ilegível — isolamento de "${MARK}" improvável (nada foi deletado)`);
    }
    const preflightViolations = [
      ...foreignAccounts.map((a) => `conta alheia ativa: ${a}`),
      ...foreignMarks.foreign.map((r) => `marker de outro run no ledger (primeiras 300 txs): runId=${r}`),
    ];
    if (preflightViolations.length > 0) {
      throw new Error(`pre-flight: resíduo de outro run no workspace TestFamily — ${preflightViolations.join("; ")} (nada foi deletado)`);
    }

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
    // T4 precisa EMITIR proposta para a negação ter o que cancelar: "pão"
    // sem categoria é genuinamente ambíguo e o TED pergunta (correto, #170).
    // Categoria explícita aqui não enfraquece o teste — o caminho
    // pergunta→bare-name já foi provado em T2/T3 neste mesmo run.
    const T4_TEXT = `Na conta ${ACCOUNT_NAME} gastei 45 com pão, categoria ${pick.short} ${MARK}`;
    // Descrição do produto compõe item+marker em ordem própria; os asserts
    // exigem conter AMBOS (MARK e pick.item), sem fixar ordem.

    const dialog = await openTed(page);

    // ── R5 pre-flight (DOM): propostas pendentes pré-existentes ─────────
    // Só depois de waitForChatReady (com histórico ainda carregando, a lista
    // de pendentes pode estar incompleta — falso-negativo). Qualquer card
    // ted-op-* ou undo-item aqui é de OUTRO run: FALHA listando, sem deletar.
    await waitForChatReady(page, "conv-preflight");
    const preflightPending = await page.evaluate(() => ({
      ops: [...document.querySelectorAll('[id^="ted-op-"]')].map((el) => el.id),
      undos: document.querySelectorAll('[data-testid="ted-undo-item"], [data-testid="ted-undo-focused"], [data-testid="ted-undo-card"]').length,
    }));
    if (preflightPending.ops.length > 0 || preflightPending.undos > 0) {
      throw new Error(
        `pre-flight: propostas pendentes pré-existentes no chat (cards: ${preflightPending.ops.join(", ") || "nenhum"}; ` +
        `undo-items: ${preflightPending.undos}) — resíduo de outro run (nada foi deletado)`,
      );
    }

    // ── T1: leitura com grounding ──────────────────────────────────
    // R5: sessão pronta antes do snapshot (nunca em "conectando…").
    await waitForChatReady(page, "conv-t1");
    const preT1 = await snapshotTurn(page);
    const chat1 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 200_000 });
    const T1_TEXT = "Qual o saldo total das minhas contas hoje? Responda citando o valor em reais.";
    await sendTedMessage(page, dialog, T1_TEXT);
    // R6: bolha própria no sufixo antes de aguardar a resposta; progresso
    // TURN-SCOPED (R$ só vale no sufixo do turno — histórico nunca satisfaz).
    await requireOwnBubble(page, preT1, T1_TEXT, "conv-t1");
    const t1Wait = await waitForTurnMatch(page, preT1, (s) => /R\$\s*\d/.test(s), 180_000);
    if (t1Wait.suffix === null || !/R\$\s*\d/.test(t1Wait.suffix)) {
      const t1Resp = await chat1.then((r) => r).catch(() => null);
      const t1Error = t1Resp ? await readChatTurnError(t1Resp) : null;
      await failOrSkip(page, "conv-t1",
        `T1 sem grounding (saldo em R$ ausente no sufixo do turno após 180s — sufixo atual: ${describeTurnSuffix(t1Wait.suffix)})`,
        { turnText: t1Wait.suffix, turnError: t1Error });
    }
    await shot(page, "conv-01-leitura");

    // ── T2: proposta de mutação — EXIGE pergunta de categoria ───────
    // Mesmo-draft: sem categoria informada o TED deve perguntar (INT-12);
    // card direto aqui significaria categorização presumida — FALHA, pois o
    // restante do fluxo prova o caminho pergunta→bare-name→card (INT-13).
    // R5: sessão pronta antes do snapshot (nunca em "conectando…"); o
    // isolamento do turno é por identidade (snapshotTurn/turnSuffix).
    await waitForChatReady(page, "conv-t2");
    const preT2 = await snapshotTurn(page);
    const chat2 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 200_000 });
    await sendTedMessage(page, dialog, T2_TEXT);
    // R6: bolha própria no sufixo antes de aguardar a resposta; progresso
    // TURN-SCOPED — pergunta só vale no sufixo do turno, card só vale como
    // approvalId NOVO vs preT2 (nunca innerHTML/texto do diálogo inteiro,
    // que o histórico satisfaz instantaneamente — falso-vermelho do R5).
    await requireOwnBubble(page, preT2, T2_TEXT, "conv-t2");
    const t2Wait = await waitForTurnMatch(page, preT2, (s, full) =>
      /qual\s+(a\s+)?categoria/i.test(s) ||
      full.approvalIds.some((id) => !preT2.approvalIds.includes(id)),
    180_000);
    const t2SuffixForProgress = t2Wait.suffix;
    const t2HasQuestion = t2SuffixForProgress !== null && /qual\s+(a\s+)?categoria/i.test(t2SuffixForProgress);
    const t2HasNewCard = (t2Wait.full?.approvalIds ?? []).some((id) => !preT2.approvalIds.includes(id));
    const progress2 = t2HasQuestion ? "question" : t2HasNewCard ? "card" : "timeout";
    test.info().annotations.push({
      type: "conv-t2",
      description: `progresso T2 (turn-scoped): ${progress2} (sufixo atual: ${describeTurnSuffix(t2SuffixForProgress)})`,
    });
    const t2Resp = await chat2.then((r) => r).catch(() => null);
    const t2Evidence = {
      turnText: t2SuffixForProgress,
      turnError: t2Resp ? await readChatTurnError(t2Resp) : null,
    };
    if (progress2 === "timeout") {
      await failOrSkip(page, "conv-t2",
        `TED não progrediu após proposta (nem pergunta de categoria, nem card novo no sufixo do turno — sufixo atual: ${describeTurnSuffix(t2SuffixForProgress)})`,
        t2Evidence);
    }
    if (progress2 !== "question") {
      await failOrSkip(page, "conv-t2",
        `T2 produziu card direto em vez da pergunta de categoria (progresso: ${progress2}) — mesmo-draft exige o caminho pergunta→bare-name (INT-12/INT-13)`,
        t2Evidence);
    }
    // Pergunta vinculada ao turno T2 por IDENTIDADE (só conteúdo novo desde
    // o snapshot de T2 — mensagens anteriores excluídas, reidratação que
    // preserva o conjunto de ids tolerada). A pergunta deve estar DENTRO
    // deste sufixo — casar no diálogo inteiro permitiria reusar pergunta de
    // turno anterior (falso-positivo).
    const t2Question = t2Evidence.turnText;
    if (t2Question === null) {
      await failOrSkip(page, "conv-t2",
        "reidratação T2: divergência de identidade (bolha perdida ou card sumido desde o snapshot preT2) — pergunta histórica não vale",
        t2Evidence);
    }
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
    // R5: sessão pronta antes do snapshot (nunca em "conectando…").
    await waitForChatReady(page, "conv-t3");
    const preT3 = await snapshotTurn(page);
    const chat3 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 120_000 });
    await sendTedMessage(page, dialog, pick.short);
    // R6: bolha própria no sufixo antes de aguardar o card.
    await requireOwnBubble(page, preT3, pick.short, "conv-t3");
    const t3Resp = await chat3;
    const t3opId = await readPendingOpId(t3Resp);
    const t3TurnText = await readTurnSuffix(page, preT3);
    if (!t3opId) {
      await failOrSkip(page, "conv-t3", "turno T3 não emitiu pendingOperation — draft original não progrediu",
        { turnText: t3TurnText, turnError: await readChatTurnError(t3Resp) });
    }
    // R6: card TURN-SCOPED — o approvalId do turno deve surgir no snapshot
    // (nunca basta existir no diálogo inteiro: seria máscara de histórico).
    const t3CardWait = await waitForTurnMatch(page, preT3,
      (_s, full) => full.approvalIds.includes(`ted-op-${t3opId}`), 180_000);
    if (t3CardWait.suffix === null || !t3CardWait.full?.approvalIds.includes(`ted-op-${t3opId}`)) {
      await failOrSkip(page, "conv-t3",
        `card do draft original ausente no sufixo do turno após resposta curta "${pick.short}" ` +
        `(ted-op-${t3opId} nunca surgiu vs preT3 — sufixo atual: ${describeTurnSuffix(t3CardWait.suffix)})`,
        { turnText: t3CardWait.suffix, turnError: await readChatTurnError(t3Resp) });
    }
    validateNoHistoricReuse([t3opId]);
    const card = dialog.locator(`[id="ted-op-${t3opId}"]`);
    try {
      await expect(card).toBeVisible({ timeout: 180_000 });
      await expect(card.getByText(MARK, { exact: false })).toBeVisible({ timeout: 30000 });
    } catch {
      const afterText = await readTurnSuffix(page, preT3);
      const afterTextForMatch = afterText ?? "";
      const sameQuestion = /qual\s+(a\s+)?categoria/i.test(afterTextForMatch) &&
        t2Question.split(/qual\s+(a\s+)?categoria/i)[1]?.slice(0, 80) ===
        afterTextForMatch.split(/qual\s+(a\s+)?categoria/i)[1]?.slice(0, 80);
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
    // R6: o wait de decision é inerentemente TURN-SCOPED (URL contém o
    // operationId do turno T3 — resposta de outro turno/run nunca satisfaz).
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
    // Ordem item/marker é composição do produto (ex.: "com carne <MARK>") —
    // o contrato é conter AMBOS, em qualquer ordem.
    expect(marked![0]!.description).toContain(MARK);
    expect(marked![0]!.description).toContain(pick.item);
    expect(marked![0]!.categoryId, `categoryId do TX (${marked![0]!.categoryId}) != categoria de T3 (${expectedCategoryId})`).toBe(expectedCategoryId);
    test.info().annotations.push({ type: "conv-t5", description: `mesmo-draft confirmado: op ${operationId} tx ${tedTxId} cat ${expectedCategoryId}` });
    await shot(page, "conv-05-confirmacao");

    // ── T4: NEGAÇÃO num segundo draft — "não confirmo" não executa ───
    // A negação roda DEPOIS da confirmação do draft original (negar o
    // próprio card do T3 o cancelaria e inviabilizaria o mesmo-draft).
    // Jornada negar→cancelar (INT-22) num draft próprio: zero escrita nova.
    // R5: sessão pronta antes do snapshot (nunca em "conectando…").
    await waitForChatReady(page, "conv-t4");
    const preT4 = await snapshotTurn(page);
    const chat4 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 120_000 });
    await sendTedMessage(page, dialog, T4_TEXT);
    // R6: bolha própria no sufixo antes de aguardar o card.
    await requireOwnBubble(page, preT4, T4_TEXT, "conv-t4");
    const t4Resp = await chat4;
    const t4opId = await readPendingOpId(t4Resp);
    if (!t4opId) {
      await failOrSkip(page, "conv-t4", "turno T4 não emitiu pendingOperation — draft da negação não progrediu",
        { turnText: await readTurnSuffix(page, preT4), turnError: await readChatTurnError(t4Resp) });
    }
    // R6: card TURN-SCOPED — approvalId novo vs preT4 (id do turno; o
    // expect estrutural abaixo confirma a visibilidade do mesmo id).
    const t4CardWait = await waitForTurnMatch(page, preT4,
      (_s, full) => full.approvalIds.includes(`ted-op-${t4opId}`), 180_000);
    if (t4CardWait.suffix === null || !t4CardWait.full?.approvalIds.includes(`ted-op-${t4opId}`)) {
      await failOrSkip(page, "conv-t4",
        `card do draft da negação ausente no sufixo do turno (ted-op-${t4opId} nunca surgiu vs preT4 — ` +
        `sufixo atual: ${describeTurnSuffix(t4CardWait.suffix)})`,
        { turnText: t4CardWait.suffix, turnError: await readChatTurnError(t4Resp) });
    }
    validateNoHistoricReuse([t4opId]);
    expect(t4opId, "draft da negação reutilizou o operationId do draft original").not.toBe(operationId);
    const card4 = dialog.locator(`[id="ted-op-${t4opId}"]`);
    try {
      await expect(card4).toBeVisible({ timeout: 180_000 });
    } catch {
      await failOrSkip(page, "conv-t4", `card do draft da negação ausente (ted-op-${t4opId})`,
        { turnText: await readTurnSuffix(page, preT4), turnError: await readChatTurnError(t4Resp) });
    }
    const before = await countTxByMark(page);
    expect(before, "contagem pré-negação divergiu do TX do draft original").toBe(1);
    const denyChat = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 120_000 });
    // R5: sessão pronta antes do envio (nunca em "conectando…").
    await waitForChatReady(page, "conv-t4-deny");
    await sendTedMessage(page, dialog, "não confirmo");
    // R6: bolha própria da negação no sufixo (ancorada em preT4, que cobre
    // todo o draft da negação) antes de avaliar o vínculo estruturado.
    await requireOwnBubble(page, preT4, "não confirmo", "conv-t4");
    const denyResp = await denyChat;
    // Contrato real da decisão (agent-client pendingDecisionSchema):
    // { operationId, status, retryable?, receipt? } — SEM objeto
    // pendingOperation. cancelled/failed/proposed/expired não têm recibo.
    const denyBody = await denyResp.json().catch(() => ({})) as {
      status?: unknown; output?: unknown; operationId?: unknown;
    };
    // Estado terminal cancelled do draft da negação, VINCULADO ao t4opId
    // pela resposta estruturada (operationId + status). Cópia textual
    // ("Operação cancelada") sozinha NÃO basta — sem vínculo estruturado ao
    // t4opId, FALHA (ou SKIP INCONCLUSIVE com sinal de provider).
    if (denyBody.operationId !== t4opId) {
      await failOrSkip(page, "conv-t4",
        `negação sem vínculo estruturado ao draft ${t4opId} (operationId ausente ou divergente) — texto sozinho não prova cancelamento`,
        { turnText: await readTurnSuffix(page, preT4), turnError: await readChatTurnError(denyResp) });
    }
    expect(denyBody.status, `draft da negação ${t4opId} sem estado terminal cancelled`).toBe("cancelled");
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
    expect(afterDenyMarked![0]!.description).toContain(MARK);
    expect(afterDenyMarked![0]!.description).toContain(pick.item);
    expect(afterDenyMarked![0]!.categoryId, "negação alterou a categoria do TX original").toBe(expectedCategoryId);
    await shot(page, "conv-04-negacao");

    // ── T5b: RELOAD — histórico persiste (user + TED, sem sumiço) ────
    await page.goto("/ted", { waitUntil: "domcontentloaded" });
    const dialog2 = page.getByRole("region", { name: /chat com ted/i });
    await expect(dialog2).toBeVisible({ timeout: 15000 });
    // R5: aguarda hidratação completa antes de asseverar as bolhas.
    // R6: T5b é intencionalmente checagem de PERSISTÊNCIA pós-reload
    // (histórico esperado — não há "turno corrente" após reload). Âncoras
    // de identidade do run: T2_TEXT e T4_TEXT carregam o MARK com RUN_ID
    // (outro run nunca os satisfaz; pre-flight já barrou resíduo alheio).
    await waitForChatReady(page, "conv-t5b");
    for (const bubble of [T2_TEXT, pick.short, T4_TEXT, "não confirmo"]) {
      await expect(dialog2.getByText(bubble, { exact: true }).first()).toBeVisible({ timeout: 30000 });
    }
    await shot(page, "conv-05b-historico");

    // ── T6: DESFAZER via TED (vinculado ao TX correto) ───────────────
    // O único TX com o marker é o do draft original (o draft da negação
    // foi cancelado sem escrever): zerar a contagem prova que o undo
    // atingiu o TX certo (tedTxId).
    // R5: sessão pronta antes do envio (nunca em "conectando…").
    // R6: snapshot pré-turno + bolha própria no sufixo + wait TURN-SCOPED
    // por undo-item NOVO vs preT6 (contagem no snapshot — item
    // pré-snapshot/histórico nunca satisfaz; pre-flight já garante zero
    // undos alheios na entrada).
    await waitForChatReady(page, "conv-t6");
    const preT6 = await snapshotTurn(page);
    const T6_TEXT = "desfazer a última ação";
    await sendTedMessage(page, dialog2, T6_TEXT);
    await requireOwnBubble(page, preT6, T6_TEXT, "conv-t6");
    const t6Wait = await waitForTurnMatch(page, preT6, (_s, full) => full.undos > preT6.undos, 120_000);
    if (t6Wait.suffix === null || !(t6Wait.full && t6Wait.full.undos > preT6.undos)) {
      const t6Text = t6Wait.suffix;
      await failOrSkip(page, "conv-t6",
        `card de undo ausente no sufixo do turno após 120s (undos: preT6=${preT6.undos} atual=${t6Wait.full?.undos ?? "?"} — ` +
        `sufixo atual: ${describeTurnSuffix(t6Text)})`,
        { turnText: t6Text, turnError: null });
    }
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
