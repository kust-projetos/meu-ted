/**
 * F4 Golden Workflows (issue #105) — versioned case schema, v1.
 *
 * A golden case is DATA (a `.golden.json` file), never code. The runner
 * (`../runner.ts`) executes `status: "executable"` cases against an isolated
 * backend and validates them with `../contract.ts`. Cases whose capability is
 * not available (flag OFF, no credential, no binding) are declared
 * `status: "pending-capability"` with an explicit reason: the runner SKIPS
 * them and reports `skipped-pending` — never `pass`.
 *
 * Bumping this schema means a new `v2/` directory; v1 files stay frozen so a
 * recorded run stays reproducible.
 */
export const GOLDEN_VERSION = "1" as const;

export type GoldenStatus = "executable" | "pending-capability";

/**
 * Closed action vocabulary a runner turn may record. Anything outside this
 * enum is a schema error, not a silent "other".
 */
export const GOLDEN_ACTIONS = [
  "clarification_asked",
  "proposal_created",
  "confirmation_executed",
  "cancel_executed",
  "read_answered",
  "fail_closed",
  "forget_proposed",
  "forget_executed",
  "provider_called",
  "error_propagated",
] as const;
export type GoldenAction = (typeof GOLDEN_ACTIONS)[number];

export type GoldenAttachmentRef = Readonly<{
  name: string;
  type?: string;
  size?: number;
}>;

export type GoldenInput = Readonly<{
  /** Human-typed pt-BR text for this turn. */
  text: string;
  /** Distinct intention per turn; repeat an earlier id to model redelivery. */
  intentionId?: string;
  /**
   * Pending-operation ids the (simulated) client declares. The orchestrator
   * resolves confirmations from the AUTHORITATIVE listing, never from this
   * field — it is parsed for logging only. `"from-previous"` reuses the
   * operation id produced by the previous turn, mimicking the PWA card flow.
   */
  pendingOperationIds?: "from-previous" | readonly string[];
  /** Typed text when it differs from the composed turn text (F1 decisionText). */
  decisionText?: string;
  attachments?: readonly GoldenAttachmentRef[];
}>;

export type GoldenInitialState = Readonly<{
  accounts?: readonly Readonly<{ id: string; name: string }>[];
  categories?: readonly Readonly<{ id: string; name: string }>[];
  /** Memories seeded via `rememberFact` before the first turn. */
  memory?: readonly Readonly<{ kind: "fact" | "preference" | "learning" | "summary"; content: string }>[];
  /**
   * Read-path scenario for the evidence provider:
   * - `ok-empty`: reads succeed with empty lists (honest absence, never zero).
   * - `ok-data`: reads succeed with `readData` rows.
   * - `error`: every read item is `error/permanent_error`.
   * - `throw`: the provider throws (transport failure).
   * Absent = reads succeed with empty lists.
   */
  reads?: "ok-empty" | "ok-data" | "error" | "throw";
  readData?: Readonly<{ accounts?: readonly unknown[]; transactions?: readonly unknown[] }>;
  /** Absence reason used on `ok-empty` items (default `period_empty`). */
  absenceReason?: string;
  faults?: Readonly<{
    /** The next N propose calls throw a transient error, then succeed. */
    failProposeTimes?: number;
    /** Every propose call throws a transient error. */
    failProposeAlways?: boolean;
  }>;
}>;

export type GoldenExpectations = Readonly<{
  expectedActions: readonly GoldenAction[];
  forbiddenActions: readonly GoldenAction[];
  backend: Readonly<{
    proposalsCreated?: number;
    executionsSucceeded?: number;
    /** Hard ceiling on ledger entries (duplicate/replay guard). */
    maxLedgerEntries?: number;
    /** A redelivered turn must converge on the first operation id. */
    reuseOperationId?: boolean;
  }>;
  response: Readonly<{
    /** Regex sources matched against the LAST turn response (at least one). */
    mustMatch?: readonly string[];
    /** Regex sources that must match NO turn response. */
    mustNotMatch?: readonly string[];
  }>;
  budget: Readonly<{ maxTurns: number }>;
  /**
   * Optional plan-level assertions. `skillsContain` names skills the routed
   * plan must carry (skill routing is deterministic, no LLM involved).
   */
  plan?: Readonly<{ skillsContain?: readonly string[] }>;
}>;

export type GoldenCase = Readonly<{
  version: typeof GOLDEN_VERSION;
  id: string;
  title: string;
  workflow: string;
  status: GoldenStatus;
  pendingReason?: Readonly<{
    capability: string;
    reason: string;
    requires: readonly string[];
  }>;
  initialState: GoldenInitialState;
  inputs: readonly GoldenInput[];
  expectations: GoldenExpectations;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const fail = (id: string, detail: string): never => {
  throw new Error(`golden.invalid_case[${id}]: ${detail}`);
};

const assertStringArray = (id: string, field: string, value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(id, `${field} must be a string array`);
  }
  return value as readonly string[];
};

/** Runtime validator: a malformed case file fails LOUD, never runs half-parsed. */
export const assertValidGoldenCase = (value: unknown): GoldenCase => {
  if (!isRecord(value)) throw new Error("golden.invalid_case[unknown]: case must be an object");
  const id = typeof value.id === "string" ? value.id : "unknown";
  if (value.version !== GOLDEN_VERSION) fail(id, `version must be "${GOLDEN_VERSION}"`);
  for (const field of ["title", "workflow"] as const) {
    if (typeof value[field] !== "string" || (value[field] as string).trim().length === 0) {
      fail(id, `${field} must be a non-empty string`);
    }
  }
  if (value.status !== "executable" && value.status !== "pending-capability") {
    fail(id, 'status must be "executable" or "pending-capability"');
  }
  if (value.status === "pending-capability") {
    if (!isRecord(value.pendingReason)) fail(id, "pending-capability requires pendingReason");
    const reason = value.pendingReason as Record<string, unknown>;
    for (const field of ["capability", "reason"] as const) {
      if (typeof reason[field] !== "string" || (reason[field] as string).trim().length === 0) {
        fail(id, `pendingReason.${field} must be a non-empty string`);
      }
    }
    assertStringArray(id, "pendingReason.requires", reason.requires);
  }
  if (!isRecord(value.initialState)) fail(id, "initialState must be an object");
  if (!Array.isArray(value.inputs) || value.inputs.length === 0) {
    fail(id, "inputs must be a non-empty array");
  }
  for (const [index, input] of (value.inputs as unknown[]).entries()) {
    if (!isRecord(input) || typeof input.text !== "string" || input.text.trim().length === 0) {
      fail(id, `inputs[${index}].text must be a non-empty string`);
    }
  }
  if (!isRecord(value.expectations)) fail(id, "expectations must be an object");
  const expectations = value.expectations as Record<string, unknown>;
  for (const field of ["expectedActions", "forbiddenActions"] as const) {
    const actions = expectations[field];
    if (!Array.isArray(actions)) fail(id, `expectations.${field} must be an array`);
    for (const action of actions as unknown[]) {
      if (!(GOLDEN_ACTIONS as readonly unknown[]).includes(action)) {
        fail(id, `expectations.${field} holds unknown action "${String(action)}"`);
      }
    }
  }
  if (!isRecord(expectations.backend)) fail(id, "expectations.backend must be an object");
  if (!isRecord(expectations.response)) fail(id, "expectations.response must be an object");
  if (!isRecord(expectations.budget) || typeof expectations.budget.maxTurns !== "number") {
    fail(id, "expectations.budget.maxTurns must be a number");
  }
  const plan = expectations.plan;
  if (plan !== undefined) {
    if (!isRecord(plan)) fail(id, "expectations.plan must be an object");
    const skillsContain = (plan as Record<string, unknown>).skillsContain;
    if (skillsContain !== undefined) assertStringArray(id, "expectations.plan.skillsContain", skillsContain);
  }
  return value as GoldenCase;
};

export type GoldenFile = Readonly<{
  version: typeof GOLDEN_VERSION;
  cases: readonly GoldenCase[];
}>;

/** A `.golden.json` file holds `{ version, cases }`; every case is validated. */
export const assertValidGoldenFile = (value: unknown): GoldenFile => {
  if (!isRecord(value)) throw new Error("golden.invalid_file: file must be an object");
  if (value.version !== GOLDEN_VERSION) {
    throw new Error(`golden.invalid_file: version must be "${GOLDEN_VERSION}"`);
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("golden.invalid_file: cases must be a non-empty array");
  }
  const cases = (value.cases as unknown[]).map(assertValidGoldenCase);
  const ids = new Set<string>();
  for (const goldenCase of cases) {
    if (ids.has(goldenCase.id)) throw new Error(`golden.invalid_file: duplicate case id "${goldenCase.id}"`);
    ids.add(goldenCase.id);
  }
  return { version: GOLDEN_VERSION, cases };
};
