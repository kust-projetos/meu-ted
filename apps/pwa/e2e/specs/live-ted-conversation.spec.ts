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
 * (histórico esperado — âncoras de identidade do run preservadas).
  *
  * R7 (fix #178 - cardinalidade + snapshot estável; SUBSTITUI o
  * turnSuffix/multiset da R6): o run live R6 foi falso-vermelho em T4 -
  * requireOwnBubble("não confirmo") falhou com divergência de identidade
  * embora o deny tivesse sido processado ("Operação cancelada com
  * segurança." renderizada): churn histórico (reidratação removendo bolha
  * antiga) invalida QUALQUER sufixo por subtração, e waits de texto sofrem
  * do mesmo mal. Novo modelo (só-teste): (a) stableSnapshot -
  * waitForChatReady + 2 leituras com 2s de intervalo e multisets de bolhas
  * (+approvalIds) IGUAIS (até 3 pares; instável = fail/skip com
  * diagnóstico, nunca usa snapshot em carregamento); (b) requireOwnBubble
  * por CARDINALIDADE - conta ocorrências de ownText no `before` estável e
  * aguarda o incremento (vale para MARK único e para "não confirmo"
  * não-único); timeout = FAIL "bolha própria perdida"; (c) sinais de TEXTO
  * (R$ T1, pergunta T2) por cardinalidade de ocorrências, sem exigir
  * multiset intacto; texto da pergunta = ÚLTIMA bolha-pergunta em ordem
  * DOM (message-list é cronológica - TedChat.tsx rende `messages` em ordem
  * do array = histórico do servidor em ordem de log + otimistas ao fim);
  * (d) anti-loop same-question T3 preservado sobre pergunta NOVA desde
  * preT3 (contagem maior), comparando a cauda com a pergunta de T2;
  * (e) card-waits por id, recibo incondicional, T4 cancelled vinculado por
  * operationId, teardown fail-high e INCONCLUSIVE só estruturado:
  * tudo preservado. */
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
    const workspaceSelector = page.getByRole("button", { name: "Selecionar espaço" });
    if (await workspaceSelector.getAttribute("aria-expanded") === "true") {
      await workspaceSelector.press("Escape");
      await expect(workspaceSelector).not.toHaveAttribute("aria-expanded", "true", { timeout: 10000 });
    }
    const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
    await expect(launcher).toBeVisible({ timeout: 20000 });
    await launcher.click();
    try {
      await page.waitForURL(/\/ted/, { timeout: 60_000 });
    } catch (error) {
      const currentUrl = page.url();
      const launcherVisible = await launcher.isVisible().catch(() => false);
      throw new Error(
        `Navegação para TED expirou; URL atual: ${currentUrl}; launcher ainda visível: ${launcherVisible}; ` +
        "clique sem efeito — ver dropdown/overlay",
        { cause: error },
      );
    }
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
    // Disciplina do turno: SOMENTE a evidência do turno corrente classifica
    // SKIP. Evidência ausente (snapshot ilegível) FALHA fechado com
    // diagnóstico — nunca lê o chat inteiro, cujo conteúdo
    // histórico produziria SKIP INCONCLUSIVE ou PASS indevido.
    const text = evidence?.turnText;
    if (text == null) {
      throw new Error(`${failMessage} (snapshot ilegível — evidência do turno indisponível)`);
    }
    if (PROVIDER_DOWN_RE.test(text)) {
      test.info().annotations.push({ type: context, description: `INCONCLUSIVE (sem provider/relay/modelo autorizado): ${failMessage}` });
      test.skip(true, `INCONCLUSIVE (sem provider/relay/modelo autorizado) em ${context}: ${failMessage}`);
    }
    throw new Error(failMessage);
  };

  // (R7) O vínculo pergunta/resposta ao turno corrente é por cardinalidade
  // (waitForBubbleGrowth) + snapshot estável (stableSnapshot) — ver bloco R7
  // abaixo. Fail-closed: evidência do turno é best-effort (newBubbleText),
  // nunca o chat inteiro, que admitiria pergunta histórica (falso-positivo)
  // ou texto de provider histórico (falso INCONCLUSIVE).

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

  // R7 (fix #178): isolamento de turno por CARDINALIDADE + snapshot
  // estável — SUBSTITUI o modelo de subtração-multiset (turnSuffix removido).
  // O run real mostrou que QUALQUER perda histórica invalida o sufixo
  // inteiro: requireOwnBubble("não confirmo") falhou com divergência embora
  // o deny tivesse sido processado ("Operação cancelada com segurança."
  // renderizada), e waits de texto sofrem do mesmo mal. Novo modelo:
  // (a) snapshot pré-turno ESTÁVEL (stableSnapshot: waitForChatReady + até 3
  // pares de leituras com 2s de intervalo e multisets de bolhas +
  // approvalIds IGUAIS; instável = snapshot em carregamento, recusado com
  // fail/skip e diagnóstico, nunca usado); (b) progresso = CRESCIMENTO de
  // contagem vs o `before` estável (bolha própria, sinal de texto,
  // undo-item) — perda histórica apenas reduz a base, nunca invalida o
  // turno; (c) texto da pergunta = ÚLTIMA bolha-pergunta em ordem DOM. A
  // ordem DOM é cronológica: TedChat.tsx renderiza `messages` em ordem do
  // array (`messages.map`), e o array é o histórico do servidor em ordem de
  // log (`fetchAgentHistory` → itens de `/rpc/history`, ordem preservada)
  // + otimistas locais anexados ao fim — logo a pergunta do turno corrente
  // é a mais recente. Card-waits seguem por approvalId único (R6, intocado:
  // histórico jamais contém o id, churn apenas adia a detecção). Nota: o
  // assert whole-dialog de sendTedMessage pode ser satisfeito por histórico
  // — inofensivo, pois requireOwnBubble aguarda o INCREMENTO da contagem.
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

  const sameMultiset = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  };

  const snapshotsEqual = (a: TurnSnapshot, b: TurnSnapshot): boolean =>
    sameMultiset(a.bubbles, b.bubbles) &&
    sameMultiset(a.approvalIds, b.approvalIds) &&
    a.undos === b.undos;

  // R7: snapshot pré-turno estável — recusa snapshot em carregamento. Até 3
  // pares de leituras com 2s de intervalo (multisets order-insensitive);
  // instável nas 3 tentativas = SKIP INCONCLUSIVE com sinal de provider,
  // senão FAIL fechado com diagnóstico (nunca usa snapshot em mutação).
  const STABLE_SNAPSHOT_ATTEMPTS = 3;
  const stableSnapshot = async (page: Page, context: string): Promise<TurnSnapshot> => {
    await waitForChatReady(page, context);
    let prev = await snapshotTurn(page);
    let cur = prev;
    for (let attempt = 0; attempt < STABLE_SNAPSHOT_ATTEMPTS; attempt++) {
      await page.waitForTimeout(2000);
      cur = await snapshotTurn(page);
      if (snapshotsEqual(prev, cur)) return cur;
      prev = cur;
    }
    if (PROVIDER_DOWN_RE.test(cur.text)) {
      test.info().annotations.push({ type: context, description: `INCONCLUSIVE (chat nunca estabilizou, com sinal de provider): ${cur.text.slice(0, 300)}` });
      test.skip(true, `INCONCLUSIVE (chat nunca estabilizou) em ${context}`);
      throw new Error("unreachable: skip não abortou o turno");
    }
    throw new Error(
      `${context}: snapshot pré-turno instável após ${STABLE_SNAPSHOT_ATTEMPTS} pares de leituras ` +
      `(bolhas ${prev.bubbles.length}→${cur.bubbles.length}, cards ${prev.approvalIds.length}→${cur.approvalIds.length}) — ` +
      `snapshot em carregamento recusado (nunca usado para isolar turno)`,
    );
  };

  const countMatching = (bubbles: string[], re: RegExp): number =>
    bubbles.reduce((n, b) => n + (re.test(b) ? 1 : 0), 0);

  // Pergunta de categoria do TED (INT-12) — âncora textual dos turnos T2/T3.
  const CATEGORY_QUESTION_RE = /qual\s+(a\s+)?categoria/i;

  // R6 (fix #178): waits de progresso TURN-SCOPED por cardinalidade (R7).
  // Todo sinal de progresso (bolha própria, R$, pergunta de categoria, card,
  // undo) é aguardado como CRESCIMENTO de contagem vs o snapshot estável
  // pré-turno — NENHUM wait exige o multiset intacto, de modo que churn
  // histórico (bolha antiga removida pela reidratação) apenas reduz a base
  // sem invalidar o turno. Timeout devolve o último estado para diagnóstico
  // via failOrSkip — nunca lê o chat inteiro como evidência.
  const TURN_SIGNAL_TIMEOUT_MS = 180_000;
  const OWN_BUBBLE_TIMEOUT_MS = 30_000;

  const describeEvidence = (evidence: string | null, max = 800): string =>
    evidence === null
      ? "<evidência indisponível: snapshot ilegível>"
      : JSON.stringify(evidence.slice(-max));

  // R7: poll genérico de crescimento de contagem vs `before` estável.
  const waitForBubbleGrowth = async (
    page: Page,
    before: TurnSnapshot,
    predicate: (bubble: string) => boolean,
    timeoutMs: number,
  ): Promise<{ full: TurnSnapshot | null; base: number; current: number }> => {
    const base = before.bubbles.filter(predicate).length;
    const deadline = Date.now() + timeoutMs;
    let full: TurnSnapshot | null = null;
    let current = base;
    for (;;) {
      full = await snapshotTurn(page).catch(() => null);
      if (full) {
        current = full.bubbles.filter(predicate).length;
        if (current > base) return { full, base, current };
      }
      if (Date.now() >= deadline) return { full, base, current };
      await page.waitForTimeout(1000);
    }
  };

  // R7: última bolha em ordem DOM que casa o sinal (DOM cronológico — ver
  // nota R7 acima): a pergunta do turno corrente é a mais recente, mesmo
  // com histórico rico de perguntas idênticas de runs anteriores.
  const lastMatch = (full: TurnSnapshot, re: RegExp): string | null => {
    let out: string | null = null;
    for (const b of full.bubbles) {
      if (re.test(b)) out = b;
    }
    return out;
  };

  // R7: evidência textual best-effort do turno (para failOrSkip): resto da
  // subtração-multiset quando o `before` segue intacto; com churn
  // histórico, as últimas bolhas em ordem DOM (o conteúdo novo é o mais
  // recente). Null SOMENTE se o snapshot atual falhar — nunca o chat
  // inteiro, cujo conteúdo histórico geraria falso INCONCLUSIVE ou PASS.
  const newBubbleText = (full: TurnSnapshot, before: TurnSnapshot): string => {
    const remaining = [...full.bubbles];
    let intact = true;
    for (const b of before.bubbles) {
      const i = remaining.indexOf(b);
      if (i === -1) { intact = false; break; }
      remaining.splice(i, 1);
    }
    if (intact) return remaining.join("\n");
    return full.bubbles.slice(-3).join("\n");
  };

  const readNewText = async (page: Page, before: TurnSnapshot): Promise<string | null> =>
    snapshotTurn(page).then((snap) => newBubbleText(snap, before)).catch(() => null);

  // Subconjunto-multiset: SÓ diagnóstico de churn (nunca invalida turno no
  // modelo R7 — o card-wait por id é imune a churn por construção).
  const beforeKept = (full: TurnSnapshot, before: TurnSnapshot): boolean => {
    const remaining = [...full.bubbles];
    for (const b of before.bubbles) {
      const i = remaining.indexOf(b);
      if (i === -1) return false;
      remaining.splice(i, 1);
    }
    return before.approvalIds.every((id) => full.approvalIds.includes(id));
  };

  // Espera por approvalId ÚNICO (UUID v4 por operação): NÃO exige multiset
  // intacto — histórico jamais contém esse id, então churn de bolhas/cards
  // antigos (divergência de identidade) apenas adia a detecção, nunca a
  // invalida. Sinais de TEXTO usam cardinalidade (waitForBubbleGrowth).
  // Retorna os ids visíveis para diagnóstico.
  const waitForNewCardId = async (
    page: Page,
    before: TurnSnapshot,
    cardId: string,
    timeoutMs = TURN_SIGNAL_TIMEOUT_MS,
  ): Promise<{ found: boolean; approvalIds: string[]; diverged: boolean }> => {
    const deadline = Date.now() + timeoutMs;
    let ids: string[] = [];
    let diverged = false;
    for (;;) {
      const full = await snapshotTurn(page).catch(() => null);
      if (full) {
        ids = full.approvalIds;
        if (ids.includes(cardId)) return { found: true, approvalIds: ids, diverged };
        if (!beforeKept(full, before)) diverged = true;
      }
      if (Date.now() >= deadline) return { found: false, approvalIds: ids, diverged };
      await page.waitForTimeout(1000);
    }
  };
  // R7: após cada envio, exigir a bolha PRÓPRIA por cardinalidade antes de
  // aguardar a resposta — conta ocorrências de ownText no `before` estável
  // e aguarda o incremento. Vale para textos únicos (MARK) e não-únicos
  // ("não confirmo"): só o aumento da contagem prova a NOSSA bolha. Bolha
  // própria sem incremento = FAIL explícito "bolha própria perdida" (bug
  // #169 ressurgido) — nunca mascarado como timeout de progresso nem
  // convertido em SKIP.
  const requireOwnBubble = async (
    page: Page,
    before: TurnSnapshot,
    ownText: string,
    context: string,
    timeoutMs = OWN_BUBBLE_TIMEOUT_MS,
  ): Promise<TurnSnapshot> => {
    const { full, base, current } = await waitForBubbleGrowth(page, before, (b) => b.includes(ownText), timeoutMs);
    if (full && current > base) return full;
    throw new Error(
      `${context}: bolha própria perdida após envio ("${ownText.slice(0, 120)}") — ` +
      `bug #169 ressurgido, sem mascaramento (ocorrências: antes=${base} agora=${current}; ` +
      `bolhas visíveis: ${full ? full.bubbles.length : "snapshot ilegível"})`,
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
    const workspaceSelector = page.getByRole("button", { name: "Selecionar espaço" });
    await workspaceSelector.click();
    const testFamilyOption = page.getByRole("option", { name: /Test Family/ });
    try {
      await testFamilyOption.click({ timeout: 60_000 });
    } catch (error) {
      const currentUrl = page.url();
      const dropdownExpanded = await workspaceSelector.getAttribute("aria-expanded").catch(() => null);
      const visibleOptions = await page.getByRole("option").all()
        .then(async (options) => Promise.all(options.map(async (option) => {
          if (!await option.isVisible().catch(() => false)) return null;
          return (await option.innerText().catch(() => "")).trim();
        })))
        .then((options) => options.filter((name): name is string => Boolean(name)));
      throw new Error(
        `Seleção de workspace expirou; URL atual: ${currentUrl}; dropdown aberto (aria-expanded): ${dropdownExpanded}; ` +
        `options visíveis: ${JSON.stringify(visibleOptions)}; opção Test Family ausente — ver membership do admin`,
        { cause: error },
      );
    }
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
    // R7: snapshot estável + bolha própria por cardinalidade + sinal R$
    // por cardinalidade (nova ocorrência no turno — R$ histórico nunca
    // satisfaz; churn histórico nunca invalida).
    const preT1 = await stableSnapshot(page, "conv-t1");
    const chat1 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 200_000 });
    const T1_TEXT = "Qual o saldo total das minhas contas hoje? Responda citando o valor em reais.";
    await sendTedMessage(page, dialog, T1_TEXT);
    // R7: bolha própria por cardinalidade antes de aguardar a resposta;
    // progresso TURN-SCOPED por cardinalidade (R$ novo no turno).
    await requireOwnBubble(page, preT1, T1_TEXT, "conv-t1");
    const t1Wait = await waitForBubbleGrowth(page, preT1, (b) => /R\$\s*\d/.test(b), 180_000);
    const t1Evidence = t1Wait.full ? newBubbleText(t1Wait.full, preT1) : null;
    if (!(t1Wait.full && t1Wait.current > t1Wait.base)) {
      const t1Resp = await chat1.then((r) => r).catch(() => null);
      const t1Error = t1Resp ? await readChatTurnError(t1Resp) : null;
      await failOrSkip(page, "conv-t1",
        `T1 sem grounding (saldo em R$ ausente no turno após 180s — ocorrências R$: antes=${t1Wait.base} agora=${t1Wait.current}; ` +
        `evidência do turno: ${describeEvidence(t1Evidence)})`,
        { turnText: t1Evidence, turnError: t1Error });
    }
    await shot(page, "conv-01-leitura");

    // ── T2: proposta de mutação — EXIGE pergunta de categoria ───────
    // Mesmo-draft: sem categoria informada o TED deve perguntar (INT-12);
    // card direto aqui significaria categorização presumida — FALHA, pois o
    // restante do fluxo prova o caminho pergunta→bare-name→card (INT-13).
    // R7: snapshot estável; o isolamento do turno é por cardinalidade
    // (contagens vs o `before` estável — churn histórico nunca invalida).
    const preT2 = await stableSnapshot(page, "conv-t2");
    const chat2 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 200_000 });
    await sendTedMessage(page, dialog, T2_TEXT);
    // R7: bolha própria por cardinalidade antes de aguardar a resposta;
    // progresso TURN-SCOPED por cardinalidade — pergunta NOVA (contagem de
    // bolhas-pergunta maior que no `before`) ou approvalId NOVO vs preT2
    // (nunca texto do diálogo inteiro, que o histórico satisfaz
    // instantaneamente — falso-vermelho do R5).
    await requireOwnBubble(page, preT2, T2_TEXT, "conv-t2");
    const qBaseT2 = countMatching(preT2.bubbles, CATEGORY_QUESTION_RE);
    const t2Deadline = Date.now() + 180_000;
    let t2Full: TurnSnapshot | null = null;
    let t2Questions = qBaseT2;
    let t2NewCards: string[] = [];
    for (;;) {
      t2Full = await snapshotTurn(page).catch(() => null);
      if (t2Full) {
        t2Questions = countMatching(t2Full.bubbles, CATEGORY_QUESTION_RE);
        t2NewCards = t2Full.approvalIds.filter((id) => !preT2.approvalIds.includes(id));
        if (t2Questions > qBaseT2 || t2NewCards.length > 0) break;
      }
      if (Date.now() >= t2Deadline) break;
      await page.waitForTimeout(1000);
    }
    const t2EvidenceText = t2Full ? newBubbleText(t2Full, preT2) : null;
    const t2HasQuestion = t2Full !== null && t2Questions > qBaseT2;
    const t2HasNewCard = t2NewCards.length > 0;
    const progress2 = t2HasQuestion ? "question" : t2HasNewCard ? "card" : "timeout";
    test.info().annotations.push({
      type: "conv-t2",
      description: `progresso T2 (turn-scoped, cardinalidade): ${progress2} ` +
        `(perguntas: antes=${qBaseT2} agora=${t2Questions}; cards novos: ${t2NewCards.join(",") || "nenhum"}; ` +
        `evidência do turno: ${describeEvidence(t2EvidenceText)})`,
    });
    const t2Resp = await chat2.then((r) => r).catch(() => null);
    const t2Evidence = {
      turnText: t2EvidenceText,
      turnError: t2Resp ? await readChatTurnError(t2Resp) : null,
    };
    if (progress2 === "timeout") {
      await failOrSkip(page, "conv-t2",
        `TED não progrediu após proposta (nem pergunta nova de categoria, nem card novo no turno — ` +
        `perguntas: antes=${qBaseT2} agora=${t2Questions}; evidência do turno: ${describeEvidence(t2EvidenceText)})`,
        t2Evidence);
    }
    if (progress2 !== "question") {
      await failOrSkip(page, "conv-t2",
        `T2 produziu card direto em vez da pergunta de categoria (progresso: ${progress2}) — mesmo-draft exige o caminho pergunta→bare-name (INT-12/INT-13)`,
        t2Evidence);
    }
    // Pergunta vinculada ao turno T2: ÚLTIMA bolha-pergunta em ordem DOM
    // (cronológica — a do turno corrente é a mais recente). Casar no
    // diálogo inteiro sem âncora permitiria reusar pergunta de turno
    // anterior (falso-positivo); a âncora aqui é cardinalidade + recência.
    const t2Question = t2Full ? lastMatch(t2Full, CATEGORY_QUESTION_RE) : null;
    if (!t2Question || !CATEGORY_QUESTION_RE.test(t2Question)) {
      await failOrSkip(page, "conv-t2",
        "pergunta de categoria ausente no turno T2 (só a última bolha-pergunta do turno vale)",
        t2Evidence);
    }
    await shot(page, "conv-02-proposta");

    // ── T3: resposta curta de categoria — EXPECT DURO no card ───────
    // Binding autoritativo: o id da pendingOperation do TURNO T3 (nunca o
    // primeiro card com MARK, nunca stale de outro run). Loop de pergunta
    // idêntica FALHA em vez de passar adiante.
    // R7: snapshot estável antes do envio (nunca em "conectando…").
    const preT3 = await stableSnapshot(page, "conv-t3");
    const chat3 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 120_000 });
    await sendTedMessage(page, dialog, pick.short);
    // R7: bolha própria por cardinalidade antes de aguardar o card.
    await requireOwnBubble(page, preT3, pick.short, "conv-t3");
    const t3Resp = await chat3;
    const t3opId = await readPendingOpId(t3Resp);
    const t3TurnText = await readNewText(page, preT3);
    if (!t3opId) {
      await failOrSkip(page, "conv-t3", "turno T3 não emitiu pendingOperation — draft original não progrediu",
        { turnText: t3TurnText, turnError: await readChatTurnError(t3Resp) });
    }
    // Card por ID ÚNICO (nunca máscara de histórico; churn apenas adia).
    const t3CardWait = await waitForNewCardId(page, preT3, `ted-op-${t3opId}`, 180_000);
    if (!t3CardWait.found) {
      await failOrSkip(page, "conv-t3",
        `card do draft original ausente após resposta curta "${pick.short}" ` +
        `(ted-op-${t3opId} nunca surgiu em 180s — ids visíveis: ${t3CardWait.approvalIds.join(",") || "nenhum"}; churn histórico: ${t3CardWait.diverged})`,
        { turnText: await readNewText(page, preT3), turnError: await readChatTurnError(t3Resp) });
    }
    validateNoHistoricReuse([t3opId]);
    const card = dialog.locator(`[id="ted-op-${t3opId}"]`);
    try {
      await expect(card).toBeVisible({ timeout: 180_000 });
      await expect(card.getByText(MARK, { exact: false })).toBeVisible({ timeout: 30000 });
    } catch {
      // Anti-loop same-question (R7, preservado): SÓ pergunta NOVA desde
      // preT3 (contagem maior que no `before`) conta como repetição —
      // pergunta histórica nunca acusa loop. Compara a cauda da pergunta
      // nova com a cauda da pergunta de T2 (extraída como última
      // bolha-pergunta do turno T2).
      const qBaseT3 = countMatching(preT3.bubbles, CATEGORY_QUESTION_RE);
      const afterFull = await snapshotTurn(page).catch(() => null);
      const afterQuestions = afterFull ? countMatching(afterFull.bubbles, CATEGORY_QUESTION_RE) : qBaseT3;
      const newQuestion = afterFull && afterQuestions > qBaseT3 ? lastMatch(afterFull, CATEGORY_QUESTION_RE) : null;
      const tail = (q: string) => q.split(CATEGORY_QUESTION_RE)[1]?.slice(0, 80);
      const sameQuestion = newQuestion !== null && tail(newQuestion) === tail(t2Question);
      await failOrSkip(page, "conv-t3",
        sameQuestion
          ? `TED repetiu a MESMA pergunta de categoria após a resposta curta "${pick.short}" (loop) — card ted-op-${t3opId} ausente`
          : `card do draft original ausente após resposta curta "${pick.short}" (ted-op-${t3opId} sem MARK visível em 180s)`,
        { turnText: afterFull ? newBubbleText(afterFull, preT3) : null, turnError: await readChatTurnError(t3Resp) });
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
    // R7: snapshot estável (nunca em "conectando…").
    const preT4 = await stableSnapshot(page, "conv-t4");
    const chat4 = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 120_000 });
    await sendTedMessage(page, dialog, T4_TEXT);
    // R7: bolha própria por cardinalidade antes de aguardar o card.
    await requireOwnBubble(page, preT4, T4_TEXT, "conv-t4");
    const t4Resp = await chat4;
    const t4opId = await readPendingOpId(t4Resp);
    if (!t4opId) {
      await failOrSkip(page, "conv-t4", "turno T4 não emitiu pendingOperation — draft da negação não progrediu",
        { turnText: await readNewText(page, preT4), turnError: await readChatTurnError(t4Resp) });
    }
    // Card por ID ÚNICO (nunca máscara de histórico; churn apenas adia).
    const t4CardWait = await waitForNewCardId(page, preT4, `ted-op-${t4opId}`, 180_000);
    if (!t4CardWait.found) {
      await failOrSkip(page, "conv-t4",
        `card do draft da negação ausente (ted-op-${t4opId} nunca surgiu em 180s — ` +
        `ids visíveis: ${t4CardWait.approvalIds.join(",") || "nenhum"}; churn histórico: ${t4CardWait.diverged})`,
        { turnText: await readNewText(page, preT4), turnError: await readChatTurnError(t4Resp) });
    }
    validateNoHistoricReuse([t4opId]);
    expect(t4opId, "draft da negação reutilizou o operationId do draft original").not.toBe(operationId);
    const card4 = dialog.locator(`[id="ted-op-${t4opId}"]`);
    try {
      await expect(card4).toBeVisible({ timeout: 180_000 });
    } catch {
      await failOrSkip(page, "conv-t4", `card do draft da negação ausente (ted-op-${t4opId})`,
        { turnText: await readNewText(page, preT4), turnError: await readChatTurnError(t4Resp) });
    }
    const before = await countTxByMark(page);
    expect(before, "contagem pré-negação divergiu do TX do draft original").toBe(1);
    const denyChat = page.waitForResponse(
      (r) => r.request().method() === "POST" && chatPath(r.url()), { timeout: 120_000 });
    // R5: sessão pronta antes do envio (nunca em "conectando…").
    await waitForChatReady(page, "conv-t4-deny");
    await sendTedMessage(page, dialog, "não confirmo");
    // R7: bolha própria da negação por cardinalidade (ancorada em preT4,
    // que cobre todo o draft da negação — "não confirmo" pode existir no
    // histórico; só o INCREMENTO prova a nossa) antes de avaliar o vínculo
    // estruturado.
    await requireOwnBubble(page, preT4, "não confirmo", "conv-t4");
    const denyResp = await denyChat;
    const denyTurnError = await readChatTurnError(denyResp);
    // Contrato real do turno de chat no cancelamento: a resposta é
    // {status:'completed', output:'Operação cancelada com segurança.'} —
    // SEM mutation/pendingOperation (runCancelTurn não materializa mutation
    // por desenho) e SEM operationId. O vínculo ao t4opId vem de três
    // evidências independentes: (1) texto de cancelamento NOVO no turno
    // (cardinalidade — histórico não conta); (2) o card ted-op-<t4opId>,
    // presente e visível acima, some da lista autoritativa (só terminal
    // sai da lista); (3) ledger inalterado abaixo.
    const cancelGrowth = await waitForBubbleGrowth(page, preT4,
      (b) => /opera[çc][aã]o cancelada/i.test(b), 120_000);
    if (cancelGrowth.current <= cancelGrowth.base) {
      await failOrSkip(page, "conv-t4",
        "turno de negação sem confirmação textual de cancelamento (contagem inalterada)",
        { turnText: await readNewText(page, preT4), turnError: denyTurnError });
    }
    const cardGoneDeadline = Date.now() + 60_000;
    let cardGone = false;
    let lastIds: string[] = [];
    for (;;) {
      const snap = await snapshotTurn(page).catch(() => null);
      if (snap) {
        lastIds = snap.approvalIds;
        if (!lastIds.includes(`ted-op-${t4opId}`)) { cardGone = true; break; }
      }
      if (Date.now() >= cardGoneDeadline) break;
      await page.waitForTimeout(1000);
    }
    if (!cardGone) {
      await failOrSkip(page, "conv-t4",
        `card do draft negado segue acionável após cancelamento (ted-op-${t4opId} ainda listado — ` +
        `ids visíveis: ${lastIds.join(",") || "nenhum"})`,
        { turnText: await readNewText(page, preT4), turnError: denyTurnError });
    }
    validateNoHistoricReuse([JSON.stringify(await denyResp.json().catch(() => ({}))).slice(0, 4000)]);
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
    // R7: snapshot estável antes do envio (nunca em "conectando…") +
    // bolha própria por cardinalidade + wait TURN-SCOPED por cardinalidade
    // de undo-item NOVO vs preT6 (item pré-snapshot/histórico nunca
    // satisfaz; pre-flight já garante zero undos alheios na entrada).
    const preT6 = await stableSnapshot(page, "conv-t6");
    const T6_TEXT = "desfazer a última ação";
    await sendTedMessage(page, dialog2, T6_TEXT);
    await requireOwnBubble(page, preT6, T6_TEXT, "conv-t6");
    const t6Deadline = Date.now() + 120_000;
    let t6Full: TurnSnapshot | null = null;
    for (;;) {
      t6Full = await snapshotTurn(page).catch(() => null);
      if (t6Full && t6Full.undos > preT6.undos) break;
      if (Date.now() >= t6Deadline) break;
      await page.waitForTimeout(1000);
    }
    const t6Evidence = t6Full ? newBubbleText(t6Full, preT6) : null;
    if (!(t6Full && t6Full.undos > preT6.undos)) {
      await failOrSkip(page, "conv-t6",
        `card de undo ausente no turno após 120s (undo-items: preT6=${preT6.undos} atual=${t6Full?.undos ?? "?"} — ` +
        `evidência do turno: ${describeEvidence(t6Evidence)})`,
        { turnText: t6Evidence, turnError: null });
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
