/**
 * Live CLOSURE E2E — jornada autenticada completa em produção (viewport mobile).
 *
 * Cobre, sobre APIs/UI existentes e sem especulação: criar (conta + transação
 * via sheet) → editar (sheet de edição, PATCH) → confirmar TED com recibo
 * canônico → desfazer OBRIGATÓRIO (ausência = BLOCKED, nunca pass) → segunda
 * proposta TED cancelada → recuperação (reload, exatamente-uma-vez, counts
 * exatos) → excluir (somente entidades deste RUN_ID) → higiene.
 *
 * Authorization model (HIGH review findings):
 * - Agent writes are authorized BEFORE dispatch inside page.route by the pure
 *   authorizers (closed sets + request bodies + workspace header); grants are
 *   CONSUMED before route.continue (no replay). Posthoc journal observation
 *   audits cardinality but never authorizes.
 * - Pending-op authorization is AUTHORITATIVE: GET pending-operations/active
 *   must bind id/status/tool/amount/description/account/category before the
 *   pending id enters the decision closed set and the click is allowed. Ids
 *   bind from the top-level normalizedArgs-derived fields OR the server-built
 *   presentation (presentation.account.id / presentation.category.id) — the
 *   relay's lean projection omits raw normalizedArgs, so at least one source
 *   must bind and both must agree. The card UI is secondary cross-check only.
 *   Backend V2 reads are Agent-only by contract, so the authoritative read
 *   goes through the Agent relay.
 * - Agent reads use the PRODUCT auth flow (agent-auth.ts/agent-client.ts):
 *   cookie-only GETs answer device-bound 401, so each READ mints a FRESH
 *   single-use connection token via POST /api/backend/auth/agent-token with
 *   the device token on the explicit T2.5 channel
 *   (localStorage "pi-finance:token" → x-device-token) + session cookie +
 *   X-Workspace-Id, then GETs with x-agent-connection-token. App modules
 *   cannot be imported inside page.evaluate (bundled realm), so the exact
 *   raw-fetch flow is replicated here; token values stay in page memory and
 *   are never logged. No handler is weakened (mint was already allowlisted;
 *   agent reads were already allowed) and no endpoint is created.
 * - Undo fixed-target proof is the architect-accepted readonly verify-target
 *   POST (rpc/undo/{requestId}/verify-target { expectedEntity } →
 *   { requestId, matches }), implemented by the backend worker (Agent/API are
 *   never modified here): fresh single-use device-bound token per verify
 *   request, HTTP 200 + exact requestId + matches===true mandatory, explicit
 *   single grant consumed pre-dispatch, no financial idempotency (readonly).
 *   The raw targetLastOperationId never leaves the DO by design. Audit-logs
 *   remain an optional non-gating sanity annotation only.
 * - Ledger reads use the SHARED readAllPages paginator (full limit/offset
 *   loop, validated pages) filtered to the created account, so >100 offpage
 *   duplicates cannot hide.
 * - Resultado incerto NÃO passa neste happy path; lock incerto é provado em
 *   cenário separado determinístico de fixture
 *   (e2e/specs/live-closure-uncertain.spec.ts).
 *
 * Opt-in: PWA_LIVE_E2E=1 + PWA_LIVE_BASE_URL + credenciais da fonte canônica
 * .env.e2e.local (E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD, com fallback aos nomes
 * PWA_LIVE_*; valores nunca logados; resolvidas pelo Planner). Nunca repete
 * aprovações/transações históricas. Retries 0; Idempotency-Key persistente
 * por (RUN_ID, seq numérica). Trace/screenshots exclusivamente em
 * test-results-live-closure0930.
 */
import { test, expect, type Locator, type Page, type Request } from "@playwright/test";
import {
  assertDecisionPostSet,
  assertUndoOffered,
  authorizePendingDecisionWrite,
  authorizeUndoWrite,
  authorizeVerifyWrite,
  buildClosureMarkers,
  buildIdempotencyKey,
  countByDescription,
  decisionPathFor,
  filterTrackedTransactions,
  findFreshUndoProposal,
  isRunOwnedEntity,
  readAllPages,
  validateAuthoritativePendingOp,
  validateDecisionPathForOperation,
  validateLedgerCounts,
  validateNoHistoricReuse,
  validateProposalContent,
  validateReceiptBinding,
  validateScopedHeaders,
  validateTxMutationAllowed,
  validateUndoRequestBody,
  type AuditEntry,
  type TrackedTx,
  CLOSURE_ACTIVE_WS,
} from "../support/live-closure-guards";

const LIVE = process.env.PWA_LIVE_E2E === "1";
const EMAIL = process.env.E2E_ADMIN_EMAIL || process.env.PWA_LIVE_ADMIN_EMAIL || "";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD || process.env.PWA_LIVE_ADMIN_PASSWORD || "";
const LIVE_BASE_URL = process.env.PWA_LIVE_BASE_URL || "";

const ACTIVE_WS = CLOSURE_ACTIVE_WS;
const RUN_ID = `closure0930-${Date.now().toString(36)}`;
const M = buildClosureMarkers(RUN_ID);
// Edit applies a new amount (before 100 → after 150) so before/after is asserted on real state.
const EDITED_AMOUNT_CENTS = 150;
const TED_TOOL = "transactions.expense.create";

type CategoryRow = { id?: unknown; name?: unknown };
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
type ActiveOpRow = {
  id?: unknown;
  status?: unknown;
  tool?: unknown;
  amountCents?: unknown;
  description?: unknown;
  date?: unknown;
  accountId?: unknown;
  categoryId?: unknown;
};

test.describe.configure({ mode: "serial" });

test.describe("live-closure (fechamento autenticado em produção)", () => {
  test.skip(!LIVE || !EMAIL || !PASSWORD || !LIVE_BASE_URL, "Opt-in: PWA_LIVE_E2E=1 + credenciais + base URL via env");

  const shot = async (page: Page, name: string) => {
    await page.screenshot({ path: `test-results-live-closure0930/${name}.png`, fullPage: false });
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
    for (let i = 0; i < 5; i++) {
      await page.evaluate(({ t }: { t: string }) => {
        const dlg = [...document.querySelectorAll("[role=dialog]")].find((d) =>
          (d.getAttribute("aria-label") || "").includes("Chat com TED"),
        );
        if (!dlg) return;
        const ta = dlg.querySelector("textarea");
        if (!ta) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(ta, t);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }, { t: text });
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
    const dispatched = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll("[role=dialog]")].find((d) =>
        (d.getAttribute("aria-label") || "").includes("Chat com TED"),
      );
      const btn = dlg && [...dlg.querySelectorAll("button")].find((b) =>
        (b.getAttribute("aria-label") || "").includes("Enviar mensagem"),
      );
      if (!btn || (btn as HTMLButtonElement).disabled) return false;
      (btn as HTMLButtonElement).click();
      return true;
    });
    if (!dispatched) throw new Error(`mensagem TED não pôde ser enviada: ${text}`);
    await expect(dialog.getByText(text, { exact: true }).first()).toBeVisible({ timeout: 30000 });
  };

  /** Reads the card's rendered financial content (UI-extracted secondary cross-check, never authorizing). */
  const readProposal = async (card: Locator, description: string, accountName: string) => {
    const confirmLabel = await card.getByRole("button", { name: /Confirmar R\$/ }).innerText();
    const amountMatch = /R\$\s*([\d.,]+)/.exec(confirmLabel);
    const amountCents = amountMatch
      ? Math.round(Number.parseFloat(amountMatch[1]!.replace(/\./g, "").replace(",", ".")) * 100)
      : Number.NaN;
    return {
      description: (await card.getByText(description, { exact: true }).innerText()).trim(),
      accountLabel: (await card.getByText(accountName, { exact: true }).innerText()).trim(),
      categoryLabel: (await card.getByText("Lanche", { exact: true }).innerText()).trim(),
      amountCents,
    };
  };

  test("fechamento: criar → editar → confirmar → desfazer → cancelar → reload → excluir", async ({ page }) => {
    test.setTimeout(600_000);
    validateNoHistoricReuse([M.txDesc, M.txDescTed, M.txDescTed2, M.txDescEdit, M.accountName]);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const serverErrors: string[] = [];
    const workspaceWriteViolations: string[] = [];
    const blockedEarlyAgentTokenAttempts: string[] = [];
    const decisionRequestPaths: string[] = [];
    const decisionBodies: string[] = [];
    const undoDecisionPaths: string[] = [];
    const undoBodies: string[] = [];
    const verifyPaths: string[] = [];
    const verifyBodies: string[] = [];
    // Closed sets — populated only from authoritative captures inside THIS run.
    const allowedTxIds = new Set<string>();
    const allowedDecisions = new Map<string, "confirm" | "cancel" | "retry">();
    const txMutationCounts = new Map<string, number>();
    let expectedUndo: { requestId: string } | undefined;
    let expectedVerify: { requestId: string; entityType: string; entityId: string } | undefined;
    let authComplete = false;
    let workspaceGuardReady = false;
    let collectServerErrors = false;
    let idemSeq = 0;
    const nextIdemKey = () => buildIdempotencyKey(RUN_ID, idemSeq++);

    const toLoggedPath = (raw: string) => {
      if (!raw) return "";
      try {
        return new URL(raw).pathname;
      } catch {
        return raw.split(/[?#]/, 1)[0]?.slice(0, 120) ?? "";
      }
    };
    const safePostData = (request: Request): string => {
      try {
        return request.postData() ?? "";
      } catch {
        return "";
      }
    };
    page.on("pageerror", (err) => pageErrors.push(`pageerror: ${String(err?.message || err).slice(0, 300)}`));
    page.on("console", (message) => {
      if (!authComplete || message.type() !== "error") return;
      const text = message.text();
      if (text === "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector") return;
      consoleErrors.push(`${text.slice(0, 300)} @ ${toLoggedPath(message.location()?.url ?? "")}`);
    });
    page.on("response", (response) => {
      if (!collectServerErrors) return;
      if (response.status() < 500) return;
      const req = response.request();
      serverErrors.push(`${req.method().toUpperCase()} ${toLoggedPath(req.url())} -> ${response.status()}`);
    });
    const allowedBackendWrites = new Set([
      "POST /api/backend/auth/agent-token",
      "POST /api/backend/categories/apply-defaults",
      "POST /api/backend/accounts",
      "POST /api/backend/transactions/detect-duplicate",
      "POST /api/backend/transactions/expense",
    ]);
    page.on("request", (request: Request) => {
      if (request.method() !== "POST") return;
      const pathname = new URL(request.url()).pathname;
      if (/^\/api\/agent\/agents\/finance-chat-agent\/[^/]+\/rpc\/pending-operations\/[^/]+\/decision$/.test(pathname)) {
        decisionRequestPaths.push(pathname);
        decisionBodies.push(safePostData(request));
      }
      if (pathname === `/api/agent/agents/finance-chat-agent/${ACTIVE_WS}/rpc/undo/decision`) {
        undoDecisionPaths.push(pathname);
        undoBodies.push(safePostData(request));
      }
      const verifyMatch = pathname.match(/^\/api\/agent\/agents\/finance-chat-agent\/[^/]+\/rpc\/undo\/[^/]+\/verify-target$/);
      if (request.method() === "POST" && verifyMatch) {
        verifyPaths.push(pathname);
        verifyBodies.push(safePostData(request));
      }
    });
    const appOrigin = new URL(LIVE_BASE_URL).origin;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const url = new URL(request.url());
      const path = url.pathname;
      const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
      const rawHeaders = request.headers() as Record<string, string | undefined>;
      const workspaceHeader = rawHeaders["x-workspace-id"];
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
      // ── PRE-DISPATCH agent decision gate (closed set + body + header; consumed before continue) ──
      const decMatch = path.match(/^\/api\/agent\/agents\/finance-chat-agent\/([^/]+)\/rpc\/pending-operations\/([^/]+)\/decision$/);
      if (method === "POST" && decMatch) {
        const opId = decMatch[2]!;
        const registered = allowedDecisions.get(opId);
        let headerReason = "";
        try {
          validateScopedHeaders(rawHeaders, ACTIVE_WS);
        } catch (e) {
          headerReason = (e as Error).message;
        }
        const auth = authorizePendingDecisionWrite(
          { pathWorkspace: decMatch[1]!, operationId: opId, bodyText: safePostData(request) },
          registered ? { workspaceId: ACTIVE_WS, operationId: opId, decision: registered } : undefined,
        );
        if (!workspaceGuardReady || headerReason || !auth.allowed) {
          workspaceWriteViolations.push(
            `refused agent decision ${method} ${path}: ${!workspaceGuardReady ? "guard not ready" : headerReason || auth.reason}`,
          );
          await route.abort("blockedbyclient");
          return;
        }
        allowedDecisions.delete(opId); // consume BEFORE continue: no replay
        await route.continue();
        return;
      }
      if (method === "POST" && path === `/api/agent/agents/finance-chat-agent/${ACTIVE_WS}/rpc/undo/decision`) {
        let headerReason = "";
        try {
          validateScopedHeaders(rawHeaders, ACTIVE_WS);
        } catch (e) {
          headerReason = (e as Error).message;
        }
        const auth = authorizeUndoWrite(
          { pathWorkspace: ACTIVE_WS, bodyText: safePostData(request) },
          expectedUndo ? { workspaceId: ACTIVE_WS, requestId: expectedUndo.requestId, decision: "confirm" } : undefined,
        );
        if (!workspaceGuardReady || headerReason || !auth.allowed) {
          workspaceWriteViolations.push(
            `refused undo decision ${method} ${path}: ${!workspaceGuardReady ? "guard not ready" : headerReason || auth.reason}`,
          );
          await route.abort("blockedbyclient");
          return;
        }
        expectedUndo = undefined; // consume BEFORE continue: no replay
        await route.continue();
        return;
      }
      // ── PRE-DISPATCH verify-target gate (readonly POST, explicit single
      // grant only — never any verify generically; consumed before continue) ──
      const verifyMatch = path.match(/^\/api\/agent\/agents\/finance-chat-agent\/([^/]+)\/rpc\/undo\/([^/]+)\/verify-target$/);
      if (method === "POST" && verifyMatch) {
        const verifyReqId = verifyMatch[2]!;
        let headerReason = "";
        try {
          validateScopedHeaders(rawHeaders, ACTIVE_WS);
        } catch (e) {
          headerReason = (e as Error).message;
        }
        const auth = authorizeVerifyWrite(
          { pathWorkspace: verifyMatch[1]!, pathRequestId: verifyReqId, bodyText: safePostData(request) },
          expectedVerify
            ? { workspaceId: ACTIVE_WS, requestId: expectedVerify.requestId, entityType: expectedVerify.entityType, entityId: expectedVerify.entityId }
            : undefined,
        );
        if (!workspaceGuardReady || headerReason || !auth.allowed) {
          workspaceWriteViolations.push(
            `refused verify-target ${method} ${path}: ${!workspaceGuardReady ? "guard not ready" : headerReason || auth.reason}`,
          );
          await route.abort("blockedbyclient");
          return;
        }
        expectedVerify = undefined; // consume BEFORE continue: single verify
        await route.continue();
        return;
      }
      // ── Closed-set transaction mutations (counted; exact totals asserted at the end) ──
      if ((method === "PATCH" || method === "DELETE") && path.startsWith("/api/backend/transactions/")) {
        const txId = path.split("/").pop() ?? "";
        try {
          if (!workspaceGuardReady) throw new Error("workspace guard not ready");
          validateScopedHeaders(rawHeaders, ACTIVE_WS);
          validateTxMutationAllowed(txId, [...allowedTxIds]);
        } catch (e) {
          workspaceWriteViolations.push(`refused tx mutation ${method} ${path}: ${(e as Error).message}`);
          await route.abort("blockedbyclient");
          return;
        }
        txMutationCounts.set(`${method}:${txId}`, (txMutationCounts.get(`${method}:${txId}`) ?? 0) + 1);
        await route.continue();
        return;
      }
      const globalBackendReads = new Set([
        "/api/backend/auth/session",
        "/api/backend/auth/get-session",
        "/api/backend/workspaces",
        "/api/backend/health",
        "/api/backend/auth/devices/me",
      ]);
      const workspaceBackendPath = path.startsWith("/api/backend/") && !globalBackendReads.has(path);
      const agentPath = path.startsWith("/api/agent/");
      const agentMatch = path.match(/^\/api\/agent\/agents\/finance-chat-agent\/([^/]+)\/rpc\/(.+)$/);
      const agentWorkspaceMatches = agentPath && agentMatch?.[1] === ACTIVE_WS;
      const authBootstrap = method === "POST" && (
        path === "/api/backend/auth/sign-in/email" ||
        path === "/api/backend/auth/devices/register"
      );
      const allowedBackendWrite = allowedBackendWrites.has(`${method} ${path}`);
      if (method === "POST" && path === "/api/backend/auth/agent-token" && (!workspaceGuardReady || workspaceHeader !== ACTIVE_WS)) {
        blockedEarlyAgentTokenAttempts.push(`${method} ${path} workspace=${workspaceHeader ?? "<missing>"} ready=${workspaceGuardReady}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (authBootstrap && mutating) {
        await route.continue();
        return;
      }
      const scopedRequest = workspaceBackendPath || agentPath || allowedBackendWrite;
      const wrongWorkspace = workspaceHeader !== ACTIVE_WS || (agentPath && !agentWorkspaceMatches);
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
      // Only the chat RPC remains agent-mutable here; decisions/undo passed
      // through the pre-dispatch gates above and already continued.
      if (mutating && agentPath) {
        const rpc = agentMatch?.[2] ?? "";
        if (!(method === "POST" && rpc === "chat")) {
          workspaceWriteViolations.push(`unexpected agent write ${method} ${path}`);
          await route.abort("blockedbyclient");
          return;
        }
      }
      if (mutating) {
        const rpc = agentMatch?.[2] ?? "";
        const allowedWrite = allowedBackendWrite || (agentPath && method === "POST" && rpc === "chat");
        if (!allowedWrite) {
          workspaceWriteViolations.push(`unexpected api write ${method} ${path}`);
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.continue();
    });

    // ── Authoritative read helpers (existing outbound contracts only) ──
    // Product agent-auth flow replica (agent-auth.ts + agent-client.ts):
    // cookie-only agent calls answer device-bound 401, so every agent call
    // mints a FRESH single-use connection token via POST
    // /api/backend/auth/agent-token (session cookie + X-Workspace-Id + device
    // token on the explicit T2.5 channel, read from the device helper's
    // storage "pi-finance:token" initialized at device register/login), then
    // calls once with x-agent-connection-token. A failed mint FAILs explicit
    // — NO session-only fallback retry: falling back would mask
    // approval_context_required and poison verify matches. Token values stay
    // in page memory; only statuses/bodies are returned (tokens never
    // logged). No handler is weakened and no endpoint is created.
    const mintAgentToken = (ws: string) => page.evaluate(async (workspaceId: string) => {
      let deviceToken: string | null = null;
      try {
        deviceToken = localStorage.getItem("pi-finance:token");
      } catch {
        deviceToken = null;
      }
      const res = await fetch("/api/backend/auth/agent-token", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-Id": workspaceId,
          ...(deviceToken ? { "x-device-token": deviceToken } : {}),
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) return { status: res.status, token: null as string | null };
      const body = await res.json().catch(() => ({})) as { token?: unknown };
      return typeof body.token === "string" && body.token
        ? { status: res.status, token: body.token as string | null }
        : { status: res.status, token: null as string | null };
    }, ws);

    const authedAgentGet = async (rpcPath: string) => {
      const mint = await mintAgentToken(ACTIVE_WS);
      if (!mint.token) {
        return { status: mint.status, ok: false as const, body: {} as Record<string, unknown> };
      }
      return page.evaluate(async ({ ws, rpc, token }: { ws: string; rpc: string; token: string }) => {
        const res = await fetch(`/api/agent/agents/finance-chat-agent/${encodeURIComponent(ws)}/rpc/${rpc}`, {
          credentials: "include",
          headers: { "x-agent-connection-token": token, "X-Workspace-Id": ws },
        });
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        return { status: res.status, ok: res.ok, body };
      }, { ws: ACTIVE_WS, rpc: rpcPath, token: mint.token });
    };

    // Readonly verify POST (no financial effect, no idempotency key): fresh
    // single-use token per verify request, same device-bound mint.
    const authedAgentVerify = async (requestId: string, entityType: string, entityId: string) => {
      const mint = await mintAgentToken(ACTIVE_WS);
      if (!mint.token) {
        return { status: mint.status, ok: false as const, body: {} as Record<string, unknown> };
      }
      return page.evaluate(async ({ ws, rid, etype, eid, token }: { ws: string; rid: string; etype: string; eid: string; token: string }) => {
        const res = await fetch(`/api/agent/agents/finance-chat-agent/${encodeURIComponent(ws)}/rpc/undo/${encodeURIComponent(rid)}/verify-target`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "x-agent-connection-token": token, "X-Workspace-Id": ws },
          body: JSON.stringify({ expectedEntity: { type: etype, id: eid } }),
        });
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        return { status: res.status, ok: res.ok, body };
      }, { ws: ACTIVE_WS, rid: requestId, etype: entityType, eid: entityId, token: mint.token });
    };

    const fetchActiveOps = async () => {
      const r = await authedAgentGet("pending-operations/active");
      if (!r.ok) {
        throw new Error(`BLOCKED: authoritative pending-operations/active unreadable (status ${r.status}) — device-bound agent auth required, no cookie fallback`);
      }
      const items = (r.body as { items?: unknown }).items;
      return { status: r.status, items: Array.isArray(items) ? (items as ActiveOpRow[]) : [] };
    };

    const fetchUndoActive = async () => {
      const r = await authedAgentGet("undo/active");
      if (!r.ok) {
        throw new Error(`BLOCKED: authoritative undo/active unreadable (status ${r.status}) — device-bound agent auth required, no cookie fallback`);
      }
      const items = (r.body as { items?: unknown }).items;
      return { status: r.status, items: Array.isArray(items) ? (items as UndoRow[]) : [] };
    };

    type UndoRow = { requestId?: unknown; status?: unknown; expiresAt?: unknown };

    // Backend cookie read (workspace membership auth, no agent token needed).
    // OPTIONAL sanity only: never gates the run (the verify-target POST is
    // the proof). Failures are annotated, never thrown.
    const fetchAuditByEntity = (entityId: string, operation: string) => page.evaluate(
      async ({ ws, eid, operation: op }: { ws: string; eid: string; operation: string }) => {
        const res = await fetch(
          `/api/backend/audit-logs?entityId=${encodeURIComponent(eid)}&operation=${encodeURIComponent(op)}&limit=10`,
          { credentials: "include", headers: { "X-Workspace-Id": ws } },
        );
        const body = await res.json().catch(() => ({})) as { items?: unknown };
        return { status: res.status, items: Array.isArray(body.items) ? (body.items as AuditEntry[]) : [] };
      },
      { ws: ACTIVE_WS, eid: entityId, operation },
    );

    // Full paginated ledger via the SHARED readAllPages (every page validated;
    // offpage duplicates cannot hide), filtered to the created account.
    const readLedger = async (accountId: string, descs: string[]): Promise<TrackedTx[]> => {
      const all = await readAllPages<TransactionRow>(
        (offset, limit) => page.evaluate(async ({ ws, offset: off, limit: lim }: { ws: string; offset: number; limit: number }) => {
          const res = await fetch(`/api/backend/transactions?limit=${lim}&offset=${off}`, {
            credentials: "include",
            headers: { "X-Workspace-Id": ws },
          });
          const body = await res.json().catch(() => ({})) as { items?: unknown; total?: unknown };
          return {
            status: res.status,
            items: Array.isArray(body.items) ? (body.items as TransactionRow[]) : [],
            total: body.total,
            offset: off,
            limit: lim,
          };
        }, { ws: ACTIVE_WS, offset, limit }),
        100,
      );
      if (all.status !== 200) throw new Error(`ledger unreadable: ${all.status}`);
      return filterTrackedTransactions(all.items, accountId, descs);
    };

    const readDashboardTotal = () => page.evaluate(async (ws: string) => {
      const res = await fetch(`/api/backend/dashboard/summary`, {
        credentials: "include",
        headers: { "X-Workspace-Id": ws },
      });
      const body = await res.json().catch(() => ({})) as { totalBalanceCents?: unknown };
      return { status: res.status, total: body.totalBalanceCents ?? null };
    }, ACTIVE_WS);

    // ── LOGIN + Test Family ──
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const emailInput = page.locator("#email").or(page.getByLabel("E-mail")).or(page.getByPlaceholder(/email/i));
    const passwordInput = page.locator("#password").or(page.getByLabel("Senha"));
    await expect(emailInput.first()).toBeVisible({ timeout: 30000 });
    await emailInput.first().fill(EMAIL);
    await passwordInput.first().fill(PASSWORD);
    collectServerErrors = true;
    await page.getByRole("button", { name: "Entrar" }).click();
    const fab = page.getByRole("button", { name: "Nova transação" });
    await expect(fab).toBeVisible({ timeout: 30000 });
    authComplete = true;
    await page.getByRole("button", { name: "Selecionar espaço" }).click();
    await page.getByRole("option", { name: /Test Family/ }).click();
    await expect(page.getByRole("button", { name: "Selecionar espaço" })).toContainText("Test Family", { timeout: 15000 });
    workspaceGuardReady = true;
    await shot(page, "01-home");

    // ── CRIAR conta (fixture única do run) ──
    await page.goto("/hub/patrimonio?aba=contas", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Selecionar espaço" })).toContainText("Test Family", { timeout: 15000 });
    expect(await page.getByText(M.accountName).count()).toBe(0);
    await page.getByRole("button", { name: "Nova", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Nova conta" })).toBeVisible({ timeout: 15000 });
    await page.getByPlaceholder("Ex: Nubank, Itaú...").fill(M.accountName);
    await page.getByPlaceholder("0,00").fill("100,00");
    const createResponse = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/backend/accounts",
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Salvar" }).click();
    const accountResult = await createResponse;
    expect(accountResult.status()).toBeLessThan(300);
    const accountBody = await accountResult.json() as { id?: unknown };
    const testAccountId = String(accountBody.id ?? "");
    expect(testAccountId.length).toBeGreaterThan(0);
    validateNoHistoricReuse([testAccountId]);
    await expect(page.getByText(M.accountName).first()).toBeVisible({ timeout: 20000 });

    // Categorias oficiais + Lanche
    const defaults = await page.evaluate(async ({ ws, key }: { ws: string; key: string }) => {
      const res = await fetch("/api/backend/categories/apply-defaults", {
        method: "POST",
        credentials: "include",
        headers: { "X-Workspace-Id": ws, "Idempotency-Key": key },
      });
      return { status: res.status };
    }, { ws: ACTIVE_WS, key: nextIdemKey() });
    expect(defaults.status).toBe(200);
    const lancheCategoryId = await page.evaluate(async (ws: string) => {
      const response = await fetch("/api/backend/categories", {
        credentials: "include",
        headers: { "X-Workspace-Id": ws },
      });
      const body = await response.json().catch(() => ({})) as { items?: CategoryRow[] };
      return String(body.items?.find((c) => c.name === "Lanche")?.id ?? "");
    }, ACTIVE_WS);
    expect(lancheCategoryId.length).toBeGreaterThan(0);

    // ── CRIAR transação via sheet (UI real, R$ 1,00) ──
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Selecionar espaço" })).toContainText("Test Family", { timeout: 15000 });
    await fab.click();
    const launchGroup = page.getByRole("group", { name: "Novo lançamento" });
    await expect(launchGroup).toBeVisible({ timeout: 10000 });
    await launchGroup.getByRole("button", { name: "Despesa" }).click();
    const txSheet = page.getByRole("dialog", { name: /Nova despesa|Novo lançamento/ });
    await expect(txSheet.getByPlaceholder("0,00")).toBeVisible({ timeout: 15000 });
    await txSheet.getByPlaceholder("0,00").fill("1,00");
    await txSheet.getByPlaceholder("Ex: Aluguel, mercado...").fill(M.txDesc);
    await txSheet.getByRole("button", { name: "Selecionar categoria" }).click();
    const catPicker = page.getByRole("dialog", { name: "Categoria" });
    await catPicker.getByRole("button", { name: "Alimentação" }).first().click();
    const lanche = catPicker.getByRole("button", { name: "Lanche", exact: true });
    await expect(lanche).toBeVisible({ timeout: 10000 });
    await lanche.click();
    await expect(catPicker).toBeHidden({ timeout: 10000 });
    await txSheet.getByRole("button", { name: "Selecionar conta ou cartão" }).click();
    const accountPicker = page.getByRole("dialog", { name: /^Conta/ });
    const accountOption = accountPicker.getByRole("button", { name: new RegExp(M.accountName) }).first();
    await accountOption.scrollIntoViewIfNeeded();
    await accountOption.click();
    await expect(accountPicker).toBeHidden({ timeout: 10000 });
    const txCreate = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/transactions/expense"), { timeout: 30000 });
    await txSheet.getByRole("button", { name: /^Salvar$/ }).click();
    const txResponse = await txCreate;
    expect(txResponse.status()).toBeLessThan(300);
    const seeded = await txResponse.json() as { id?: unknown; date?: unknown };
    const seedTxId = String(seeded.id ?? "");
    const seedTxDate = typeof seeded.date === "string" ? seeded.date.slice(0, 10) : "";
    expect(seedTxId.length).toBeGreaterThan(0);
    expect(seedTxDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    validateNoHistoricReuse([seedTxId]);
    allowedTxIds.add(seedTxId);
    await expect(txSheet).toBeHidden({ timeout: 20000 });

    // ── EDITAR via UI (registros → Editar → PATCH para R$ 1,50 + nova descrição) ──
    await page.goto("/registros", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(M.txDesc).first()).toBeVisible({ timeout: 30000 });
    await page.getByText(M.txDesc).first().click();
    await expect(page.getByRole("button", { name: "Editar" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Editar" }).click();
    await expect(page.getByText("Editar lançamento")).toBeVisible({ timeout: 10000 });
    const editSheet = page.locator('[role="dialog"]');
    const descInput = editSheet.locator("input").first();
    await expect(descInput).toBeVisible();
    await descInput.fill(M.txDescEdit);
    await editSheet.getByPlaceholder("0,00").fill("1,50");
    validateNoHistoricReuse([M.txDescEdit]);
    const editPatch = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/backend/transactions/${seedTxId}`,
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Salvar" }).click();
    const editResult = await editPatch;
    expect(editResult.status()).toBeLessThan(300);
    await expect(page.getByText("Editar lançamento")).not.toBeVisible({ timeout: 10000 });
    // Leitura autoritativa paginada: descrição + valor editados + vínculos.
    const editedTracked = await readLedger(testAccountId, [M.txDescEdit]);
    expect(countByDescription(editedTracked, M.txDescEdit)).toBe(1);
    const editedTx = editedTracked.find((t) => t.id === seedTxId);
    expect(editedTx?.description).toBe(M.txDescEdit);
    expect(editedTx?.amountCents).toBe(EDITED_AMOUNT_CENTS);
    expect(editedTx?.accountId).toBe(testAccountId);
    expect(editedTx?.categoryId).toBe(lancheCategoryId);
    await shot(page, "02-editado");

    // Snapshot de saldo pré-approval (base da comparação pós-undo).
    const preBalance = await readDashboardTotal();
    expect(preBalance.status).toBe(200);
    expect(typeof preBalance.total).toBe("number");

    // ── TED CONFIRMAR: binding autoritativo → registro → clique ──
    const dialog = await openTed(page);
    // Capture OUR turn's pending id from the chat RESPONSE (never first-stale:
    // an older run's pending card may still be listed and must stay untouched —
    // existing PENDING from other runs is never repeated or decided here).
    const proposeChatResp = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/rpc/chat"),
      { timeout: 180_000 },
    );
    await sendTedMessage(page, dialog, `Na conta ${M.accountName}, categoria Lanche, hoje gastei R$ 2,00 ${M.txDescTed}`);
    const proposeResult = await proposeChatResp;
    const proposeBody = await proposeResult.json() as { pendingOperation?: { id?: unknown } };
    const freshProposeId = typeof proposeBody.pendingOperation?.id === "string" ? proposeBody.pendingOperation.id : "";
    if (!freshProposeId) {
      throw new Error(`BLOCKED: chat turn minted no pendingOperation for ${M.txDescTed} — refusing stale first-card`);
    }
    validateNoHistoricReuse([freshProposeId]);
    // Exact DOM selection by pending id (no .first() over possibly stale
    // cards), plus args markers proving it is our card.
    const approvalCard = dialog.locator(`[id="ted-op-${freshProposeId}"]`);
    await expect(approvalCard).toBeVisible({ timeout: 180_000 });
    await expect(approvalCard.getByText(M.txDescTed, { exact: true })).toBeVisible({ timeout: 30000 });
    const wrapperId = await approvalCard.getAttribute("id");
    expect(wrapperId).toBe(`ted-op-${freshProposeId}`);
    const operationId = freshProposeId;
    validateNoHistoricReuse([operationId]);
    const decisionPath = decisionPathFor(ACTIVE_WS, operationId);
    validateDecisionPathForOperation(decisionPath, ACTIVE_WS, operationId);
    // PRIMARY: authoritative active record binds args before any authorization.
    const activeConfirm = await fetchActiveOps();
    expect(activeConfirm.status).toBe(200);
    const authConfirmOp = activeConfirm.items.find((o) => o.id === operationId);
    if (!authConfirmOp) {
      throw new Error(`BLOCKED: op ${operationId} absent from authoritative pending-operations/active — card is secondary, click refused`);
    }
    validateAuthoritativePendingOp(authConfirmOp, {
      operationId,
      status: "proposed",
      tool: TED_TOOL,
      amountCents: 200,
      description: M.txDescTed,
      accountId: testAccountId,
      categoryId: lancheCategoryId,
    });
    // SECONDARY: card cross-check (agree, never lead).
    validateProposalContent(
      await readProposal(approvalCard, M.txDescTed, M.accountName),
      { description: M.txDescTed, accountLabel: M.accountName, categoryLabel: "Lanche", amountCents: 200 },
    );
    const approvalDetails = await approvalCard.locator("dl").innerText();
    expect(approvalDetails).toContain(M.txDescTed);
    // Register THEN click (guard authorizes the dispatch; grant is consumed on use).
    allowedDecisions.set(operationId, "confirm");
    const confirmBtn = approvalCard.getByRole("button", { name: /Confirmar R\$\s*2[.,]00/i });
    await expect(confirmBtn).toBeVisible();
    const decisionResponse = page.waitForResponse((response) => {
      const p = new URL(response.url()).pathname;
      return response.request().method() === "POST" && p === decisionPath;
    }, { timeout: 120_000 });
    await confirmBtn.evaluate((btn) => (btn as HTMLButtonElement).click());
    const decisionResult = await decisionResponse;
    expect(decisionResult.status()).toBeLessThan(300);
    // Happy path exige succeeded + recibo: incerto falha aqui (lock incerto é
    // provado no cenário determinístico de fixture, nunca como pass parcial).
    if (await dialog.getByText(/resultado desta opera.*atualize/i).count() > 0) {
      throw new Error(`live happy path requires a succeeded receipt but op ${operationId} went uncertain — see the fixture uncertain scenario`);
    }
    const decisionBody = await decisionResult.json() as {
      operationId?: unknown;
      status?: unknown;
      receipt?: { status?: unknown; operationId?: unknown; mutationId?: unknown; entity?: { type?: unknown; id?: unknown } };
    };
    const receiptEntityId = validateReceiptBinding(decisionBody, operationId);
    allowedTxIds.add(receiptEntityId);
    await expect(confirmBtn).toBeHidden({ timeout: 60000 });
    // Ledger paginado amarra receipt.entity.id (descrição + valor + conta + categoria).
    const tedTracked = await readLedger(testAccountId, [M.txDescTed]);
    expect(countByDescription(tedTracked, M.txDescTed)).toBe(1);
    const tedTx = tedTracked.find((t) => t.id === receiptEntityId);
    expect(tedTx?.description).toBe(M.txDescTed);
    expect(tedTx?.amountCents).toBe(200);
    expect(tedTx?.accountId).toBe(testAccountId);
    expect(tedTx?.categoryId).toBe(lancheCategoryId);
    // Audit sanity (OPTIONAL, never gating): best-effort record of the
    // confirmed mutation in audit-logs. The verify-target POST below is the
    // proof; this annotation cannot pass or fail the run.
    try {
      const auditSanity = await fetchAuditByEntity(receiptEntityId, TED_TOOL);
      test.info().annotations.push({
        type: "closure-audit-sanity",
        description: `audit by entity status=${auditSanity.status} entries=${auditSanity.items.length}`,
      });
    } catch (e) {
      test.info().annotations.push({
        type: "closure-audit-sanity",
        description: `audit sanity unavailable: ${(e as Error).message.slice(0, 120)}`,
      });
    }
    test.info().annotations.push({ type: "closure-confirm", description: `op ${operationId} entity ${receiptEntityId}` });
    await shot(page, "03-ted-confirm");

    // ── DESFAZER OBRIGATÓRIO: turn.undoProposal + fresh + verify-target → registro → clique ──
    // O card nasce EXCLUSIVAMENTE do turno estruturado do agente; a mensagem
    // abaixo o solicita pelo produto. A associação ao alvo é provada pelo
    // verify-target aceito pelo Arquiteto (POST readonly
    // rpc/undo/{requestId}/verify-target { expectedEntity } → { requestId,
    // matches }); o target bruto nunca sai do DO por desenho. Sem prova,
    // nada é clicado (FAIL blocked) e nenhum write direto via API substitui
    // o fluxo UI. Agent/API não são modificados por este spec.
    const undoBefore = await fetchUndoActive();
    expect(undoBefore.status).toBe(200);
    const undoChatResp = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/rpc/chat"),
      { timeout: 180_000 },
    );
    await sendTedMessage(page, dialog, "desfaça a última ação");
    const chatResult = await undoChatResp;
    const chatBody = await chatResult.json() as { undoProposal?: { requestId?: unknown; status?: unknown; expiresAt?: unknown } };
    const turnProposal = chatBody.undoProposal;
    const undoAfter = await fetchUndoActive();
    expect(undoAfter.status).toBe(200);
    if (!turnProposal || typeof turnProposal.requestId !== "string" || !turnProposal.requestId) {
      throw new Error(`BLOCKED: chat turn carried no real undoProposal after confirm op ${operationId} — no click, no API substitute`);
    }
    const fresh = findFreshUndoProposal(undoBefore.items, undoAfter.items);
    if (fresh.requestId !== turnProposal.requestId) {
      throw new Error(`BLOCKED: turn undoProposal ${String(turnProposal.requestId)} disagrees with authoritative fresh ${fresh.requestId}`);
    }
    // Verify-target: grant registrado ANTES do dispatch; consumido no route.
    const verifyPath = `/api/agent/agents/finance-chat-agent/${ACTIVE_WS}/rpc/undo/${fresh.requestId}/verify-target`;
    expectedVerify = { requestId: fresh.requestId, entityType: "transaction", entityId: receiptEntityId };
    const verifyWait = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === verifyPath,
      { timeout: 60_000 },
    );
    const verifyResult = await authedAgentVerify(fresh.requestId, "transaction", receiptEntityId);
    if (verifyResult.status === 404) {
      throw new Error(
        `BLOCKED: verify-target route not implemented by the backend worker — needed shape: POST ${verifyPath} { expectedEntity: { type: 'transaction', id: '<receiptEntityId>' } } → 200 { requestId, matches: true }; refusing undo without this proof`,
      );
    }
    if (verifyResult.status !== 200) {
      throw new Error(`BLOCKED: verify-target failed with status ${verifyResult.status} — refusing undo`);
    }
    const verifyBody = verifyResult.body as { requestId?: unknown; matches?: unknown };
    if (verifyBody.requestId !== fresh.requestId) {
      throw new Error(`BLOCKED: verify-target requestId mismatch — refusing undo`);
    }
    if (verifyBody.matches !== true) {
      throw new Error(`BLOCKED: verify-target matches=false for proposal ${fresh.requestId} — the fixed target is NOT our confirmed mutation; refusing undo`);
    }
    await verifyWait;
    expectedUndo = { requestId: fresh.requestId };
    const undoCard = dialog.getByTestId("ted-undo-card");
    const undoOffered = await undoCard.waitFor({ state: "visible", timeout: 120_000 }).then(() => true).catch(() => false);
    assertUndoOffered(undoOffered, `confirm op ${operationId} proposal ${fresh.requestId}`);
    const undoResp = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/agent/agents/finance-chat-agent/${ACTIVE_WS}/rpc/undo/decision`,
      { timeout: 120_000 },
    );
    await undoCard.getByRole("button", { name: /Confirmar desfazer/ }).click();
    const undoResult = await undoResp;
    expect(undoResult.status()).toBeLessThan(300);
    await expect(dialog.getByTestId("ted-undo-confirmed")).toBeVisible({ timeout: 60000 });
    expect(undoDecisionPaths).toHaveLength(1);
    expect(undoBodies).toHaveLength(1);
    const undoRequestId = validateUndoRequestBody(JSON.parse(undoBodies[0] || "{}"), "confirm");
    expect(undoRequestId).toBe(fresh.requestId);
    test.info().annotations.push({ type: "closure-undo", description: `undo proposal ${undoRequestId} confirmed` });
    // Saldo volta ao snapshot pré-approval; tx editada intacta (150); TED desfeita.
    const afterUndoTracked = await readLedger(testAccountId, [M.txDescEdit, M.txDescTed]);
    const undoneTx = afterUndoTracked.find((t) => t.id === receiptEntityId);
    const editedAfterUndo = afterUndoTracked.find((t) => t.id === seedTxId);
    expect(editedAfterUndo?.amountCents).toBe(EDITED_AMOUNT_CENTS);
    expect(editedAfterUndo?.description).toBe(M.txDescEdit);
    const afterUndoBalance = await readDashboardTotal();
    expect(afterUndoBalance.status).toBe(200);
    expect(afterUndoBalance.total).toBe(preBalance.total);
    if (undoneTx) {
      // Variante reversal do contrato: original presente mas dinheiro devolvido.
      test.info().annotations.push({ type: "closure-undo-variant", description: `reversal: entity ${receiptEntityId} present with balance restored` });
    } else {
      expect(countByDescription(afterUndoTracked, M.txDescTed)).toBe(0);
    }

    // ── Segunda proposta TED → CANCELAR (binding autoritativo → registro → clique) ──
    // Same exact-id selection: OUR turn's pending id from the chat response,
    // never a stale first card from another run.
    const cancelChatResp = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/rpc/chat"),
      { timeout: 180_000 },
    );
    await sendTedMessage(page, dialog, `Na conta ${M.accountName}, categoria Lanche, hoje gastei R$ 3,00 ${M.txDescTed2}`);
    const cancelChatResult = await cancelChatResp;
    const cancelChatBody = await cancelChatResult.json() as { pendingOperation?: { id?: unknown } };
    const freshCancelId = typeof cancelChatBody.pendingOperation?.id === "string" ? cancelChatBody.pendingOperation.id : "";
    if (!freshCancelId) {
      throw new Error(`BLOCKED: chat turn minted no pendingOperation for ${M.txDescTed2} — refusing stale first-card`);
    }
    validateNoHistoricReuse([freshCancelId]);
    const cancelCard = dialog.locator(`[id="ted-op-${freshCancelId}"]`);
    await expect(cancelCard).toBeVisible({ timeout: 180_000 });
    await expect(cancelCard.getByText(M.txDescTed2, { exact: true })).toBeVisible({ timeout: 30000 });
    const cancelWrapperId = await cancelCard.getAttribute("id");
    expect(cancelWrapperId).toBe(`ted-op-${freshCancelId}`);
    const cancelOpId = freshCancelId;
    validateNoHistoricReuse([cancelOpId]);
    const cancelPath = decisionPathFor(ACTIVE_WS, cancelOpId);
    validateDecisionPathForOperation(cancelPath, ACTIVE_WS, cancelOpId);
    const activeCancel = await fetchActiveOps();
    expect(activeCancel.status).toBe(200);
    const authCancelOp = activeCancel.items.find((o) => o.id === cancelOpId);
    if (!authCancelOp) {
      throw new Error(`BLOCKED: op ${cancelOpId} absent from authoritative pending-operations/active — click refused`);
    }
    validateAuthoritativePendingOp(authCancelOp, {
      operationId: cancelOpId,
      status: "proposed",
      tool: TED_TOOL,
      amountCents: 300,
      description: M.txDescTed2,
      accountId: testAccountId,
      categoryId: lancheCategoryId,
    });
    validateProposalContent(
      await readProposal(cancelCard, M.txDescTed2, M.accountName),
      { description: M.txDescTed2, accountLabel: M.accountName, categoryLabel: "Lanche", amountCents: 300 },
    );
    allowedDecisions.set(cancelOpId, "cancel");
    const cancelResp = page.waitForResponse((response) => {
      const p = new URL(response.url()).pathname;
      return response.request().method() === "POST" && p === cancelPath;
    }, { timeout: 120_000 });
    await cancelCard.getByRole("button", { name: "Cancelar" }).click();
    const cancelResult = await cancelResp;
    expect(cancelResult.status()).toBeLessThan(300);
    const cancelBody = await cancelResult.json() as { operationId?: unknown; status?: unknown; receipt?: unknown };
    expect(cancelBody.operationId).toBe(cancelOpId);
    expect(cancelBody.status).toBe("cancelled");
    expect(cancelBody.receipt).toBeUndefined();
    const notCreatedTracked = await readLedger(testAccountId, [M.txDescTed2]);
    expect(countByDescription(notCreatedTracked, M.txDescTed2)).toBe(0);

    // ── RECUPERAÇÃO: reload preserva workspace/operação, exatamente-uma-vez, counts exatos ──
    const decisionsBeforeReload = [...decisionRequestPaths];
    const undoBeforeReload = [...undoDecisionPaths];
    const reloadReq = page.waitForRequest(
      (r) => r.method() === "GET" && r.url().includes("/api/backend/accounts"),
      { timeout: 30000 },
    );
    await page.goto("/hub/patrimonio?aba=contas", { waitUntil: "domcontentloaded" });
    const reloadRead = await reloadReq;
    expect(reloadRead.headers()["x-workspace-id"]).toBe(ACTIVE_WS);
    const pref = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("pi-finance:active-workspace-preference");
        const parsed = raw ? JSON.parse(raw) : null;
        return { workspaceId: parsed?.workspaceId ?? null, principalId: parsed?.principalId ?? null, current: localStorage.getItem("pi-finance:offline-principal") };
      } catch {
        return { workspaceId: null, principalId: null, current: null };
      }
    });
    expect(pref.workspaceId).toBe(ACTIVE_WS);
    expect(pref.principalId).toBe(pref.current);
    await expect(page.getByRole("button", { name: "Selecionar espaço" })).toContainText("Test Family", { timeout: 15000 });
    // Snapshot read-only: nenhuma decisão nova sai do reload.
    expect(decisionRequestPaths).toEqual(decisionsBeforeReload);
    expect(undoDecisionPaths).toEqual(undoBeforeReload);
    // Counts exatos pós-reload: 1 editada (150), TED desfeita 0, TED2 cancelada 0.
    const recheckTracked = await readLedger(testAccountId, [M.txDescEdit, M.txDescTed, M.txDescTed2]);
    validateLedgerCounts(
      {
        edited: countByDescription(recheckTracked, M.txDescEdit),
        ted: countByDescription(recheckTracked, M.txDescTed),
        ted2: countByDescription(recheckTracked, M.txDescTed2),
      },
      { edited: 1, ted: 0, ted2: 0 },
    );
    expect(recheckTracked.find((t) => t.id === seedTxId)?.amountCents).toBe(EDITED_AMOUNT_CENTS);
    await shot(page, "04-reload");

    // ── EXCLUIR via UI somente o que este RUN_ID criou (entity-real guard) ──
    await page.goto("/registros", { waitUntil: "domcontentloaded" });
    // Amarração entidade-real ANTES do DELETE: id do closed set → ledger por
    // id → descrição do RUN_ID + conta criada no run + valor editado.
    const targetTracked = await readLedger(testAccountId, [M.txDescEdit]);
    const target = targetTracked.find((t) => t.id === seedTxId);
    validateTxMutationAllowed(seedTxId, [...allowedTxIds]);
    if (!target || !isRunOwnedEntity(target.description, RUN_ID) || target.accountId !== testAccountId || target.amountCents !== EDITED_AMOUNT_CENTS) {
      throw new Error(`refusing to delete: entity binding failed for ${seedTxId}`);
    }
    const row = page.getByText(M.txDescEdit).first();
    await expect(row).toBeVisible({ timeout: 30000 });
    await row.click();
    await expect(page.getByRole("button", { name: "Editar" })).toBeHidden({ timeout: 10000 }).catch(() => {});
    await expect(page.getByRole("button", { name: "Cancelar" })).toBeVisible({ timeout: 10000 });
    const deleteResp = page.waitForResponse(
      (r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === `/api/backend/transactions/${seedTxId}`,
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Excluir" }).last().click();
    const deleteResult = await deleteResp;
    expect(deleteResult.status()).toBeLessThan(300);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByText(M.txDescEdit)).toHaveCount(0, { timeout: 15000 });
    const afterDeleteTracked = await readLedger(testAccountId, [M.txDescEdit, M.txDesc, M.txDescTed, M.txDescTed2]);
    validateLedgerCounts(
      {
        [M.txDescEdit]: countByDescription(afterDeleteTracked, M.txDescEdit),
        [M.txDesc]: countByDescription(afterDeleteTracked, M.txDesc),
        [M.txDescTed]: countByDescription(afterDeleteTracked, M.txDescTed),
        [M.txDescTed2]: countByDescription(afterDeleteTracked, M.txDescTed2),
      },
      { [M.txDescEdit]: 0, [M.txDesc]: 0, [M.txDescTed]: 0, [M.txDescTed2]: 0 },
    );
    await shot(page, "05-excluido");

    // ── HIGIENE + cardinalidade exata (2 decisões + 1 undo + 1 verify; grants consumidos) ──
    assertDecisionPostSet(decisionRequestPaths, [decisionPath, cancelPath]);
    expect(undoDecisionPaths).toHaveLength(1);
    expect(verifyPaths).toEqual([verifyPath]);
    expect(verifyBodies).toHaveLength(1);
    const parsedDecisions = decisionBodies.map((b) => {
      try {
        return (JSON.parse(b) as { decision?: unknown }).decision;
      } catch {
        return undefined;
      }
    });
    expect(parsedDecisions).toEqual(["confirm", "cancel"]);
    expect(Object.fromEntries(txMutationCounts)).toEqual({
      [`PATCH:${seedTxId}`]: 1,
      [`DELETE:${seedTxId}`]: 1,
    });
    expect(allowedDecisions.size).toBe(0);
    expect(expectedUndo).toBeUndefined();
    validateNoHistoricReuse([...decisionRequestPaths, ...undoDecisionPaths, ...verifyPaths, ...decisionBodies, ...undoBodies, ...verifyBodies]);
    test.info().annotations.push({
      type: "live-closure-guard",
      description: `run ${RUN_ID} decisions=${decisionRequestPaths.join(",")} undo=${undoDecisionPaths.length} blocked-early-agent-token=${blockedEarlyAgentTokenAttempts.length}`,
    });
    expect(workspaceWriteViolations, `writes fora do workspace: ${workspaceWriteViolations.join(" | ")}`).toHaveLength(0);
    expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toHaveLength(0);
    expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toHaveLength(0);
    expect(serverErrors, `server errors: ${serverErrors.join(" | ")}`).toHaveLength(0);
  });
});
