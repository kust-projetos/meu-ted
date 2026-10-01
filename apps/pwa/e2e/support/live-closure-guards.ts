/**
 * Live closure pure guards — closure-live-0930 (test-only, never bundled).
 *
 * Pure, side-effect-free predicates for the authenticated live closure
 * journey (create → edit → delete → confirm → cancel/undo → recovery) plus
 * the deterministic fixture uncertain-result scenario. No network, no
 * storage, no secrets. The live Playwright specs import these so the same
 * contract is enforced in prod and in unit tests; the vitest suite proves
 * the strict behavior (RED before any production run).
 *
 * Lives in e2e/support (not src/) so it never ships in the production
 * bundle — it is test infrastructure only.
 *
 * Authorization model: the route guard authorizes agent writes BEFORE
 * dispatch (pre-dispatch, closed sets + request bodies), never posthoc. The
 * same pure authorizers below run inside the Playwright route handler AND
 * in the behavioral unit tests (allow-once + deny matrix, no network).
 */

export const CLOSURE_ACTIVE_WS = "550e8400-e29b-41d4-a716-446655440000";

export const FORBIDDEN_HISTORIC_IDS = ["14915dbd", "60b657d5"] as const;

/** Scoped API header contract: every workspace-scoped call carries these. */
export const CLOSURE_API_HEADERS = {
  workspace: "x-workspace-id",
  idempotency: "idempotency-key",
} as const;

export type ClosureMarkers = {
  runId: string;
  accountName: string;
  txDesc: string;
  txDescTed: string;
  txDescTed2: string;
  txDescEdit: string;
};

export function buildClosureMarkers(runId: string): ClosureMarkers {
  const rid = runId.trim();
  if (!rid) throw new Error("runId must be non-empty");
  return {
    runId: rid,
    accountName: `Conta E2E Closure ${rid}`,
    txDesc: `Teste E2E closure ${rid}`,
    txDescTed: `Teste E2E closure TED ${rid}`,
    txDescTed2: `Teste E2E closure TED2 ${rid}`,
    txDescEdit: `Teste E2E closure edit ${rid}`,
  };
}

/**
 * Persistent request-side idempotency key: stable per (runId, seq) with a
 * numeric sequence suffix. Retries are 0 in the live closure config, so a
 * stable key per logical operation avoids duplicates without random churn.
 */
export function buildIdempotencyKey(runId: string, seq: number): string {
  if (!runId.trim()) throw new Error("runId must be non-empty");
  if (!Number.isInteger(seq) || seq < 0) throw new Error("seq must be a non-negative integer");
  return `${runId.trim()}-${seq}`;
}

export function isRunOwnedEntity(description: unknown, runId: string): boolean {
  if (typeof description !== "string" || !runId) return false;
  return description.includes(runId);
}

export function containsForbiddenHistoricId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return FORBIDDEN_HISTORIC_IDS.some((prefix) => value.includes(prefix));
}

export function validateNoHistoricReuse(values: unknown[]): void {
  for (const value of values) {
    if (containsForbiddenHistoricId(value)) {
      throw new Error("historic operation/transaction id reuse is forbidden in the closure run");
    }
  }
}

function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
}

/** Header-scope contract: a workspace-scoped call must name the test workspace. */
export function validateScopedHeaders(headers: Record<string, string | undefined>, activeWs: string): void {
  const ws = getHeader(headers, CLOSURE_API_HEADERS.workspace);
  if (ws !== activeWs) {
    throw new Error(`scoped API call must carry ${CLOSURE_API_HEADERS.workspace}=${activeWs}`);
  }
}

export function validateWorkspaceScope(header: unknown, activeWs: string): void {
  if (header !== activeWs) {
    throw new Error(`workspace scope violation: expected ${activeWs}`);
  }
}

/**
 * Closed-set mutation gate: a PATCH/DELETE against /transactions/:id is only
 * allowed when the id was captured from a creation inside THIS run (never any
 * workspace id, never another run's entity, never a historic id).
 */
export function validateTxMutationAllowed(txId: string, allowedIds: readonly string[]): void {
  if (!txId) throw new Error("refusing transaction mutation with empty id");
  validateNoHistoricReuse([txId]);
  if (!allowedIds.includes(txId)) {
    throw new Error(`refusing transaction mutation on unknown id outside this run's closed set (${allowedIds.length} registered)`);
  }
}

export function decisionPathFor(workspaceId: string, operationId: string): string {
  return `/api/agent/agents/finance-chat-agent/${workspaceId}/rpc/pending-operations/${operationId}/decision`;
}

/** A decision POST path is only valid when it names the exact pending operation of this run. */
export function validateDecisionPathForOperation(path: string, workspaceId: string, operationId: string): void {
  validateNoHistoricReuse([path, operationId]);
  const expected = decisionPathFor(workspaceId, operationId);
  if (path !== expected) {
    throw new Error(`decision POST outside this run's pending operation: got ${path} want ${expected}`);
  }
}

export type ProposalContent = {
  description: string;
  accountLabel: string;
  categoryLabel: string;
  amountCents: number;
};

/**
 * Card cross-check (SECONDARY, never leading): the rendered card content must
 * agree with the intended operation. Authorization itself comes from the
 * authoritative active-list fetch (validateAuthoritativePendingOp) — the card
 * can only confirm, never authorize.
 */
export function validateProposalContent(actual: ProposalContent, expected: ProposalContent): void {
  if (
    actual.description !== expected.description ||
    actual.accountLabel !== expected.accountLabel ||
    actual.categoryLabel !== expected.categoryLabel ||
    actual.amountCents !== expected.amountCents
  ) {
    throw new Error(
      `proposal content mismatch: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`,
    );
  }
}

export type PendingOpPresentationRef = {
  id?: unknown;
  status?: unknown;
  tool?: unknown;
  amountCents?: unknown;
  description?: unknown;
  date?: unknown;
  account?: { id?: unknown; label?: unknown };
  category?: { id?: unknown; label?: unknown };
};

export type AuthoritativePendingOp = {
  id?: unknown;
  status?: unknown;
  tool?: unknown;
  amountCents?: unknown;
  description?: unknown;
  date?: unknown;
  accountId?: unknown;
  categoryId?: unknown;
  presentation?: PendingOpPresentationRef;
};

export type ExpectedPendingBinding = {
  operationId: string;
  status: string;
  tool: string;
  amountCents: number;
  description: string;
  accountId: string;
  categoryId: string;
};

/**
 * AUTHORITATIVE pending-op binding (PRIMARY source): the
 * GET pending-operations/active record must carry the exact args before the
 * pending id enters the decision closed set. Ids bind from the top-level
 * normalizedArgs-derived fields OR the server-built presentation
 * (presentation.account.id / presentation.category.id) — at least one source
 * must bind, and both sources must agree when present. The card UI only
 * cross-checks afterwards and never authorizes.
 */
export function validateAuthoritativePendingOp(actual: AuthoritativePendingOp, expected: ExpectedPendingBinding): void {
  validateNoHistoricReuse([actual.id, actual.accountId, actual.categoryId]);
  if (actual.id !== expected.operationId) {
    throw new Error(`authoritative pending op id mismatch: got ${String(actual.id)} want ${expected.operationId}`);
  }
  if (actual.status !== expected.status) {
    throw new Error(`authoritative pending op status must be ${expected.status}, got ${String(actual.status)}`);
  }
  if (actual.tool !== expected.tool) {
    throw new Error(`authoritative pending op tool must be ${expected.tool}, got ${String(actual.tool)}`);
  }
  const pres = actual.presentation;
  if (pres !== undefined) {
    if (pres.id !== undefined && pres.id !== expected.operationId) {
      throw new Error("authoritative pending op presentation id must match the operation");
    }
    validateNoHistoricReuse([pres.account?.id, pres.category?.id]);
  }
  bindOpAmount(actual.amountCents, pres?.amountCents, expected.amountCents);
  bindOpField("description", actual.description, pres?.description, expected.description);
  bindOpField("account", actual.accountId, pres?.account?.id, expected.accountId);
  bindOpField("category", actual.categoryId, pres?.category?.id, expected.categoryId);
}

function bindOpField(label: string, top: unknown, fromPresentation: unknown, expected: string): void {
  const t = typeof top === "string" ? top : undefined;
  const p = typeof fromPresentation === "string" ? fromPresentation : undefined;
  if (t !== undefined && p !== undefined && t !== p) {
    throw new Error(`authoritative pending op ${label} disagrees between top-level and presentation`);
  }
  if ((t ?? p) !== expected) {
    throw new Error(`authoritative pending op ${label} binding failed`);
  }
}

function bindOpAmount(top: unknown, fromPresentation: unknown, expected: number): void {
  const t = typeof top === "number" ? top : undefined;
  const p = typeof fromPresentation === "number" ? fromPresentation : undefined;
  if (t !== undefined && p !== undefined && t !== p) {
    throw new Error("authoritative pending op amount disagrees between top-level and presentation");
  }
  if ((t ?? p) !== expected) {
    throw new Error(`authoritative pending op amount must be ${expected}`);
  }
}

export type DecisionReceipt = {
  operationId?: unknown;
  status?: unknown;
  receipt?: {
    status?: unknown;
    operationId?: unknown;
    mutationId?: unknown;
    entity?: { type?: unknown; id?: unknown };
  };
};

/** Strict receipt binding: succeeded requires operationId + receipt.entity {type:'transaction', id}. */
export function validateReceiptBinding(body: DecisionReceipt, operationId: string): string {
  if (body.operationId !== operationId) {
    throw new Error("decision receipt must name the approved operation");
  }
  if (body.status !== "succeeded") {
    throw new Error("decision receipt status must be succeeded");
  }
  const receipt = body.receipt;
  const entityId = typeof receipt?.entity?.id === "string" ? receipt.entity.id.trim() : "";
  const mutationId = typeof receipt?.mutationId === "string" ? receipt.mutationId : "";
  if (
    !receipt ||
    receipt.status !== "succeeded" ||
    receipt.operationId !== operationId ||
    !mutationId ||
    receipt.entity?.type !== "transaction" ||
    !entityId
  ) {
    throw new Error("successful approval must return a canonical execution receipt");
  }
  validateNoHistoricReuse([entityId, mutationId]);
  return entityId;
}

/** Exactly-once: the journey must dispatch one financial decision POST per approved operation. */
export function assertSingleDecisionPost(paths: string[], expectedPath: string): void {
  if (paths.length !== 1 || paths[0] !== expectedPath) {
    throw new Error(
      `expected exactly one financial decision POST ${expectedPath}, got ${paths.length}`,
    );
  }
}

export function assertDecisionPostSet(paths: string[], expectedPaths: string[]): void {
  const sorted = [...paths].sort();
  const want = [...expectedPaths].sort();
  if (sorted.length !== want.length || sorted.some((p, i) => p !== want[i])) {
    throw new Error(`decision POST set mismatch: got [${sorted.join(", ")}] want [${want.join(", ")}]`);
  }
}

// ── Pre-dispatch agent-write authorizers (route guard + unit tests share these) ──

export type ExpectedAgentDecision = {
  workspaceId: string;
  operationId: string;
  decision: "confirm" | "cancel" | "retry";
};

export type ExpectedUndo = {
  workspaceId: string;
  requestId: string;
  decision: "confirm" | "cancel";
};

export type AgentWriteAuth = { allowed: boolean; reason: string };

function parseAgentDecisionBody(bodyText: string): { decision: unknown; requestId: unknown } {
  if (!bodyText) throw new Error("agent decision POST must carry a JSON body");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error("agent decision POST body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("agent decision POST body must be an object");
  }
  const rec = parsed as Record<string, unknown>;
  return { decision: rec.decision, requestId: rec.requestId };
}

/**
 * Pre-dispatch gate for pending-operation decisions: path workspace + op id
 * must equal the registered expectation AND the request body must name the
 * authorized decision with a fresh requestId. Anything else is denied BEFORE
 * route.continue — posthoc journal observation never authorizes.
 */
export function authorizePendingDecisionWrite(
  actual: { pathWorkspace: string; operationId: string; bodyText: string },
  expected: ExpectedAgentDecision | undefined,
): AgentWriteAuth {
  try {
    if (!expected) return { allowed: false, reason: "no authorized pending operation registered (closed set)" };
    validateNoHistoricReuse([actual.pathWorkspace, actual.operationId, actual.bodyText]);
    if (actual.pathWorkspace !== expected.workspaceId) {
      return { allowed: false, reason: "decision path workspace outside the test workspace" };
    }
    if (actual.operationId !== expected.operationId) {
      return { allowed: false, reason: "decision for unknown pending operation id" };
    }
    const body = parseAgentDecisionBody(actual.bodyText);
    if (body.decision !== expected.decision) {
      return { allowed: false, reason: `decision must be ${expected.decision}` };
    }
    if (typeof body.requestId !== "string" || !body.requestId) {
      return { allowed: false, reason: "decision must carry a requestId" };
    }
    validateNoHistoricReuse([body.requestId]);
    return { allowed: true, reason: "bound to the authorized pending operation" };
  } catch (e) {
    return { allowed: false, reason: (e as Error).message };
  }
}

/**
 * Pre-dispatch gate for undo decisions: the body requestId must EXACTLY equal
 * the captured live proposal id, with the authorized decision and no historic
 * material nested anywhere in the body.
 */
export function authorizeUndoWrite(
  actual: { pathWorkspace: string; bodyText: string },
  expected: ExpectedUndo | undefined,
): AgentWriteAuth {
  try {
    if (!expected) return { allowed: false, reason: "no authorized undo proposal registered (closed set)" };
    validateNoHistoricReuse([actual.pathWorkspace, actual.bodyText]);
    if (actual.pathWorkspace !== expected.workspaceId) {
      return { allowed: false, reason: "undo path workspace outside the test workspace" };
    }
    const body = parseAgentDecisionBody(actual.bodyText);
    if (body.decision !== expected.decision) {
      return { allowed: false, reason: `undo decision must be ${expected.decision}` };
    }
    if (body.requestId !== expected.requestId) {
      return { allowed: false, reason: "undo requestId must EXACTLY match the captured live proposal" };
    }
    return { allowed: true, reason: "bound to the captured live undo proposal" };
  } catch (e) {
    return { allowed: false, reason: (e as Error).message };
  }
}

export type ExpectedVerify = {
  workspaceId: string;
  requestId: string;
  entityType: string;
  entityId: string;
};

/**
 * Pre-dispatch gate for the architect-accepted readonly verify-target POST
 * (rpc/undo/{requestId}/verify-target): exact verify URL (requestId in path)
 * + STRICT body { expectedEntity: { type, id } } equal to the captured bound
 * pair. Classified read-only (no financial effect, no idempotency key) but
 * allowlisted as an explicit single grant only — never any verify generically.
 */
export function authorizeVerifyWrite(
  actual: { pathWorkspace: string; pathRequestId: string; bodyText: string },
  expected: ExpectedVerify | undefined,
): AgentWriteAuth {
  try {
    if (!expected) return { allowed: false, reason: "no authorized verify grant registered (closed set)" };
    validateNoHistoricReuse([actual.pathWorkspace, actual.pathRequestId, actual.bodyText]);
    if (actual.pathWorkspace !== expected.workspaceId) {
      return { allowed: false, reason: "verify path workspace outside the test workspace" };
    }
    if (actual.pathRequestId !== expected.requestId) {
      return { allowed: false, reason: "verify for unknown undo request id" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(actual.bodyText) as unknown;
    } catch {
      return { allowed: false, reason: "verify body must be JSON" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { allowed: false, reason: "verify body must be an object" };
    }
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length !== 1 || keys[0] !== "expectedEntity") {
      return { allowed: false, reason: "verify body must be STRICTLY { expectedEntity }" };
    }
    const entity = (parsed as Record<string, unknown>).expectedEntity;
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
      return { allowed: false, reason: "verify expectedEntity must be an object" };
    }
    const ekeys = Object.keys(entity as Record<string, unknown>);
    if (ekeys.length !== 2 || !ekeys.includes("type") || !ekeys.includes("id")) {
      return { allowed: false, reason: "verify expectedEntity must be STRICTLY { type, id }" };
    }
    const rec = entity as Record<string, unknown>;
    if (rec.type !== expected.entityType || rec.id !== expected.entityId) {
      return { allowed: false, reason: "verify expectedEntity must equal the captured bound pair" };
    }
    return { allowed: true, reason: "bound to the captured verify grant" };
  } catch (e) {
    return { allowed: false, reason: (e as Error).message };
  }
}

export type UndoProposalSummary = {
  requestId?: unknown;
  status?: unknown;
  expiresAt?: unknown;
};

/**
 * Fresh-proposal proof: exactly one proposal in `after` that was absent from
 * `before` (the mutation just executed minted it), actionable, non-historic.
 * Proves the undo target is the NEW mutation in this actor/workspace session.
 */
export function findFreshUndoProposal(
  before: readonly UndoProposalSummary[],
  after: readonly UndoProposalSummary[],
): { requestId: string; status: string } {
  const known = new Set(before.map((p) => String(p.requestId ?? "")));
  const fresh = after.filter((p) => !known.has(String(p.requestId ?? "")));
  if (fresh.length !== 1) {
    throw new Error(`BLOCKED: expected exactly one fresh undo proposal, got ${fresh.length}`);
  }
  const proposal = fresh[0]!;
  const requestId = typeof proposal.requestId === "string" ? proposal.requestId : "";
  if (!requestId) throw new Error("BLOCKED: fresh undo proposal has no requestId");
  validateNoHistoricReuse([requestId]);
  if (proposal.status !== "proposed" && proposal.status !== "executing") {
    throw new Error(`BLOCKED: fresh undo proposal not actionable (status=${String(proposal.status)})`);
  }
  return { requestId, status: String(proposal.status) };
}

/**
 * Undo is REQUIRED: an absent undo card blocks the scenario (fail-blocked),
 * it never degrades to a passing annotation. The undo itself is requested
 * through the product UI (chat message → structured undoProposal → card);
 * no direct API write ever substitutes the UI-covered flow.
 */
export function assertUndoOffered(visible: boolean, context: string): void {
  if (!visible) {
    throw new Error(`BLOCKED: undo card not offered by the agent (${context}) — scenario cannot pass without the UI undo`);
  }
}

/**
 * Undo request audit: the ONLY deciding call names the live undo proposal
 * (requestId) with the explicit decision. The requestId must be a fresh
 * proposal id — never a historic operation/transaction id.
 */
export function validateUndoRequestBody(body: unknown, expectedDecision: "confirm" | "cancel"): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("undo decision must carry a JSON body");
  }
  const rec = body as Record<string, unknown>;
  if (rec.decision !== expectedDecision) {
    throw new Error(`undo decision must be ${expectedDecision}`);
  }
  const requestId = typeof rec.requestId === "string" ? rec.requestId : "";
  if (!requestId) {
    throw new Error("undo decision must name the live proposal requestId");
  }
  validateNoHistoricReuse([requestId, JSON.stringify(body)]);
  return requestId;
}

/** Counts exact description occurrences across a FULL paginated ledger (offpage duplicates included). */
export function countByDescription(items: ReadonlyArray<{ description?: unknown }>, desc: string): number {
  return items.filter((t) => t.description === desc).length;
}

/** Exact ledger counts: every tracked description must match its expected count, no more, no less. */
export function validateLedgerCounts(actual: Record<string, number>, expected: Record<string, number>): void {
  const aKeys = Object.keys(actual).sort();
  const eKeys = Object.keys(expected).sort();
  if (aKeys.length !== eKeys.length || aKeys.some((k, i) => k !== eKeys[i])) {
    throw new Error(`ledger count keys mismatch: got [${aKeys.join(", ")}] want [${eKeys.join(", ")}]`);
  }
  for (const key of eKeys) {
    if (actual[key] !== expected[key]) {
      throw new Error(`ledger count for ${key}: got ${actual[key]} want ${expected[key]}`);
    }
  }
}

/** Uncertain-result lock: approval.execution_uncertain hides every decision button until refresh. */
export function isUncertainLock(code: unknown): boolean {
  return code === "approval.execution_uncertain" || code === "agent.execution_outcome_unknown";
}

export function validateUncertainLock(code: unknown, buttonsVisible: { confirm: boolean; cancel: boolean; retry: boolean }): void {
  if (!isUncertainLock(code)) throw new Error("not an uncertain result");
  if (buttonsVisible.confirm || buttonsVisible.cancel || buttonsVisible.retry) {
    throw new Error("uncertain result must lock the card: no Confirm/Cancel/Retry");
  }
}

// ── Shared paginated ledger reader (spec + unit tests share this) ──

export type LedgerPage<T> = {
  status: number;
  items: T[];
  total: unknown;
  offset: unknown;
  limit: unknown;
};

/**
 * Reads a FULL limit/offset list through a pager callback, validating every
 * page: 2xx, items array, integer non-negative total, offset/limit echo,
 * stable total, no empty page before total. Throws (FAIL) on any violation —
 * offpage duplicates beyond the first page cannot hide because every page is
 * fetched and concatenated in order.
 */
export async function readAllPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<LedgerPage<T>>,
  limit = 100,
): Promise<{ status: number; items: T[] }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("readAllPages: limit must be an integer in 1..100");
  }
  const items: T[] = [];
  let offset = 0;
  let total: number | null = null;
  let firstStatus = 0;
  for (;;) {
    const page = await fetchPage(offset, limit);
    if (offset === 0) firstStatus = page.status;
    if (page.status < 200 || page.status >= 300) {
      throw new Error(`ledger page @${offset} failed with status ${page.status}`);
    }
    if (!Array.isArray(page.items)) {
      throw new Error(`ledger page @${offset} has no items array`);
    }
    if (!Number.isInteger(page.total) || (page.total as number) < 0) {
      throw new Error(`ledger page @${offset} has non-integer total`);
    }
    if (page.offset !== offset) {
      throw new Error(`ledger page offset mismatch: got ${String(page.offset)} want ${offset}`);
    }
    if (page.limit !== limit) {
      throw new Error(`ledger page limit mismatch: got ${String(page.limit)} want ${limit}`);
    }
    const pageTotal = page.total as number;
    if (total !== null && pageTotal !== total) {
      throw new Error(`ledger total changed mid-read (${total} -> ${pageTotal})`);
    }
    total = pageTotal;
    if (page.items.length === 0 && offset < total) {
      throw new Error(`ledger empty page before total at offset ${offset}`);
    }
    items.push(...page.items);
    offset += page.items.length;
    if (offset >= (total ?? 0)) break;
    if (offset > 10000) throw new Error("ledger read exceeded sanity bound");
  }
  return { status: firstStatus, items };
}

export type TransactionLike = {
  id?: unknown;
  description?: unknown;
  amountCents?: unknown;
  amount_cents?: unknown;
  accountId?: unknown;
  account_id?: unknown;
  subcategoryId?: unknown;
  subcategory_id?: unknown;
  categoryId?: unknown;
  category_id?: unknown;
};

export type TrackedTx = {
  id: string;
  description: string;
  amountCents: number | null;
  accountId: string | null;
  categoryId: string | null;
};

/** Filters full-ledger items to the created account + tracked descriptions. */
export function filterTrackedTransactions(
  items: ReadonlyArray<TransactionLike>,
  accountId: string,
  descs: ReadonlyArray<string>,
): TrackedTx[] {
  const out: TrackedTx[] = [];
  for (const t of items) {
    const aid = (t.accountId ?? t.account_id) as string | undefined;
    if (aid !== accountId) continue;
    if (typeof t.description !== "string" || !descs.includes(t.description)) continue;
    const cents =
      typeof t.amountCents === "number"
        ? t.amountCents
        : typeof t.amount_cents === "number"
          ? t.amount_cents
          : null;
    const cat = (t.subcategoryId ?? t.subcategory_id ?? t.categoryId ?? t.category_id) as string | undefined;
    out.push({
      id: String(t.id),
      description: t.description,
      amountCents: cents,
      accountId: aid ?? null,
      categoryId: cat ?? null,
    });
  }
  return out;
}

// ── Audit-target association (undo fixed-target proof via existing reads) ──

export type AuditEntry = {
  id?: unknown;
  operation?: unknown;
  actorId?: unknown;
  actorType?: unknown;
  effectRef?: unknown;
  metadata?: unknown;
  createdAt?: unknown;
};

/** Entity bound to an audit entry: effectRef first, metadata.entityId fallback. */
export function auditEntryEntityId(entry: AuditEntry): string | null {
  if (typeof entry.effectRef === "string" && entry.effectRef) return entry.effectRef;
  const md = entry.metadata;
  if (md && typeof md === "object" && !Array.isArray(md)) {
    const v = (md as Record<string, unknown>).entityId;
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * Audit association proof for the undo fixed target: exactly one audit entry
 * for (operation, confirmed entity), created after the confirm dispatch.
 * The Agent's previewUndoTarget fixes the proposal target to the most recent
 * reversible operation — this plus the head check (caller's job) plus the
 * fresh-proposal temporal binding is the full browser-provable association.
 * The raw targetLastOperationId never leaves the DO by design; if this proof
 * cannot be built from existing reads, the caller FAILs blocked with the
 * exact needed shape below — no workaround substitutes it.
 */
export function validateAuditTargetAssociation(
  items: readonly AuditEntry[],
  expected: { entityId: string; operation: string; notBefore: string },
): string {
  validateNoHistoricReuse([expected.entityId]);
  const matches = items.filter(
    (e) => auditEntryEntityId(e) === expected.entityId && e.operation === expected.operation,
  );
  if (matches.length !== 1) {
    throw new Error(
      `BLOCKED: audit association needs exactly one ${expected.operation} entry for the confirmed entity (got ${matches.length}) — needed shape: GET /audit-logs?entityId=<receiptEntityId>&operation=<tool>&limit=10 returning the single mutation record; no workaround substitutes this proof`,
    );
  }
  const entry = matches[0]!;
  if (typeof entry.createdAt === "string" && entry.createdAt < expected.notBefore) {
    throw new Error("BLOCKED: audit entry predates the confirm dispatch — not our mutation");
  }
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!id) throw new Error("BLOCKED: audit entry has no id");
  validateNoHistoricReuse([id]);
  return id;
}
