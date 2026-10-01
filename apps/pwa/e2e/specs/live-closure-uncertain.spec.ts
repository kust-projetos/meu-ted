/**
 * Live closure UNCERTAIN scenario — deterministic fixture proof (CLOSURE-UNC-01).
 *
 * The live happy path (live-closure.spec.ts) REQUIRES a succeeded receipt and
 * fails on any uncertain outcome. This separate scenario proves the uncertain
 * lock against the LOCAL fixture with a controlled fault — never a random
 * production error:
 *
 * - The agent stub's DEFAULT confirm decision returns 200 WITHOUT a receipt
 *   entity (unscripted `decisions`), which the strict PWA client rejects with
 *   `agent.execution_outcome_unknown` (fail-closed, never success).
 * - The approval card must then lock: "ainda não foi verificado" + NO
 *   Confirm/Cancel/Retry buttons, exactly ONE decision POST in the journal.
 *
 * Local setup is replicated here (harness.ts belongs to another worker and
 * its built-in empty stubs would shadow per-test state) following the same
 * pattern as ted-pending-ops.spec.ts. No LLM, no external network.
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
import { validateUncertainLock } from "../support/live-closure-guards";

const MOCK_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": harnessOrigin(),
  "Access-Control-Allow-Credentials": "true",
};

let counter = 0;
function tid(): string {
  counter += 1;
  return `closure-unc-${counter}`;
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

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

type JournalEntry = { method: string; path: string; status: number; body?: unknown };

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

function actionablePresentation(opId: string): Record<string, unknown> {
  return {
    id: opId,
    status: "proposed",
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

function proposedTurn(opId: string): Record<string, unknown> {
  return {
    turnId: `turn-${opId}`,
    status: "completed",
    output: "Proposta criada. Revise os dados antes de confirmar.",
    pendingOperation: {
      id: opId,
      status: "proposed",
      operation: "transactions.expense.create",
      summary: "Mercado",
      presentation: actionablePresentation(opId),
    },
  };
}

test.describe("live closure uncertain (fixture fault control)", () => {
  test("CLOSURE-UNC-01: receipt-less succeeded decision locks the card with a single POST", async ({ page }) => {
    const id = tid();
    const opId = `op-${id}-unc`;
    const guard: GuardState = createGuard();
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

    await applyCspRewrite(page);
    await resetFixture(id);
    // Controlled fault: chat proposes an actionable operation, but the
    // decision reply is LEFT UNSCRIPTED — the stub default returns 200 with
    // a receipt missing `entity`, which the strict client must reject
    // (agent.execution_outcome_unknown) instead of resolving success.
    await postAgentScript(id, { chat: [{ status: 200, body: proposedTurn(opId) }] });
    await page.clock.setFixedTime(FIXED_CLOCK);
    await page.context().setExtraHTTPHeaders({ [E2E_TEST_ID_HEADER]: id });

    await page.route("**/api/agent/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const subpath = url.pathname.replace(/^\/api\/agent\/?/, "");
      const target = `${FIXTURE_URL}/${subpath}${url.search}`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        [E2E_TEST_ID_HEADER]: id,
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
    await page.route("**/auth/agent-token", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ token: "mock-token", expiresIn: 90 }),
      });
    });
    await page.route("**/finance-chat-agent/**/rpc/history*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ items: [], total: 0 }),
      });
    });
    await page.route("**/finance-chat-agent/**/rpc/undo/active*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ items: [], total: 0 }),
      });
    });
    await page.route("**/rpc/pending-operations/active*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: MOCK_CORS_HEADERS,
        body: JSON.stringify({ items: [], total: 0 }),
      });
    });

    await page.goto("/");
    await authenticate(page);
    const dialog = await openTed(page);
    await sendTedMessage(dialog, "registre despesa mercado 850");

    // Actionable proposal renders with financial data + enabled Confirm.
    await expect(dialog.getByText("R$ 850,00", { exact: true })).toBeVisible();
    const confirmBtn = dialog.getByRole("button", { name: /Confirmar R\$ 850,00/ });
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).toBeEnabled();

    // Single dispatch: the faulted decision locks the card.
    await confirmBtn.click();
    const isDecisionPost = (e: JournalEntry): boolean =>
      e.method === "POST" && e.path.endsWith("/decision");
    const journal = await waitJournal(id, (e) => isDecisionPost(e) && bodyOf(e).decision === "confirm");
    const decisions = journal.filter(isDecisionPost);
    expect(decisions).toHaveLength(1);
    expect(bodyOf(decisions[0]).requestId).toEqual(expect.any(String));
    expect(decisions[0].status).toBe(200);

    // Uncertain lock: unverified message, zero decision buttons left.
    await expect(dialog.getByText(/ainda não foi verificado/i)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Confirmar/i })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Cancelar" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /Tentar novamente/i })).toHaveCount(0);
    validateUncertainLock("agent.execution_outcome_unknown", { confirm: false, cancel: false, retry: false });

    // No retry storm: still exactly one decision call after the lock settles.
    await page.waitForTimeout(1000);
    expect((await getJournal(id)).filter(isDecisionPost)).toHaveLength(1);

    assertNoUndeclaredFailures(guard);
  });
});
