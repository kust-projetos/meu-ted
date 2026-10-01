/**
 * TED pending operations E2E (WAVE4-CODERB-TEDOPS).
 *
 * Covers the proposta/confirm/cancel/retry flow with actionable presentation
 * (production functional corrections plan, "Gates para integração e aceite",
 * item 4) against the deterministic local fixture — no real LLM, no external
 * network, everything loopback:
 *
 * - OP-01: proposta WITH actionable presentation → value/account/category/date
 *   visible, Confirm enabled, decide(confirm) → succeeded + receipt.
 * - OP-02: proposta WITHOUT actionable presentation (legacy/rehydrated) →
 *   Cancel only, confirm never callable (asserted by absence of POST).
 * - OP-03: cancel → cancelled receipt, consistent state after reload.
 * - OP-04: failed WITH valid presentation → financial data visible BEFORE
 *   Retry; Retry decides against the agent.
 * - OP-05: failed WITHOUT presentation → no Retry, update/redo instruction.
 * - OP-06a: operational failure (429/503) → explicit user retry re-sends the
 *   SAME intentionId and the second reply succeeds (PWA client retry
 *   contract — no automatic retry, user action only).
 * - OP-06b: policy denial (403) → no automatic retry, only explicit user
 *   action; the journal holds exactly the single denied call.
 *
 * Internal primary→fallback failover within a single agent turn is NOT
 * exercised here; it is covered by the Agent unit suites
 * (apps/agent/tests/llm-relay-failover*.test.ts).
 *
 * Transport note: the app calls the same-origin proxy /api/agent (no direct
 * Agent origin is configured in the E2E standalone build). Each test forwards
 * /api/agent/* to the fixture /agents/finance-chat-agent/* handlers (Node
 * fetch with X-E2E-Test-ID), so every chat/decision call is journaled by the
 * fixture with method+path+body+status. Replies are programmed per test via
 * POST /__e2e/agent-script (FIFO chat queue, per-key decisions). History and
 * the undo active list are stubbed empty in-browser; the approval active
 * list is stubbed statefully in-browser so tests control reload visibility.
 *
 * Harness ownership: support/harness.ts belongs to another worker — this spec
 * replicates the needed setup locally (guard, CSP rewrite, reset, clock,
 * headers, login) instead of importing prepareSpec/initSpec, whose built-in
 * empty active-operations stub would shadow the per-test pending-ops state.
 */

import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  createGuard,
  attachGuard,
  allowFailure,
  assertNoUndeclaredFailures,
  type GuardState,
} from "../support/failure-guard";
import { FIXTURE_URL, FIXED_CLOCK, E2E_TEST_ID_HEADER } from "../support/reset";
import { harnessOrigin } from "../support/ports";

// Cross-origin mocked API responses must carry CORS headers: the app calls
// the absolute fixture origin with credentials:include, so a fulfill without
// ACAO + ACA-Credentials is rejected by the browser (Failed to fetch).
const MOCK_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": harnessOrigin(),
  "Access-Control-Allow-Credentials": "true",
};

let counter = 0;
function tid(): string {
  counter += 1;
  return `ted-ops-${counter}`;
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

// ─── Local setup replicas (see header: harness.ts is owned elsewhere) ───────

function rewriteCspForFixture(csp: string): string {
  return (
    csp
      .replace(/connect-src\s+([^;]+)/, `connect-src ${FIXTURE_URL} $1`)
      .replace(/script-src\s+[^;]+/, "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:")
  );
}

async function applyCspRewrite(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    try {
      const req = route.request();
      const isDocument = req.resourceType() === "document";
      const response = isDocument
        ? await route.fetch({ maxRedirects: 0 })
        : await route.fetch();
      if (isDocument && response.status() >= 300 && response.status() < 400) {
        const location = response.headers()["location"];
        if (location) {
          const dest = new URL(location, req.url()).toString();
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            headers: {
              "content-security-policy": "script-src 'self' 'unsafe-inline'; connect-src 'self';",
            },
            body: `<!doctype html><html><head><meta charset="utf-8"><title>redirecting</title></head><body><script>location.replace(${JSON.stringify(dest)});</script></body></html>`,
          });
          return;
        }
      }
      const headers = { ...response.headers() };
      const csp = headers["content-security-policy"];
      if (csp) headers["content-security-policy"] = rewriteCspForFixture(csp);
      await route.fulfill({ response, headers });
    } catch {
      /* route already handled or page closed */
    }
  });
}

async function resetFixture(testId: string, seed = "populated"): Promise<void> {
  const res = await fetch(`${FIXTURE_URL}/__e2e/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [E2E_TEST_ID_HEADER]: testId },
    body: JSON.stringify({ testId, seed }),
  });
  if (!res.ok) throw new Error(`Fixture reset failed: ${res.status}`);
}

type AgentScript = {
  chat?: Array<{ status?: number; body?: Record<string, unknown> }>;
  decisions?: Record<string, { status?: number; body?: Record<string, unknown> }>;
  active?: Array<Record<string, unknown>>;
};

async function postAgentScript(testId: string, script: AgentScript): Promise<void> {
  const res = await fetch(`${FIXTURE_URL}/__e2e/agent-script`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [E2E_TEST_ID_HEADER]: testId },
    body: JSON.stringify({ testId, ...script }),
  });
  if (!res.ok) throw new Error(`Agent script failed: ${res.status} ${await res.text()}`);
}

type JournalEntry = {
  method: string;
  path: string;
  status: number;
  body?: unknown;
};

async function getJournal(testId: string): Promise<JournalEntry[]> {
  const res = await fetch(`${FIXTURE_URL}/__e2e/journal?testId=${testId}`, {
    headers: { [E2E_TEST_ID_HEADER]: testId },
  });
  return res.ok ? ((await res.json()) as JournalEntry[]) : [];
}

async function waitJournal(
  testId: string,
  pred: (entry: JournalEntry) => boolean,
  timeout = 10000,
): Promise<JournalEntry[]> {
  const start = Date.now();
  for (;;) {
    const entries = await getJournal(testId);
    if (entries.some(pred)) return entries;
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out waiting for journal entry (testId=${testId})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function bodyOf(entry: JournalEntry): Record<string, unknown> {
  return (entry.body ?? {}) as Record<string, unknown>;
}

async function authenticate(page: Page, timeout = 15000): Promise<void> {
  // Authenticated signal is viewport-dependent: the BottomNav FAB
  // ("Nova transação") is lg:hidden by design, while the TED launcher pill
  // stays mounted on desktop (repositioned, not hidden). Either proves the
  // authenticated shell rendered.
  const fab = page.getByLabel("Nova transação");
  const tedLauncher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  if (await fab.isVisible().catch(() => false)) return;
  if (await tedLauncher.isVisible().catch(() => false)) return;

  const emailInput = page.getByLabel("E-mail");
  const passwordInput = page.getByLabel("Senha");
  const loginBtn = page.getByRole("button", { name: "Entrar" });

  const loginFormVisible = await emailInput
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (loginFormVisible) {
    await emailInput.fill("test@example.com");
    await passwordInput.fill("password123");
    await expect(loginBtn).toBeEnabled({ timeout });
    await loginBtn.click();
    await page.waitForLoadState("networkidle");
  }

  // Locator.or() would match both buttons once the shell renders (strict-mode
  // violation), so poll a boolean instead: either visible proves login.
  await expect
    .poll(
      async () =>
        (await fab.isVisible().catch(() => false)) ||
        (await tedLauncher.isVisible().catch(() => false)),
      { timeout },
    )
    .toBe(true);
}

async function openTed(page: Page): Promise<Locator> {
  const launcher = page.getByRole("button", { name: /abrir assistente ted/i }).last();
  await expect(launcher).toBeVisible();
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: /chat com ted/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function sendTedMessage(dialog: Locator, text: string): Promise<void> {
  await dialog.getByLabel("Mensagem para o assistente").fill(text);
  await dialog.getByRole("button", { name: /enviar mensagem/i }).click();
}

// ─── Deterministic payload builders ──────────────────────────────────────────
// Shapes must satisfy the app's strict client schemas (agent-client.ts):
// presentation {id,status,tool,title,amountCents?,description?,date?,
// account?,category?,expiresAt,warnings} and decision
// {operationId,status,retryable?,receipt?} — no extra keys. Labels reference
// the populated seed (acc-1 Conta Corrente, cat-1 Alimentação).

function actionablePresentation(opId: string, status = "proposed"): Record<string, unknown> {
  return {
    id: opId,
    status,
    tool: "transactions.expense.create",
    title: "Confirmar despesa",
    amountCents: 85000,
    description: "Mercado",
    date: "2026-07-17",
    account: { id: "acc-1", label: "Conta Corrente" },
    category: { id: "cat-1", label: "Alimentação" },
    expiresAt: "2026-07-18T12:00:00.000Z",
    warnings: [],
  };
}

function proposedTurn(opId: string, opts: { presentation?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    turnId: `turn-${opId}`,
    status: "completed",
    output: "Proposta criada. Revise os dados antes de confirmar.",
    pendingOperation: {
      id: opId,
      status: "proposed",
      operation: "transactions.expense.create",
      summary: "Mercado",
      ...(opts.presentation ? { presentation: opts.presentation } : {}),
    },
  };
}

function failedTurn(opId: string, opts: { presentation?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    turnId: `turn-${opId}`,
    status: "completed",
    output: "A operação não pôde ser concluída.",
    pendingOperation: {
      id: opId,
      status: "failed",
      operation: "transactions.expense.create",
      summary: "Mercado",
      ...(opts.presentation ? { presentation: opts.presentation } : {}),
    },
  };
}

// ─── Per-test wiring ─────────────────────────────────────────────────────────

type OpSetup = {
  guard: GuardState;
  dialog: Locator;
  setActiveOps: (ops: Array<Record<string, unknown>>) => void;
};

/**
 * Prepares one pending-ops test: guard + CSP + fixture reset + agent script,
 * then routes /api/agent/* to the fixture (journaled, deterministic) with
 * in-browser stubs for history/undo/active registered afterwards (later
 * registrations win over the generic forwarder).
 */
async function prepareOpTest(
  page: Page,
  testId: string,
  script: AgentScript,
  extraAllow: Array<{ message?: string; url?: string; status?: number; reason: string }> = [],
): Promise<OpSetup> {
  const guard = createGuard();
  attachGuard(page, guard);
  allowFailure(guard, {
    url: "/auth/session",
    status: 401,
    message: "401 (Unauthorized)",
    reason: "expected anonymous cookie-session probe before login",
  });
  for (const entry of [
    { message: "reading 'waiting'", reason: "SW blocked" },
    { url: "/profile", reason: "fixture has no /profile" },
    { url: "/pwa-control", reason: "fixture has no /pwa-control" },
  ] as const) {
    allowFailure(guard, entry);
  }
  for (const entry of extraAllow) allowFailure(guard, entry);

  await applyCspRewrite(page);
  await resetFixture(testId);
  await postAgentScript(testId, script);
  await page.clock.setFixedTime(FIXED_CLOCK);
  await page.context().setExtraHTTPHeaders({ [E2E_TEST_ID_HEADER]: testId });

  // Generic forwarder: /api/agent/<subpath> → fixture /<subpath>, journaled.
  await page.route("**/api/agent/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const subpath = url.pathname.replace(/^\/api\/agent\/?/, "");
    const target = `${FIXTURE_URL}/${subpath}${url.search}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [E2E_TEST_ID_HEADER]: testId,
    };
    const workspaceId = req.headers()["x-workspace-id"];
    if (workspaceId) headers["x-workspace-id"] = workspaceId;
    const method = req.method();
    const postData = req.postData();
    const res = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : (postData ?? undefined),
    });
    const text = await res.text();
    await route.fulfill({
      status: res.status,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: text,
    });
  });

  // Connection token: established in-browser pattern (not part of the
  // pending-ops contract under test).
  await page.route("**/auth/agent-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({ token: "mock-token", expiresIn: 90 }),
    });
  });

  // Chat history: empty, so cards come only from the scripted turn / the
  // stateful active list below (mirrors the product rule that history never
  // mints live cards).
  await page.route("**/finance-chat-agent/**/rpc/history*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });

  // Undo active list: none in these flows.
  await page.route("**/finance-chat-agent/**/rpc/undo/active*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });

  // Approval active list: stateful per test (controls reload visibility).
  let activeOps: Array<Record<string, unknown>> = script.active ?? [];
  await page.route("**/rpc/pending-operations/active*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: MOCK_CORS_HEADERS,
      body: JSON.stringify({ items: activeOps, total: activeOps.length }),
    });
  });

  await page.goto("/");
  await authenticate(page);
  const dialog = await openTed(page);
  return { guard, dialog, setActiveOps: (ops) => { activeOps = ops; } };
}

const isChatPost = (e: JournalEntry): boolean => e.method === "POST" && e.path.endsWith("/rpc/chat");
const isDecisionPost = (e: JournalEntry): boolean => e.method === "POST" && e.path.endsWith("/decision");

// ─── OP-01: proposta com apresentação acionável → Confirm → recibo ───────────

test.describe("TED pending operations", () => {
  test("OP-01: proposal with actionable presentation confirms with receipt", async ({ page }) => {
    const id = tid();
    const opId = `op-${id}-01`;
    const { guard, dialog } = await prepareOpTest(page, id, {
      chat: [{ status: 200, body: proposedTurn(opId, { presentation: actionablePresentation(opId) }) }],
    });

    await sendTedMessage(dialog, "registre despesa mercado 850");

    // Presentation gate: value, account, category and date render BEFORE Confirm.
    // Exact text: the confirm button embeds the value and suggestion chips may
    // embed category words, so substring matches are ambiguous (strict mode).
    await expect(dialog.getByText("R$ 850,00", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Conta Corrente", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Alimentação", { exact: true })).toBeVisible();
    await expect(dialog.getByText("17/07/2026", { exact: true })).toBeVisible();
    const confirmBtn = dialog.getByRole("button", { name: /Confirmar R\$ 850,00/ });
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Cancelar" })).toBeVisible();

    await confirmBtn.click();

    // Decide went through the agent proxy to the fixture with decision + requestId.
    const journal = await waitJournal(id, (e) => isDecisionPost(e) && bodyOf(e).decision === "confirm");
    const decisions = journal.filter(isDecisionPost);
    expect(decisions).toHaveLength(1);
    expect(bodyOf(decisions[0]).requestId).toEqual(expect.any(String));
    expect(decisions[0].status).toBe(200);

    // The card left the proposed state (confirmed → succeeded terminal shows,
    // then the empty active list clears it on revalidation).
    await expect(dialog.getByRole("button", { name: /Confirmar R\$ 850,00/ })).toHaveCount(0);

    // Chat carried a stable intentionId (single attempt, retry-safe identity).
    const chats = journal.filter(isChatPost);
    expect(chats).toHaveLength(1);
    expect(bodyOf(chats[0]).intentionId).toEqual(expect.any(String));

    assertNoUndeclaredFailures(guard);
  });

  // ─── OP-02: proposta sem apresentação → somente Cancelar ──────────────────

  test("OP-02: legacy proposal without presentation offers Cancel only, never confirm", async ({ page }) => {
    const id = tid();
    const opId = `op-${id}-02`;
    const { guard, dialog } = await prepareOpTest(page, id, {
      chat: [{ status: 200, body: proposedTurn(opId) }],
    });

    await sendTedMessage(dialog, "registre despesa mercado 850");

    // Fail-closed: warning renders, Confirm/Aprovar never render.
    await expect(dialog.getByText(/não é possível confirmar/i)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Confirmar/i })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Aprovar" })).toHaveCount(0);
    const cancelBtn = dialog.getByRole("button", { name: "Cancelar" });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    const journal = await waitJournal(id, (e) => isDecisionPost(e) && bodyOf(e).decision === "cancel");
    const decisions = journal.filter(isDecisionPost);
    expect(decisions.map((e) => bodyOf(e).decision)).toEqual(["cancel"]);
    await expect(dialog.getByRole("button", { name: "Cancelar" })).toHaveCount(0);

    assertNoUndeclaredFailures(guard);
  });

  // ─── OP-03: cancel → recibo + estado consistente após reload ──────────────

  test("OP-03: cancel settles the operation and reload shows no live approval", async ({ page }) => {
    const id = tid();
    const opId = `op-${id}-03`;
    const { guard, dialog, setActiveOps } = await prepareOpTest(page, id, {
      chat: [{ status: 200, body: proposedTurn(opId) }],
    });
    setActiveOps([]);

    await sendTedMessage(dialog, "registre despesa mercado 850");
    await expect(dialog.getByText(/não é possível confirmar/i)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await waitJournal(id, (e) => isDecisionPost(e) && bodyOf(e).decision === "cancel");

    // Reload: session cookie persists, history + active list are empty, so no
    // live approval card may reappear for the settled operation.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.clock.setFixedTime(FIXED_CLOCK);
    await authenticate(page);
    const reopened = await openTed(page);
    await expect(reopened.getByText(/aguardando aprovação/i)).toHaveCount(0);
    await expect(reopened.getByRole("button", { name: /Confirmar/i })).toHaveCount(0);
    await expect(reopened.getByRole("button", { name: "Cancelar" })).toHaveCount(0);
    await expect(reopened.getByRole("button", { name: /tentar novamente/i })).toHaveCount(0);

    // Exactly one decision network call for the whole flow.
    const decisions = (await getJournal(id)).filter(isDecisionPost);
    expect(decisions).toHaveLength(1);
    expect(bodyOf(decisions[0]).decision).toBe("cancel");

    assertNoUndeclaredFailures(guard);
  });

  // ─── OP-04: failed com apresentação → dados antes do Retry ────────────────

  test("OP-04: failed operation with presentation shows financial data before Retry", async ({ page }) => {
    const id = tid();
    const opId = `op-${id}-04`;
    const { guard, dialog } = await prepareOpTest(page, id, {
      chat: [{ status: 200, body: failedTurn(opId, { presentation: actionablePresentation(opId, "failed") }) }],
    });

    await sendTedMessage(dialog, "registre despesa mercado 850");

    // The actionable data the user re-authorizes renders BEFORE Retry is touched.
    // Exact text (see OP-01): the value also lives in the confirm label and
    // category words appear in suggestion chips.
    await expect(dialog.getByText("R$ 850,00", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Conta Corrente", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Alimentação", { exact: true })).toBeVisible();
    await expect(dialog.getByText("17/07/2026", { exact: true })).toBeVisible();
    const retryBtn = dialog.getByRole("button", { name: "Tentar novamente" });
    await expect(retryBtn).toBeVisible();
    await expect(retryBtn).toBeEnabled();

    await retryBtn.click();

    const journal = await waitJournal(id, (e) => isDecisionPost(e) && bodyOf(e).decision === "retry");
    const decisions = journal.filter(isDecisionPost);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe(200);
    await expect(dialog.getByRole("button", { name: "Tentar novamente" })).toHaveCount(0);

    assertNoUndeclaredFailures(guard);
  });

  // ─── OP-05: failed sem apresentação → sem Retry ───────────────────────────

  test("OP-05: failed operation without presentation offers no Retry", async ({ page }) => {
    const id = tid();
    const opId = `op-${id}-05`;
    const { guard, dialog } = await prepareOpTest(page, id, {
      chat: [{ status: 200, body: failedTurn(opId) }],
    });

    await sendTedMessage(dialog, "registre despesa mercado 850");

    // Honest degradation: update/redo instruction, Retry never renders so it
    // can never be sent.
    await expect(dialog.getByText(/não é possível tentar novamente/i)).toBeVisible();
    await expect(dialog.getByText(/atualize e refaça a proposta/i)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /tentar novamente/i })).toHaveCount(0);

    // No decision network call is possible from this state.
    await expect.poll(async () => (await getJournal(id)).filter(isDecisionPost).length, { timeout: 3000 }).toBe(0);

    assertNoUndeclaredFailures(guard);
  });

  // ─── OP-06a: client retry contract — same intentionId on user retry ──────

  test("OP-06a: user retry re-sends same intentionId after provider failure", async ({
    page,
  }) => {
    const id = tid();
    const { guard, dialog } = await prepareOpTest(
      page,
      id,
      {
        chat: [
          { status: 429, body: { code: "agent.primary_unavailable", message: "Provedor primário indisponível." } },
          {
            status: 200,
            body: {
              turnId: "turn-fallback",
              status: "completed",
              output: "Resposta via fallback elegível: sem dados novos.",
            },
          },
        ],
      },
      [{ url: "/api/agent", status: 429, reason: "scripted operational failure (primary unavailable)" },
        {
          message: "Failed to load resource",
          url: "/api/agent",
          reason: "browser console echoes the scripted 429 chat response",
        }],
    );

    await sendTedMessage(dialog, "qual meu saldo?");

    // First attempt fails operationally: failed bubble with message-level retry.
    const retryBtn = dialog.getByRole("button", { name: /tentar novamente/i });
    await expect(retryBtn).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText(/não foi possível enviar a mensagem/i);

    await retryBtn.click();

    // Second attempt succeeds: failed UI clears and exactly two chat calls
    // share one stable intentionId (a lost response could never mint a second
    // proposal).
    await expect(dialog.getByRole("button", { name: /tentar novamente/i })).toHaveCount(0);
    await expect
      .poll(async () => (await getJournal(id)).filter(isChatPost).length, { timeout: 10000 })
      .toBe(2);
    const journal = await getJournal(id);
    const chats = journal.filter(isChatPost);
    expect(chats).toHaveLength(2);
    expect(chats.map((e) => e.status)).toEqual([429, 200]);
    const firstIntent = bodyOf(chats[0]).intentionId;
    expect(typeof firstIntent).toBe("string");
    expect(firstIntent).not.toBe("");
    expect(bodyOf(chats[1]).intentionId).toBe(firstIntent);

    assertNoUndeclaredFailures(guard);
  });

  // ─── OP-06b: 403 policy denial → no automatic retry ──────────────────────

  test("OP-06b: 403 policy denial produces no automatic retry, only explicit user action", async ({ page }) => {
    const id = tid();
    const { guard, dialog } = await prepareOpTest(
      page,
      id,
      {
        chat: [
          { status: 403, body: { code: "agent.model_not_allowlisted", message: "Modelo não permitido por política." } },
        ],
      },
      [{ url: "/api/agent", status: 403, reason: "scripted policy denial (no fallback eligible)" },
        {
          message: "Failed to load resource",
          url: "/api/agent",
          reason: "browser console echoes the scripted 403 chat response",
        }],
    );

    await sendTedMessage(dialog, "qual meu saldo?");

    await expect(dialog.getByRole("button", { name: /tentar novamente/i })).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText(/não foi possível enviar a mensagem/i);

    // No automatic second attempt: wait past any client retry window, then
    // the journal must still hold exactly the single denied call.
    await page.waitForTimeout(1500);
    const chats = (await getJournal(id)).filter(isChatPost);
    expect(chats).toHaveLength(1);
    expect(chats[0].status).toBe(403);
    expect(bodyOf(chats[0]).intentionId).toEqual(expect.any(String));

    assertNoUndeclaredFailures(guard);
  });
});
