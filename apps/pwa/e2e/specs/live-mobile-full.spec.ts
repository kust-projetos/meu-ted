/**
 * Live MOBILE E2E — jornada completa do PWA em produção (viewport 390x844).
 *
 * Cobre: login real (AuthGate), criação de conta, criação de transação pelo
 * sheet, extrato, chat TED com grounding sobre dados reais, fluxo de mutação
 * TED com card de aprovação e navegação entre abas — tudo em viewport mobile.
 *
 * Opt-in: PWA_LIVE_E2E=1 + PWA_LIVE_ADMIN_EMAIL + PWA_LIVE_ADMIN_PASSWORD.
 * Marca "Teste E2E" nos dados criados para identificação/limpeza.
 */
import { test, expect, type Page, type Request } from "@playwright/test";

const LIVE = process.env.PWA_LIVE_E2E === "1";
const EMAIL = process.env.PWA_LIVE_ADMIN_EMAIL || "";
const PASSWORD = process.env.PWA_LIVE_ADMIN_PASSWORD || "";
const LIVE_BASE_URL = process.env.PWA_LIVE_BASE_URL || "";

const RUN_ID = Date.now().toString(36);
const ACCOUNT_NAME = `Conta E2E Mobile ${RUN_ID}`;
const TX_DESC = `Teste E2E mobile ${RUN_ID}`;
const TX_DESC_TED = `Teste E2E mobile TED ${RUN_ID}`;
// Workspace de teste dedicado em produção — isolamento de dados reais do user.
const ACTIVE_WS = "550e8400-e29b-41d4-a716-446655440000"; // Test Family

type CategoryRow = { id?: unknown; name?: unknown; kind?: unknown };
type TransactionRow = {
  id?: unknown;
  description?: unknown;
  amountCents?: unknown;
  amount_cents?: unknown;
  date?: unknown;
  accountId?: unknown;
  account_id?: unknown;
  subcategoryId?: unknown;
  subcategory_id?: unknown;
  categoryId?: unknown;
  category_id?: unknown;
};

test.describe.configure({ mode: "serial" });

test.describe("live-mobile-full (PWA produção, viewport mobile)", () => {
  test.skip(!LIVE || !EMAIL || !PASSWORD || !LIVE_BASE_URL, "Opt-in: PWA_LIVE_E2E=1 + credenciais + base URL via env");

  const pageErrors: string[] = [];

  const watchPageErrors = (page: Page) => {
    page.on("pageerror", (err) => pageErrors.push(`pageerror: ${String(err?.message || err).slice(0, 300)}`));
  };

  const shot = async (page: Page, name: string) => {
    await page.screenshot({ path: `test-results/live-mobile/${name}.png`, fullPage: false });
  };

  const openTed = async (page: Page) => {
    const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
    await expect(launcher).toBeVisible({ timeout: 20000 });
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: /chat com ted/i });
    await expect(dialog).toBeVisible({ timeout: 15000 });
    return dialog;
  };

  const sendTedMessage = async (page: Page, dialog: ReturnType<Page["getByRole"]>, text: string) => {
    // SINGLE-DISPATCH: reenviar após um clique duplicaria propostas/mutações
    // do TED (cada clique cria um turno). Retries acontecem SOMENTE antes do
    // dispatch — preencher o textarea e aguardar o botão Enviar habilitar.
    // Depois que UM clique é despachado, nunca se clica de novo: aguarda-se
    // o bubble da mensagem com timeout e falha-se sem retry se não renderizar.
    for (let i = 0; i < 5; i++) {
      await page.evaluate(({ text }: { text: string }) => {
        const dlg = [...document.querySelectorAll("[role=dialog]")].find((d) =>
          (d.getAttribute("aria-label") || "").includes("Chat com TED"),
        );
        if (!dlg) return;
        const ta = dlg.querySelector("textarea");
        if (!ta) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(ta, text);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }, { text });
      await page.waitForTimeout(300);
      const enabled = await page.evaluate(() => {
        const dlg = [...document.querySelectorAll("[role=dialog]")].find((d) =>
          (d.getAttribute("aria-label") || "").includes("Chat com TED"),
        );
        const btn = dlg && [...dlg.querySelectorAll("button")].find((b) =>
          (b.getAttribute("aria-label") || "").includes("Enviar mensagem"),
        );
        return Boolean(btn && !btn.disabled);
      });
      if (enabled) break;
      if (i === 4) throw new Error(`botão Enviar nunca habilitou para: ${text}`);
      await page.waitForTimeout(1500);
    }
    // Único dispatch — a partir daqui, nenhum retry de clique.
    const dispatched = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll("[role=dialog]")].find((d) =>
        (d.getAttribute("aria-label") || "").includes("Chat com TED"),
      );
      const btn = dlg && [...dlg.querySelectorAll("button")].find((b) =>
        (b.getAttribute("aria-label") || "").includes("Enviar mensagem"),
      );
      if (!btn || btn.disabled) return false;
      // Input emulado do Chromium mobile não propaga fill/click aos handlers
      // React desta pilha — clique JS equivale ao toque real do usuário.
      btn.click();
      return true;
    });
    if (!dispatched) throw new Error(`mensagem TED não pôde ser enviada (botão desabilitou após preencher): ${text}`);
    await expect(dialog.getByText(text, { exact: true }).first()).toBeVisible({ timeout: 30000 });
  };

  test("jornada completa: login → conta → transação → extrato → TED lê dado real → TED mutação com aprovação", async ({ page }) => {
    test.setTimeout(420_000);
    watchPageErrors(page);
    let authComplete = false;
    let workspaceGuardReady = false;
    const consoleErrors: string[] = [];
    const workspaceWriteViolations: string[] = [];
    // Early agent-token mints blocked client-side before Test Family selection
    // (or with a wrong workspace header). These never reach the server — they
    // are recorded separately so the final hygiene assertion does not confuse
    // an aborted pre-workspace attempt with an actual unsafe write.
    const blockedEarlyAgentTokenAttempts: string[] = [];
    page.on("console", (message) => {
      if (authComplete && message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
    });
    const allowedBackendWrites = new Set([
      "POST /api/backend/auth/agent-token",
      "POST /api/backend/categories/apply-defaults",
      "POST /api/backend/accounts",
      "POST /api/backend/transactions/detect-duplicate",
      "POST /api/backend/transactions/expense",
    ]);
    const allowedAgentWrite = (method: string, path: string) => {
      const prefix = `/api/agent/agents/finance-chat-agent/${ACTIVE_WS}/rpc/`;
      if (!path.startsWith(prefix)) return false;
      const rpc = path.slice(prefix.length);
      return method === "POST" && (
        rpc === "chat" ||
        /^pending-operations\/[^/]+\/decision$/.test(rpc) ||
        rpc === "undo/decision"
      );
    };
    // Decision POST observer: attached before the first navigation so the
    // full journey is covered with no start gap. Captures any
    // finance-chat-agent pending-operations decision POST, in any workspace;
    // the final assertion requires exactly the single expected path.
    const decisionRequestPaths: string[] = [];
    const trackDecisionRequest = (request: Request) => {
      if (request.method() !== "POST") return;
      const pathname = new URL(request.url()).pathname;
      if (!/^\/api\/agent\/agents\/finance-chat-agent\/[^/]+\/rpc\/pending-operations\/[^/]+\/decision$/.test(pathname)) return;
      decisionRequestPaths.push(pathname);
    };
    page.on("request", trackDecisionRequest);
    // Install before the first navigation. Off-origin mutations (NEXT_PUBLIC_*
    // direct transport overrides) are blocked; auth/device bootstrap is
    // explicitly exempt; financial/agent writes fail closed until Test Family
    // is selected and then must match the selected workspace in header + path.
    const appOrigin = new URL(LIVE_BASE_URL).origin;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const url = new URL(request.url());
      const path = url.pathname;
      const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
      const workspaceHeader = request.headers()["x-workspace-id"];
      if (mutating && url.origin !== appOrigin) {
        workspaceWriteViolations.push(`off-origin write blocked ${method} ${url.origin}${path}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (!path.startsWith("/api/")) {
        if (mutating) {
          workspaceWriteViolations.push(`unexpected non-API write ${method} ${path}`);
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
        return;
      }
      const globalBackendReads = new Set([
        "/api/backend/auth/session",
        "/api/backend/auth/get-session",
        "/api/backend/workspaces",
        "/api/backend/health",
        // Device self-verification: global identity read with no workspace scope.
        "/api/backend/auth/devices/me",
      ]);
      const workspaceBackendPath = path.startsWith("/api/backend/") && !globalBackendReads.has(path);
      const agentPath = path.startsWith("/api/agent/");
      const agentMatch = path.match(/^\/api\/agent\/agents\/finance-chat-agent\/([^/]+)\/rpc\/(.+)$/);
      const agentWorkspaceMatches = agentPath && agentMatch?.[1] === ACTIVE_WS;
      // Auth/device bootstrap bypass is method-pinned: ONLY POST to the two
      // exact bootstrap endpoints continues. Any other verb on these paths
      // falls through to the fail-closed allowlists below.
      const authBootstrap = method === "POST" && (
        path === "/api/backend/auth/sign-in/email" ||
        path === "/api/backend/auth/devices/register"
      );
      const allowedBackendWrite = allowedBackendWrites.has(`${method} ${path}`);
      // Early agent-token guard: token mint before Test Family is selected or
      // with the wrong workspace must stay blocked, but it is NOT an unsafe
      // write sent to the server — page.route aborts it client-side. Record
      // separately and return before the generic workspace violation tracking.
      if (
        method === "POST" &&
        path === "/api/backend/auth/agent-token" &&
        (!workspaceGuardReady || workspaceHeader !== ACTIVE_WS)
      ) {
        blockedEarlyAgentTokenAttempts.push(
          `${method} ${path} workspace=${workspaceHeader ?? "<missing>"} ready=${workspaceGuardReady}`,
        );
        await route.abort("blockedbyclient");
        return;
      }

      if (authBootstrap && mutating) {
        await route.continue();
        return;
      }
      const scopedRequest = workspaceBackendPath || agentPath || allowedBackendWrite;
      const wrongWorkspace = workspaceHeader !== ACTIVE_WS || (agentPath && !agentWorkspaceMatches);
      // Before selection, let the read-only home shell bootstrap; block all
      // scoped writes. After selection, reads are also checked so the reload
      // assertion and subsequent UI cannot silently drift to another scope.
      if (scopedRequest && (mutating ? (!workspaceGuardReady || wrongWorkspace) : (workspaceGuardReady && wrongWorkspace))) {
        workspaceWriteViolations.push(`${method} ${path} workspace=${workspaceHeader ?? "<missing>"} ready=${workspaceGuardReady}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (agentPath && !agentWorkspaceMatches) {
        workspaceWriteViolations.push(`${method} ${path} path-workspace=${agentMatch?.[1] ?? "<missing>"}`);
        await route.abort("blockedbyclient");
        return;
      }
      const workspacePathMatch = path.match(/^\/api\/backend\/workspaces\/([^/]+)(?:\/|$)/);
      if (workspacePathMatch && workspacePathMatch[1] !== ACTIVE_WS) {
        workspaceWriteViolations.push(`${method} ${path} path-workspace=${workspacePathMatch[1]}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (mutating && path.startsWith("/api/backend/") && !authBootstrap && !allowedBackendWrite) {
        workspaceWriteViolations.push(`unexpected backend write ${method} ${path}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (mutating && agentPath && !allowedAgentWrite(method, path)) {
        workspaceWriteViolations.push(`unexpected agent write ${method} ${path}`);
        await route.abort("blockedbyclient");
        return;
      }
      // Fail-closed: any other mutating /api/* (unknown same-origin route)
      // is blocked unless it matched the exact allowlists above. Auth/device
      // bootstrap already continued; workspace/path checks above stay first.
      if (mutating) {
        const allowedWrite = allowedBackendWrite || allowedAgentWrite(method, path);
        if (!allowedWrite) {
          workspaceWriteViolations.push(`unexpected api write ${method} ${path}`);
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.continue();
    });

    // ── LOGIN (AuthGate mobile) ────────────────────────────────────────────
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const emailInput = page.locator("#email").or(page.getByLabel("E-mail")).or(page.getByPlaceholder(/email/i));
    const passwordInput = page.locator("#password").or(page.getByLabel("Senha"));
    await expect(emailInput.first()).toBeVisible({ timeout: 30000 });
    await shot(page, "01-login");
    await emailInput.first().fill(EMAIL);
    await passwordInput.first().fill(PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();

    // Shell autenticado: FAB "Nova transação" do BottomNav aparece.
    const fab = page.getByRole("button", { name: "Nova transação" });
    await expect(fab).toBeVisible({ timeout: 30000 });
    authComplete = true; // 401 no bootstrap antes do login é esperado.
    // Isolar todos os writes no workspace de teste (nunca no junio pessoal).
    await page.getByRole("button", { name: "Selecionar espaço" }).click();
    await page.getByRole("option", { name: /Test Family/ }).click();
    await expect(page.getByRole("button", { name: "Selecionar espaço" })).toContainText("Test Family", { timeout: 15000 });
    workspaceGuardReady = true;
    await shot(page, "02-home");

    // ── CONTA (fixture única por run; sempre exercita POST /accounts) ─────
    const accountsReloadRequest = page.waitForRequest(
      (request) => request.method() === "GET" && request.url().includes("/api/backend/accounts"),
      { timeout: 30000 },
    );
    const accountsReloadResponse = page.waitForResponse(
      (response) => response.request().method() === "GET" && response.url().includes("/api/backend/accounts"),
      { timeout: 30000 },
    );
    const accountsNavigation = page.goto("/hub/patrimonio?aba=contas", { waitUntil: "domcontentloaded" });
    await accountsNavigation;
    const accountsRead = await accountsReloadRequest;
    expect(
      accountsRead.headers()["x-workspace-id"],
      "GET /accounts emitted by the full reload must use the selected test workspace",
    ).toBe(ACTIVE_WS);
    const accountsReadResponse = await accountsReloadResponse;
    expect(accountsReadResponse.status()).toBe(200);
    const restoredPreference = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("pi-finance:active-workspace-preference");
        const parsed = raw ? JSON.parse(raw) : null;
        return {
          workspaceId: parsed?.workspaceId ?? null,
          principalId: parsed?.principalId ?? null,
          currentPrincipalId: localStorage.getItem("pi-finance:offline-principal"),
        };
      } catch {
        return { workspaceId: null, principalId: null, currentPrincipalId: null };
      }
    });
    expect(restoredPreference.workspaceId, "workspace preference must survive full reload").toBe(ACTIVE_WS);
    expect(typeof restoredPreference.currentPrincipalId).toBe("string");
    expect(restoredPreference.currentPrincipalId?.length ?? 0).toBeGreaterThan(0);
    expect(restoredPreference.principalId, "workspace preference must be bound to current principal").toBe(restoredPreference.currentPrincipalId);
    await expect(page.getByRole("button", { name: "Selecionar espaço" })).toContainText("Test Family", { timeout: 15000 });
    expect(await page.getByText(ACCOUNT_NAME).count()).toBe(0);
    const novaBtn = page.getByRole("button", { name: "Nova", exact: true });
    await expect(novaBtn).toBeVisible({ timeout: 30000 });
    await novaBtn.click();
    const novaConta = page.getByRole("heading", { name: "Nova conta" });
    await expect(novaConta).toBeVisible({ timeout: 15000 });
    await page.getByPlaceholder("Ex: Nubank, Itaú...").fill(ACCOUNT_NAME);
    await page.getByPlaceholder("0,00").fill("100,00");
    await shot(page, "03-nova-conta");
    const createRequest = page.waitForRequest(
      (request) => request.method() === "POST" && request.url().includes("/api/backend/accounts"),
      { timeout: 30000 },
    );
    const createResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/api/backend/accounts"),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Salvar" }).click();
    const [accountPost, accountPostResponse] = await Promise.all([createRequest, createResponse]);
    expect(accountPost.headers()["x-workspace-id"]).toBe(ACTIVE_WS);
    expect(accountPostResponse.status()).toBeLessThan(300);
    const accountBody = await accountPostResponse.json() as { id?: unknown };
    const testAccountId = accountBody.id;
    expect(typeof testAccountId).toBe("string");
    await expect(page.getByText(ACCOUNT_NAME).first()).toBeVisible({ timeout: 20000 });
    await shot(page, "04-conta-criada");

    // ── CATEGORIAS: template oficial idempotente para o workspace de teste ─
    const defaults = await page.evaluate(async (workspaceId) => {
      const res = await fetch("/api/backend/categories/apply-defaults", {
        method: "POST",
        credentials: "include",
        headers: { "X-Workspace-Id": workspaceId, "Idempotency-Key": crypto.randomUUID() },
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, created: body.created, skipped: body.skipped, code: body.code };
    }, ACTIVE_WS);
    expect(defaults.status, `apply-defaults HTTP ${defaults.status} code=${defaults.code}`).toBe(200);
    const lancheCategoryId = await page.evaluate(async (workspaceId) => {
      const response = await fetch("/api/backend/categories", {
        credentials: "include",
        headers: { "X-Workspace-Id": workspaceId },
      });
      const body = await response.json().catch(() => ({})) as { items?: CategoryRow[] };
      return body.items?.find((category) => category.name === "Lanche")?.id ?? null;
    }, ACTIVE_WS);
    expect(typeof lancheCategoryId, "default Lanche category exists in test workspace").toBe("string");

    // ── TRANSAÇÃO via sheet MOBILE (UI real; unique desc evita warning) ────
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Selecionar espaço" })).toContainText("Test Family", { timeout: 15000 });
    await fab.click();
    const launchGroup = page.getByRole("group", { name: "Novo lançamento" });
    await expect(launchGroup).toBeVisible({ timeout: 10000 });
    await launchGroup.getByRole("button", { name: "Despesa" }).click();
    const txSheet = page.getByRole("dialog", { name: /Nova despesa|Novo lançamento/ });
    await expect(txSheet.getByPlaceholder("0,00")).toBeVisible({ timeout: 15000 });
    await txSheet.getByPlaceholder("0,00").fill("1,00");
    await txSheet.getByPlaceholder("Ex: Aluguel, mercado...").fill(TX_DESC);
    await txSheet.getByRole("button", { name: "Selecionar categoria" }).click();
    const catPicker = page.getByRole("dialog", { name: "Categoria" });
    await catPicker.getByRole("button", { name: "Alimentação" }).first().click();
    const lanche = catPicker.getByRole("button", { name: "Lanche", exact: true });
    await expect(lanche).toBeVisible({ timeout: 10000 });
    await lanche.click();
    await expect(catPicker).toBeHidden({ timeout: 10000 });
    await txSheet.getByRole("button", { name: "Selecionar conta ou cartão" }).click();
    const accountPicker = page.getByRole("dialog", { name: /^Conta/ });
    const accountOption = accountPicker.getByRole("button", { name: new RegExp(ACCOUNT_NAME) }).first();
    await accountOption.scrollIntoViewIfNeeded();
    await accountOption.click();
    await expect(accountPicker).toBeHidden({ timeout: 10000 });
    const duplicateCheck = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/transactions/detect-duplicate"), { timeout: 30000 });
    const transactionCreate = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/transactions/expense"), { timeout: 30000 });
    await txSheet.getByRole("button", { name: /^Salvar$/ }).click();
    const duplicateResponse = await duplicateCheck;
    const transactionResponse = await transactionCreate;
    expect(duplicateResponse.status()).toBeLessThan(300);
    expect(transactionResponse.status()).toBeLessThan(300);
    const seededTransaction = await transactionResponse.json() as { id?: unknown; date?: unknown };
    const seedTransactionId = seededTransaction.id;
    const seedTransactionDate = typeof seededTransaction.date === "string" ? seededTransaction.date.slice(0, 10) : null;
    expect(typeof seedTransactionId).toBe("string");
    expect(seedTransactionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(txSheet).toBeHidden({ timeout: 20000 });

    // ── EXTRATO (transação aparece na lista) ───────────────────────────────
    await page.goto("/registros", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(TX_DESC).first()).toBeVisible({ timeout: 30000 });
    await shot(page, "06-extrato");

    // ── TED LEITURA (grounding sobre dado real) ────────────────────────────
    const dialog = await openTed(page);
    await sendTedMessage(
      page,
      dialog,
      "Qual o saldo total das minhas contas hoje? Responda citando o valor em reais.",
    );
    // Grounding: o TED responde com um valor real do workspace (não inventa,
    // não responde em modo falha-closed sem dado).
    const tedReply = dialog.getByText(/R\$\s*\d/).first();
    await expect(tedReply).toBeVisible({ timeout: 180_000 });
    await shot(page, "07-ted-leitura");

    // ── TED MUTAÇÃO (proposta → card de aprovação → confirmar) ────────────
    const expectedTedDate = await page.evaluate(() => {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Sao_Paulo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date()).map((part) => [part.type, part.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    });
    await sendTedMessage(
      page,
      dialog,
      `Na conta ${ACCOUNT_NAME}, categoria Lanche, hoje gastei R$ 2,00 ${TX_DESC_TED}`,
    );
    const approvalCard = dialog.locator('[data-testid="ted-approval-item"], [data-testid="ted-approval-focused"]')
      .filter({ hasText: TX_DESC_TED })
      .first();
    await expect(approvalCard).toBeVisible({ timeout: 180_000 });
    const operationWrapperId = await approvalCard.getAttribute("id");
    expect(operationWrapperId).toMatch(/^ted-op-[0-9a-f-]{36}$/i);
    const operationId = operationWrapperId!.slice("ted-op-".length);
    const decisionRequestPath = `/api/agent/agents/finance-chat-agent/${ACTIVE_WS}/rpc/pending-operations/${operationId}/decision`;
    const confirmBtn = approvalCard.getByRole("button", { name: /Confirmar R\$\s*2[.,]00/i });
    await expect(confirmBtn).toBeVisible();
    await expect(approvalCard).toContainText(TX_DESC_TED);
    await expect(approvalCard.getByText(ACCOUNT_NAME, { exact: true })).toBeVisible();
    await expect(approvalCard.getByText("Lanche", { exact: true })).toBeVisible();
    const approvalDetails = await approvalCard.locator("dl").innerText();
    const tedDateMatch = /Data\s+(\d{2}\/\d{2}\/\d{4})/.exec(approvalDetails);
    expect(tedDateMatch, `approval card date missing: ${approvalDetails}`).not.toBeNull();
    const [, dd, mm, yyyy] = /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/.exec(tedDateMatch![1]!)!;
    const tedTransactionDate = `${yyyy}-${mm}-${dd}`;
    expect(tedTransactionDate, "TED hoje deve usar a data local de São Paulo no início do turno").toBe(expectedTedDate);
    await shot(page, "08-ted-aprovacao");
    // Um único dispatch financeiro: nunca repetir confirmação por timeout.
    const decisionResponse = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname;
      return response.request().method() === "POST" &&
        path === `/api/agent/agents/finance-chat-agent/${ACTIVE_WS}/rpc/pending-operations/${operationId}/decision`;
    }, { timeout: 120_000 });
    await confirmBtn.evaluate((btn) => (btn as HTMLButtonElement).click());
    const decisionResult = await decisionResponse;
    expect(decisionResult.status(), "agent approval decision status").toBeLessThan(300);
    // Authoritative receipt: succeeded requires operationId + receipt with
    // entity { type, id }. The ledger assertion below ties the listed
    // transaction id to that entity.
    const decisionBody = await decisionResult.json() as {
      operationId?: unknown;
      status?: unknown;
      receipt?: {
        status?: unknown;
        operationId?: unknown;
        mutationId?: unknown;
        entity?: { type?: unknown; id?: unknown };
      };
    };
    expect(decisionBody.operationId, "decision receipt must name the approved operation").toBe(operationId);
    expect(decisionBody.status, "decision receipt status").toBe("succeeded");
    expect(decisionBody.receipt, "successful approval must return an execution receipt").toBeDefined();
    expect(decisionBody.receipt?.status, "execution receipt status").toBe("succeeded");
    expect(decisionBody.receipt?.operationId, "execution receipt pending operation").toBe(operationId);
    expect(decisionBody.receipt?.mutationId, "execution receipt mutation identity").toEqual(expect.any(String));
    expect(decisionBody.receipt?.entity?.type, "execution receipt entity type").toBe("transaction");
    expect(decisionBody.receipt?.entity?.id, "execution receipt transaction id").toEqual(expect.any(String));
    // Recibo de mutação: o card sai do estado pendente (botão some) e o TED
    // confirma a execução.
    await expect(confirmBtn).toBeHidden({ timeout: 60_000 });
    await shot(page, "09-ted-recibo");

    // ── VERIFICAÇÃO DA MUTAÇÃO no extrato ─────────────────────────────────
    // A linha visível é asseverada dentro da lista de registros (escopo
    // records-groups, não o body inteiro) e a amarração autoritativa é pelo
    // receipt.entity.id retornado na decisão — a descrição exata continua
    // obrigatória, mas não é o único localizador.
    await page.goto("/registros", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("records-groups").getByText(TX_DESC_TED).first()).toBeVisible({ timeout: 30000 });
    const created = await page.evaluate(async ({ workspaceId, descriptions, expectedTedId }) => {
      const matches: TransactionRow[] = [];
      const all: TransactionRow[] = [];
      let offset = 0;
      let total: number | null = null;
      let firstStatus = 0;
      let complete = false;
      const incomplete = (status: number, pageErrorStatus: number | string) => ({
        status,
        paginationComplete: false,
        pageErrorStatus,
        entries: Object.fromEntries(descriptions.map((description: string) => [description, []])),
        byReceiptId: null,
      });
      while (!complete) {
        const response = await fetch(`/api/backend/transactions?limit=100&offset=${offset}`, {
          credentials: "include",
          headers: { "X-Workspace-Id": workspaceId },
        });
        if (offset === 0) firstStatus = response.status;
        if (!response.ok) {
          return incomplete(firstStatus, response.status);
        }
        const body = await response.json().catch(() => ({})) as {
          items?: TransactionRow[];
          total?: number;
          offset?: number;
          limit?: number;
        };
        if (!Array.isArray(body.items) || typeof body.total !== "number") {
          return incomplete(firstStatus, "invalid response shape");
        }
        if (!Number.isInteger(body.total) || body.total < 0 || body.offset !== offset || body.limit !== 100) {
          return incomplete(firstStatus, "invalid pagination metadata");
        }
        if (total !== null && body.total !== total) {
          return incomplete(firstStatus, "total changed during pagination");
        }
        const items = body.items;
        total ??= body.total;
        if (items.length === 0 && offset < total) {
          return incomplete(firstStatus, "empty page before total");
        }
        matches.push(...items.filter((item) => typeof item.description === "string" && descriptions.includes(item.description)));
        all.push(...items);
        offset += items.length;
        if (offset > total) return incomplete(firstStatus, "page exceeded total");
        complete = offset >= total;
      }
      const entries = Object.fromEntries(descriptions.map((description: string) => {
        const found = matches.filter((item) => item.description === description);
        const item = found[0];
        return [description, {
          count: found.length,
          id: item?.id ?? null,
          amountCents: item?.amountCents ?? item?.amount_cents ?? null,
          date: typeof item?.date === "string" ? item.date.slice(0, 10) : null,
          accountId: item?.accountId ?? item?.account_id ?? null,
          categoryId: item?.subcategoryId ?? item?.subcategory_id ?? item?.categoryId ?? item?.category_id ?? null,
        }];
      }));
      return {
        status: firstStatus,
        paginationComplete: total !== null && offset >= total,
        entries,
        byReceiptId: (() => {
          const item = all.find((candidate) => String(candidate.id) === String(expectedTedId));
          if (!item) return null;
          return {
            id: item?.id ?? null,
            description: item?.description ?? null,
            amountCents: item?.amountCents ?? item?.amount_cents ?? null,
            date: typeof item?.date === "string" ? item.date.slice(0, 10) : null,
            accountId: item?.accountId ?? item?.account_id ?? null,
            categoryId: item?.subcategoryId ?? item?.subcategory_id ?? item?.categoryId ?? item?.category_id ?? null,
          };
        })(),
      };
    }, { workspaceId: ACTIVE_WS, descriptions: [TX_DESC, TX_DESC_TED], expectedTedId: decisionBody.receipt?.entity?.id });
    expect(created.status).toBe(200);
    expect(created.paginationComplete).toBe(true);
    expect(created.entries[TX_DESC]).toMatchObject({
      count: 1,
      id: seedTransactionId,
      amountCents: 100,
      date: seedTransactionDate,
      accountId: testAccountId,
      categoryId: lancheCategoryId,
    });
    expect(created.entries[TX_DESC_TED]).toMatchObject({
      count: 1,
      id: decisionBody.receipt?.entity?.id,
      amountCents: 200,
      date: expectedTedDate,
      accountId: testAccountId,
      categoryId: lancheCategoryId,
    });
    // Ledger-vs-receipt: the listed transaction id must equal the mandatory
    // receipt entity id returned by the single approval decision.
    expect(created.entries[TX_DESC_TED].id, "ledger transaction id must equal the decision receipt entity id")
      .toBe(decisionBody.receipt?.entity?.id);
    // Localizador autoritativo por receipt.entity.id: a linha do ledger é
    // encontrada pelo id do recibo (não só pela descrição) e a descrição
    // armazenada deve ser exatamente o marker único — sem enfraquecer.
    expect(created.byReceiptId, "ledger must contain the receipt entity id").not.toBeNull();
    expect(created.byReceiptId).toMatchObject({
      id: decisionBody.receipt?.entity?.id,
      description: TX_DESC_TED,
      amountCents: 200,
      date: expectedTedDate,
      accountId: testAccountId,
      categoryId: lancheCategoryId,
    });
    await shot(page, "10-extrato-pos-ted");

    // ── NAVEGAÇÃO: superfícies principais renderizam em mobile ─────────────
    const mobileRoutes = [
      "/hub",
      "/hub/patrimonio?aba=contas",
      "/hub/patrimonio?aba=cartoes",
      "/hub/planejamento",
      "/hub/relatorios",
      "/hub/alertas",
      "/hub/categorias",
      "/hub/configuracoes",
      "/compromissos",
      "/compromissos?aba=pendencias",
      "/a-pagar",
      "/contas",
      "/cartoes",
      "/perfil",
    ];
    for (const path of mobileRoutes) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("main")).toBeVisible({ timeout: 30000 });
      if (path === "/hub/alertas") {
        // AlertasTabs intentionally omits PageHeader/WorkspaceSwitcher; its
        // workspace-scoped reads remain covered by the request guard above.
        await expect(page.getByRole("tablist", { name: "Alertas" })).toBeVisible({ timeout: 15000 });
      } else {
        await expect(page.getByRole("button", { name: "Selecionar espaço" })).toContainText("Test Family", { timeout: 15000 });
      }
      await expect(page.locator("body")).not.toContainText("Carregando…", { timeout: 30000 });
      await shot(page, `11-nav-${path.replace(/\W+/g, "-")}`);
    }
    expect(decisionRequestPaths, "one approval must dispatch exactly one financial decision POST")
      .toEqual([decisionRequestPath]);
    page.off("request", trackDecisionRequest);

    // ── HIGIENE: nenhum erro de página não tratado durante a jornada ───────
    // Diagnostic: early agent-token attempts above were deliberately
    // intercepted client-side (blockedbyclient) before Test Family selection
    // or with a wrong workspace header — they never reached the server and
    // are not workspace writes. Only workspaceWriteViolations must stay empty.
    test.info().annotations.push({
      type: "live-auth-guard",
      description: `blocked early agent-token attempts (client-aborted, never sent): ${blockedEarlyAgentTokenAttempts.length} :: ${blockedEarlyAgentTokenAttempts.join(" | ")}`,
    });
    expect(workspaceWriteViolations, `writes outside selected workspace: ${workspaceWriteViolations.join(" | ")}`).toHaveLength(0);
    expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toHaveLength(0);
    expect(consoleErrors, `console errors after login: ${consoleErrors.join(" | ")}`).toHaveLength(0);
  });
});
