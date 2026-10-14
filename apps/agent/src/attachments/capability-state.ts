/**
 * A19 — pure capability-state DERIVATION model (read-only, no I/O).
 *
 * This is a derivation model, NOT a live/operational inventory: on its own it
 * reports nothing about any real environment. It derives a status ONLY from
 * the EXPLICIT evidence a caller hands it; it reads no env, no runtime state
 * and performs no I/O, and it is not wired into any runtime path (no endpoint,
 * no hot path). Treating its output as an operational inventory would require
 * a caller to compose real evidence — which stays out of scope here.
 *
 * The A19 rollout left five capabilities in DIFFERENT real states (attachment
 * upload active, STT canary, Vision canary, PDF text extraction disabled, plus
 * a legacy provider path blocked out of catalog). Knowing which state a
 * capability is in requires keeping SEVEN evidence dimensions apart, because
 * collapsing them is exactly how a capability looks ACTIVE when it is not:
 *
 * 1. `codeImplemented` — the capability code exists in this build;
 * 2. `configurationPresent` — the deployment configuration names it;
 * 3. `serverFlagEnabled` — the server-side enable flag is on (boolean, or
 *    `'unknown'` when no canonical predicate can decide the flag value —
 *    never a guessed default);
 * 4. `providerAvailable` — the provider boundary reports availability
 *    (a tri-state: `true`/`false`/`'unknown'` — this module never reads a
 *    credential, a binding name or any env value, so a leaked secret can never,
 *    by itself, be evidence of `true`, and an undecidable provider question
 *    stays the honest `'unknown'` instead of a guessed boolean);
 * 5. `cohortAuthorized` — the rollout cohort authorizes the identity
 *    (boolean, or `'unknown'` when undecidable — never a guessed default);
 * 6. `canaryEvidence` — live canary evidence exists (boolean or `'unknown'`);
 * 7. `operationalBlock` — an explicit operational block forbids the path
 *    (boolean, or `'unknown'` when undecidable — never a guessed default).
 *
 * Derivation is CONSERVATIVE and TOTAL: explicit inputs only, no env access,
 * no I/O, no inference between dimensions, and every unavailable or unknown
 * input fails closed toward a non-active state. An operational block outranks
 * everything else — a blocked capability is BLOCKED even when fully configured,
 * and an unconfigured one is still BLOCKED when a block is recorded against it —
 * but only a block PROVEN true does that: a missing, absent or otherwise
 * unusable block value is not proof that the path is unblocked, so it fails
 * closed exactly like an undecidable cohort.
 *
 * Leak-proofing is structural, not procedural: an entry carries only the closed
 * `capability` union, the closed `status` union and the seven dimensions above.
 * There is no free-text field, so a secret value, provider credential, binding
 * name, workspace/actor id or private config cannot travel through an entry.
 * The inventory builder enforces that boundary by PROJECTION — it never echoes
 * the caller's evidence object (see `buildCapabilityInventory`) — and by
 * re-checking every incoming `capability` against the closed A19 union at
 * runtime, so a hostile `capability` value aborts the build instead of riding
 * into the report.
 *
 * This module is deliberately NOT wired into any runtime path and exposes no
 * public endpoint: it exists so an operator-facing report (or a future internal
 * health surface) can derive state from EXPLICIT evidence instead of re-reading
 * scattered env gates and guessing. Composing the evidence from the existing
 * pure gates (`isGroqSttAvailable`, `isGroqVisionAvailable`,
 * `isGeminiVisionAvailable`, `isAttachmentUploadAllowed`,
 * `pdfTextProcessorOverride`) is the caller's job and stays out of scope here.
 */

/** Closed set of A19 capabilities. Extending it is a deliberate decision. */
export type A19Capability = "attachments-upload" | "stt" | "vision" | "pdf-text";

/**
 * The same closed set as a runtime membership table. The compile-time union is
 * erased at runtime, so `buildCapabilityInventory` re-checks every incoming
 * `capability` against THIS table instead of trusting the caller's type.
 */
const A19_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  "attachments-upload",
  "stt",
  "vision",
  "pdf-text",
]);

/**
 * Runtime enforcement of the closed `A19Capability` union, applied BEFORE any
 * entry is built or returned.
 *
 * The check is whitelist membership over a primitive string, so an unknown
 * string, an object, a boxed `String`, a number, a boolean, `null`, `undefined`
 * or a symbol are all rejected — never coerced, never passed through. That
 * matters because `capability` is the one field an entry echoes from the caller
 * instead of projecting: without this gate a hostile object with a `toJSON`
 * would ride into the report and, once serialized, execute the hook's payload.
 *
 * The rejection message is closed and stable. It reports a rejected STRING
 * verbatim (a primitive cannot execute code) and never calls any caller method
 * — so a hostile `toJSON`/`toString` is not invoked, not even while reporting.
 * Returns the validated primitive so the entry carries exactly that value.
 */
const assertA19Capability = (value: unknown): A19Capability => {
  if (typeof value === "string" && A19_CAPABILITIES.has(value)) {
    return value as A19Capability;
  }
  const observed = typeof value === "string" ? `"${value}"` : typeof value;
  throw new Error(`capability-state.unknown_capability: ${observed} is not in the closed A19 union`);
};

/**
 * The five derived states. There is no sixth value and no `unknown` status:
 * undecidable evidence derives a NON-active state, never an unknown one.
 */
export type CapabilityStatus =
  | "UNCONFIGURED"
  | "CONFIGURED_DISABLED"
  | "CANARY"
  | "ACTIVE"
  | "BLOCKED";

/** A dimension that admits an honest "undecidable" answer. */
export type EvidenceTriState = boolean | "unknown";

/**
 * The seven SEPARATE evidence dimensions. Every field is explicit: the
 * derivation never reads one field to synthesize another.
 */
export type CapabilityEvidence = {
  readonly codeImplemented: boolean;
  readonly configurationPresent: boolean;
  /**
   * Tri-state like the provider/cohort/canary/block dimensions: `true`/
   * `false` when a canonical flag predicate answered (the flag variable
   * absent proves the default-off gates are OFF; a provider lock that has
   * the flag as a necessary condition proves it ON), `'unknown'` when the
   * flag VALUE is not canonically observable without duplicating a gate's
   * parser. NEVER a guess, and never the credential/cohort read as the flag.
   */
  readonly serverFlagEnabled: EvidenceTriState;
  /**
   * Tri-state like the cohort/canary/block dimensions: `true`/`false` when the
   * provider boundary answered, `'unknown'` when it did not (e.g. there is no
   * provider-health signal at all). NEVER a credential, a binding name or an
   * env value — only a boundary that was actually probed may say `true`.
   */
  readonly providerAvailable: EvidenceTriState;
  readonly cohortAuthorized: EvidenceTriState;
  readonly canaryEvidence: EvidenceTriState;
  /**
   * An explicit operational block. Admits the honest `'unknown'` (nothing
   * recorded / undecidable): only an exact `true` is a block, an exact `false`
   * proves there is none, and anything else is unanswered — never a default.
   */
  readonly operationalBlock: EvidenceTriState;
};

/** One derivation row: the derived status plus the projected evidence that produced it. */
export type CapabilityInventoryEntry = {
  readonly capability: A19Capability;
  readonly status: CapabilityStatus;
  readonly evidence: CapabilityEvidence;
};

/**
 * Pure derivation. Totality is the contract: for ANY input the result is one of
 * the five statuses, never a throw, never `undefined`.
 *
 * Precedence, most conservative first:
 *
 * 1. operational block PROVEN true ⇒ BLOCKED — a recorded block outranks a
 *    full configuration AND outranks an absent one (the block is the reportable
 *    fact; silence would read as "nothing here"). Only an explicit `true` gets
 *    here: an undecidable block is not a block, it is an unanswered question;
 * 2. no implementation or no configuration ⇒ UNCONFIGURED — a flag without the
 *    capability is not a configured-off capability, it is nothing;
 * 3. flag not proven true (false OR `'unknown'`) ⇒ CONFIGURED_DISABLED —
 *    present, wired, and either deliberately off or undecidably flagged; an
 *    unanswered flag question fails closed exactly like an undecidable cohort;
 * 4. provider unavailable OR undecidable (`false` OR `'unknown'`) ⇒
 *    CONFIGURED_DISABLED — credential/binding absence is a configuration fact
 *    here; the provider tri-state is the ONLY provider signal and it is never
 *    inferred from any other dimension (a secret presence never produces
 *    `true`, and an unanswered provider question never reaches CANARY/ACTIVE);
 * 5. cohort not proven true (false OR `'unknown'`) ⇒ CONFIGURED_DISABLED —
 *    undecidable authorization fails closed to "nobody authorized", matching
 *    the fail-closed cohort gates (empty/absent cohort = NOBODY);
 * 6. operational block not proven false (`'unknown'`, or any value that is not
 *    exactly `true`/`false` — a missing key, an object, a boxed value)
 *    ⇒ CONFIGURED_DISABLED — an unanswered block question is not evidence that
 *    the path is unblocked, so it fails closed instead of reaching
 *    CANARY/ACTIVE;
 * 7. canary evidence not proven true (false OR `'unknown'`) ⇒ CANARY —
 *    everything is on for an authorized cohort with no block recorded, but the
 *    live evidence that would justify general rollout does not exist yet;
 * 8. everything on and proven ⇒ ACTIVE.
 */
export const deriveCapabilityStatus = (evidence: CapabilityEvidence): CapabilityStatus => {
  // `=== true` / `!== true` (not truthiness) so a hostile or loosely typed
  // caller passing "yes"/1 cannot smuggle a dimension into the on state. The
  // same rule makes every TRI-state dimension fail closed: `'unknown'` is not
  // `true`, so an unanswered question never reaches CANARY/ACTIVE.
  if (evidence.operationalBlock === true) return "BLOCKED";
  if (evidence.codeImplemented !== true || evidence.configurationPresent !== true) {
    return "UNCONFIGURED";
  }
  // The flag is tri-state now: an exact `false` proves the default-off gates
  // are off; `'unknown'` (declared but not canonically decidable) fails
  // closed exactly like an undecidable cohort.
  if (evidence.serverFlagEnabled !== true) return "CONFIGURED_DISABLED";
  if (evidence.providerAvailable !== true) return "CONFIGURED_DISABLED";
  if (evidence.cohortAuthorized !== true) return "CONFIGURED_DISABLED";
  // Only an EXACT `false` proves there is no block. `'unknown'` — and anything
  // else that is not exactly `true`/`false` (a missing key, an object, a boxed
  // value, `"true"`) — is an unanswered question, not evidence of an unblocked
  // path, so it fails closed to a non-active state before CANARY/ACTIVE.
  if (evidence.operationalBlock !== false) return "CONFIGURED_DISABLED";
  if (evidence.canaryEvidence !== true) return "CANARY";
  return "ACTIVE";
};

/**
 * Validated whitelist projection of the seven dimensions into a FRESH plain
 * object. This is the leak boundary: the caller's evidence object is never
 * echoed by reference, so extra own properties (including sensitive free
 * text), a `toJSON` hook or a later mutation of the source cannot reach an
 * entry — only these seven keys, and only as validated values.
 *
 * Normalization is CONSERVATIVE (fail closed): a boolean dimension survives
 * only as exactly `true`/`false` (anything else becomes `false`, never on);
 * a tri-state (`serverFlagEnabled`, `providerAvailable`, `cohortAuthorized`,
 * `canaryEvidence`, `operationalBlock`) survives only as exactly
 * `true`/`false` (anything else — missing, malformed, a string like
 * `"yes"`/`"true"` or a hostile object — becomes the honest `"unknown"`,
 * never a guessed boolean). A hostile `"yes"`/`1` therefore can neither
 * smuggle a dimension into the ON state nor travel as itself into the
 * projected snapshot.
 */
const snapshotEvidence = (source: CapabilityEvidence): CapabilityEvidence => ({
  codeImplemented: source.codeImplemented === true,
  configurationPresent: source.configurationPresent === true,
  serverFlagEnabled:
    source.serverFlagEnabled === true
      ? true
      : source.serverFlagEnabled === false
        ? false
        : "unknown",
  providerAvailable:
    source.providerAvailable === true
      ? true
      : source.providerAvailable === false
        ? false
        : "unknown",
  cohortAuthorized:
    source.cohortAuthorized === true
      ? true
      : source.cohortAuthorized === false
        ? false
        : "unknown",
  canaryEvidence:
    source.canaryEvidence === true ? true : source.canaryEvidence === false ? false : "unknown",
  // Same tri-state rule as the cohort/canary dimensions: a missing, malformed
  // or hostile block value is NOT read as a block (never BLOCKED) and is NOT
  // read as proof the path is unblocked (never ACTIVE) — it stays unanswered.
  operationalBlock:
    source.operationalBlock === true
      ? true
      : source.operationalBlock === false
        ? false
        : "unknown",
});

/**
 * Builds the inventory: one entry per capability. Each entry is a DETACHED
 * snapshot — the status is derived from the projected evidence and the entry
 * (and its evidence) are fresh objects, so nothing the caller attached to, or
 * later mutates on, the original evidence can escape into the report.
 *
 * Fail-closed boundary: the closed `A19Capability` union is enforced HERE, at
 * runtime, per row, BEFORE any entry is built. A `capability` outside the
 * closed set — including an object carrying a hostile `toJSON` — aborts the
 * whole build, so nothing partial is ever returned and no hostile value can
 * reach serialization.
 */
export const buildCapabilityInventory = (
  rows: readonly { capability: A19Capability; evidence: CapabilityEvidence }[],
): readonly CapabilityInventoryEntry[] =>
  rows.map((row) => {
    const capability = assertA19Capability(row.capability);
    const evidence = snapshotEvidence(row.evidence);
    return {
      capability,
      status: deriveCapabilityStatus(evidence),
      evidence,
    };
  });
