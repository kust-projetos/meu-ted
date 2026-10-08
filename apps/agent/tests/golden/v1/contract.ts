/**
 * F4 Golden Workflows (issue #105) — acceptance contract, v1.
 *
 * The heart is INV-03 (SPEC §11/§12): **false-success = HARD FAILURE**. A turn
 * response that claims a financial outcome was recorded/paid/done while the
 * authoritative isolated backend holds NO matching execution fails the case —
 * no matter what else passed. A claim WITH a matching execution is legitimate
 * (the manual-confirm path produces exactly one such reply).
 *
 * Everything here runs against the ISOLATED backend (`./backend.ts`): no
 * production, no network, no real money, no LLM.
 */
import type { GoldenAction, GoldenCase } from "./schema.js";

/**
 * pt-BR past/participle success claims (INV-03: "registrado/feito/pago/
 * cancelado/..."). Infinitives ("registrar", "a pagar") are NOT claims: a
 * proposal asking "Confirma?" and a refusal saying "não consegui registrar"
 * must never trip this detector.
 *
 * `CANCEL_CLAIM_SOURCE` is singled out because a "cancelada" reply is
 * legitimized by an authoritative CANCELLATION, never by an execution —
 * the contract validates the two correspondence paths separately.
 */
export const CANCEL_CLAIM_SOURCE = String.raw`\bcancelad[oa]s?\b`;

const SUCCESS_CLAIM_SOURCES = [
  String.raw`\bregistrad[oa]s?\b`,
  String.raw`\blan[cç]ad[oa]s?\b`,
  String.raw`\bpag[oa]s?\b`,
  String.raw`\bfeit[oa]s?\b`,
  String.raw`\bconclu[ií]d[oa]s?\b`,
  String.raw`\bconfirmad[oa]s?\b`,
  CANCEL_CLAIM_SOURCE,
  String.raw`\banotad[oa]s?\b`,
  String.raw`\bexclu[ií]d[oa]s?\b`,
  String.raw`\bdesfeit[oa]s?\b`,
  String.raw`\bestornad[oa]s?\b`,
  String.raw`\bcom sucesso\b`,
] as const;

export const SUCCESS_CLAIM_RES = SUCCESS_CLAIM_SOURCES.map((source) => new RegExp(source, "iu"));

/** Negations that turn a past participle into a NON-claim ("não foi registrado"). */
const NEGATION_BEFORE = /\b(n[aã]o|nem|nunca|jamais|sem)\b/iu;

/**
 * Adversative/contrastive conjunctions reset the negation context: a negation
 * in the clause before "mas/porém/..." never suppresses a success claim
 * after it ("Não consegui consultar o saldo mas o lançamento foi registrado."
 * IS a claim).
 */
const ADVERSATIVE_BOUNDARY = /\b(mas|por[eé]m|contudo|entretanto|todavia|embora|apesar\s+de|no\s+entanto)\b/iu;

/**
 * Reassurance idioms where the negation governs ANOTHER verb, never the
 * success predicate ("Sem problemas o lançamento foi registrado.",
 * "Não se preocupe, registrado." — both ARE claims). Stripped from the
 * negation window before testing.
 */
const NEGATION_EXEMPT_IDIOMS = [/\bsem\s+problemas?\b/iu, /\bn[aã]o\s+se\s+preocup\w*/iu] as const;

/**
 * Returns the claim patterns matched by a response text (empty = no claim).
 * A match under a negation ("o resultado não pôde ser confirmado",
 * "não foi registrado") is not a claim — only an affirmative past-tense
 * assertion counts. The negation anchors to the SAME sub-clause as the match:
 * delimited by sentence/clause punctuation AND reset by adversative/
 * contrastive conjunctions (`mas`, `porém`, `contudo`, `entretanto`,
 * `no entanto`, `embora`, `apesar de`, `todavia`) — and only a negation that
 * PRECEDES the match suppresses it (a negation after the match never anchors
 * backwards). Reassurance idioms whose negation governs another verb
 * ("sem problemas", "não se preocupe") never suppress: "Não consegui
 * consultar o saldo mas o lançamento foi registrado.", "Sem problemas o
 * lançamento foi registrado.", "Não registrado. Agora registrado." and
 * "Não se preocupe, registrado." all carry an affirmative claim, while
 * "Não foi registrado", "Não foi possível registrar" and "o lançamento não
 * foi registrado" stay silent.
 */
export const detectSuccessClaim = (text: string): readonly string[] =>
  SUCCESS_CLAIM_SOURCES.filter((source, index) => {
    const re = SUCCESS_CLAIM_RES[index];
    if (!re) return false;
    const global = new RegExp(re.source, "giu");
    let match: RegExpExecArray | null;
    let affirmative = false;
    while ((match = global.exec(text)) !== null) {
      const at = match.index ?? 0;
      let clauseStart = 0;
      for (let i = at - 1; i >= 0; i -= 1) {
        if (/[.!?;,\n:—–()]/u.test(text[i] ?? "")) {
          clauseStart = i + 1;
          break;
        }
      }
      // Adversative boundary resets the negation context: only the segment
      // after the LAST adversative conjunction in the clause can suppress.
      let subClauseStart = clauseStart;
      const before = text.slice(clauseStart, at);
      const adv = new RegExp(ADVERSATIVE_BOUNDARY.source, "giu");
      let advMatch: RegExpExecArray | null;
      while ((advMatch = adv.exec(before)) !== null) {
        subClauseStart = clauseStart + advMatch.index + advMatch[0].length;
        if (advMatch[0].length === 0) adv.lastIndex += 1;
      }
      let clauseBefore = text.slice(subClauseStart, at);
      // Reassurance idioms govern another verb — they never suppress.
      for (const exempt of NEGATION_EXEMPT_IDIOMS) {
        clauseBefore = clauseBefore.replace(new RegExp(exempt.source, "giu"), " ");
      }
      if (!NEGATION_BEFORE.test(clauseBefore)) {
        affirmative = true;
        break;
      }
      if (match[0].length === 0) global.lastIndex += 1;
    }
    return affirmative;
  });

export type ExecutedTurn = Readonly<{
  index: number;
  intentionId: string;
  mode: string;
  actions: readonly GoldenAction[];
  responseText: string;
  operationId: string | null;
  latencyMs: number;
  planSkills: readonly string[];
  /**
   * Per-turn authoritative effect snapshot (populated by `runner.ts` right
   * after the turn runs). When present, the false-success check validates
   * temporal + per-operation correspondence against THIS snapshot instead of
   * the post-all-turns aggregate: a claim is legitimate only when the
   * corresponding operation already executed at or before this turn's
   * response. Absent = legacy fallback to the final `backend` aggregate
   * (keeps direct unit calls without per-turn data working).
   */
  executionsSucceededAfterTurn?: number;
  executedOperationIdsAfterTurn?: readonly string[];
  /**
   * Per-turn authoritative cancellation snapshot (populated by `runner.ts`
   * right after the turn runs). A "cancelada" reply is legitimate only
   * against THIS snapshot — never against an execution count. Absent =
   * legacy fallback to the final `backend` aggregate (keeps direct unit
   * calls without per-turn data working).
   */
  cancellationsAfterTurn?: number;
  cancelledOperationIdsAfterTurn?: readonly string[];
}>;

export type BackendSnapshot = Readonly<{
  proposalsCreated: number;
  executionsSucceeded: number;
  ledgerEntries: number;
  operationIds: readonly string[];
  /**
   * Authoritative cancellations (optional: absent in legacy unit-call
   * literals). The runner always populates both fields, so executable
   * cancel cases never rely on the execution count.
   */
  cancellationsSucceeded?: number;
  cancelledOperationIds?: readonly string[];
}>;

export type ContractFinding = Readonly<{
  rule: string;
  severity: "failure" | "error";
  detail: string;
}>;

export type ContractVerdict = Readonly<{
  passed: boolean;
  falseSuccess: boolean;
  findings: readonly ContractFinding[];
}>;

/**
 * Validates one executed case. `false-success` is ALWAYS a failure entry and
 * forces `passed: false`, even when every other expectation held — that is
 * the HARD FAILURE the SPEC demands.
 */
export const evaluateContract = (
  goldenCase: GoldenCase,
  turns: readonly ExecutedTurn[],
  backend: BackendSnapshot,
): ContractVerdict => {
  const findings: ContractFinding[] = [];
  const seen = new Set<GoldenAction>();
  for (const turn of turns) for (const action of turn.actions) seen.add(action);

  for (const expected of goldenCase.expectations.expectedActions) {
    if (!seen.has(expected)) {
      findings.push({ rule: "expected-action", severity: "failure", detail: `expected action "${expected}" never recorded` });
    }
  }
  for (const forbidden of goldenCase.expectations.forbiddenActions) {
    if (seen.has(forbidden)) {
      findings.push({ rule: "forbidden-action", severity: "failure", detail: `forbidden action "${forbidden}" was recorded` });
    }
  }

  const expectedBackend = goldenCase.expectations.backend;
  if (expectedBackend.proposalsCreated !== undefined && backend.proposalsCreated !== expectedBackend.proposalsCreated) {
    findings.push({
      rule: "backend-postcondition",
      severity: "failure",
      detail: `proposalsCreated=${backend.proposalsCreated}, expected ${expectedBackend.proposalsCreated}`,
    });
  }
  if (expectedBackend.executionsSucceeded !== undefined && backend.executionsSucceeded !== expectedBackend.executionsSucceeded) {
    findings.push({
      rule: "backend-postcondition",
      severity: "failure",
      detail: `executionsSucceeded=${backend.executionsSucceeded}, expected ${expectedBackend.executionsSucceeded}`,
    });
  }
  if (expectedBackend.maxLedgerEntries !== undefined && backend.ledgerEntries > expectedBackend.maxLedgerEntries) {
    findings.push({
      rule: "backend-postcondition",
      severity: "failure",
      detail: `ledgerEntries=${backend.ledgerEntries} exceeds max ${expectedBackend.maxLedgerEntries} (duplicate/replay leak)`,
    });
  }
  if (expectedBackend.reuseOperationId === true) {
    const ids = turns.map((turn) => turn.operationId).filter((id): id is string => id !== null);
    if (new Set(ids).size > 1) {
      findings.push({ rule: "backend-postcondition", severity: "failure", detail: `redelivery diverged: operationIds=${JSON.stringify(ids)}` });
    }
  }

  const responseExpect = goldenCase.expectations.response;
  const lastText = turns.length > 0 ? (turns[turns.length - 1]?.responseText ?? "") : "";  for (const source of responseExpect.mustMatch ?? []) {
    if (!new RegExp(source, "iu").test(lastText)) {
      findings.push({ rule: "acceptable-response", severity: "failure", detail: `last response matches none of /${source}/` });
    }
  }
  for (const source of responseExpect.mustNotMatch ?? []) {
    const re = new RegExp(source, "iu");
    const hit = turns.find((turn) => re.test(turn.responseText));
    if (hit) {
      findings.push({ rule: "acceptable-response", severity: "failure", detail: `/${source}/ matched turn ${hit.index} response` });
    }
  }

  for (const skill of goldenCase.expectations.plan?.skillsContain ?? []) {
    const carried = turns.some((turn) => turn.planSkills.includes(skill));
    if (!carried) {
      findings.push({ rule: "plan-skills", severity: "failure", detail: `no turn carried skill "${skill}"` });
    }
  }

  // INV-03 — false-success = HARD FAILURE. Success claims and cancel claims
  // are validated INDEPENDENTLY (P1-5.4): a response may carry both ("mixed
  // claims") and each half needs its own authoritative evidence as of the
  // claiming turn — an execution NEVER legitimizes a cancel half and a
  // cancellation NEVER legitimizes an execution half.
  //
  // A success claim is legitimate ONLY when the authoritative backend holds
  // a matching execution AT OR BEFORE the claiming turn's response — never
  // a later turn's — and, when the turn carries an operationId, that SAME
  // operation (not any other operation Y). A proposal is NOT an execution:
  // "Proposta ... Confirma?" carries no claim by construction, and any
  // past-tense claim over a merely-proposed op fails. Turns carrying a
  // per-turn snapshot (`executionsSucceededAfterTurn` /
  // `executedOperationIdsAfterTurn`, recorded by the runner) use it; turns
  // without one fall back to the final `backend` aggregate (legacy unit-call
  // path). A null-operationId claim is a summary reference: legitimate only
  // when at least one execution already exists as of the turn.
  //
  // A "cancelada" claim follows the SEPARATE cancellation path: it is
  // legitimate ONLY when the authoritative backend holds a matching
  // CANCELLATION as of the claiming turn (`cancellationsAfterTurn` /
  // `cancelledOperationIdsAfterTurn`, same per-turn-first rule). An execution
  // NEVER legitimizes a cancel claim and a cancellation NEVER legitimizes an
  // execution claim — the two effects are validated independently, so a
  // cancel reply over zero cancellations stays a HARD FAILURE even when the
  // ledger holds executions, and vice versa.
  //
  // Cancel↔operation binding (P1-5.4/AC3): the per-turn snapshots are
  // cumulative, so a claiming turn must have ADDED a cancellation — the
  // count after this turn must exceed the previous turn's count (0 for the
  // first turn). A stale re-assertion of an earlier cancellation under a NEW
  // intentionId is a HARD FAILURE, even when prior executions exist (AC4).
  // The single exception is an idempotent redelivery: the SAME intentionId
  // repeated in a later turn re-answers the same outcome without a new
  // backend effect — but ONLY when the prior turn with that SAME intentionId
  // itself recorded the cancellation (per-turn delta evidence as of that
  // turn). A cancellation effected under a DIFFERENT intentionId never
  // excuses a replayed claim (redelivery-mismatch). When no cancellation evidence exists anywhere (legacy
  // unit calls with neither per-turn nor aggregate data), a cancel claim
  // fails closed — executions never stand in for it.
  let falseSuccess = false;
  for (const [turnPosition, turn] of turns.entries()) {
    const claims = detectSuccessClaim(turn.responseText);
    if (claims.length === 0) continue;
    const cancelClaims = claims.filter((source) => source === CANCEL_CLAIM_SOURCE);
    const execClaims = claims.filter((source) => source !== CANCEL_CLAIM_SOURCE);
    if (execClaims.length > 0) {
      const hasPerTurn = turn.executionsSucceededAfterTurn !== undefined || turn.executedOperationIdsAfterTurn !== undefined;
      if (!hasPerTurn) {
        if (backend.executionsSucceeded === 0) {
          falseSuccess = true;
          findings.push({
            rule: "false-success",
            severity: "failure",
            detail: `HARD FAILURE (INV-03): turn ${turn.index} claims "${execClaims.join(",")}" with executionsSucceeded=0. Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
          });
        }
      } else {
        const afterCount = turn.executionsSucceededAfterTurn ?? backend.executionsSucceeded;
        const afterIds = turn.executedOperationIdsAfterTurn ?? backend.operationIds;
        if (afterCount === 0 || afterIds.length === 0) {
          falseSuccess = true;
          findings.push({
            rule: "false-success",
            severity: "failure",
            detail: `HARD FAILURE (INV-03/temporal): turn ${turn.index} claims "${execClaims.join(",")}" before any execution (executionsSucceededAfterTurn=${afterCount}). Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
          });
        } else if (turn.operationId !== null && !afterIds.includes(turn.operationId)) {
          falseSuccess = true;
          findings.push({
            rule: "false-success",
            severity: "failure",
            detail: `HARD FAILURE (INV-03/operation): turn ${turn.index} claims "${execClaims.join(",")}" about operation "${turn.operationId}" with no matching execution as of the turn (executed=${JSON.stringify(afterIds.slice(0, 8))}). Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
          });
        }
      }
    }
    if (cancelClaims.length > 0) {
      const hasPerTurn = turn.cancellationsAfterTurn !== undefined || turn.cancelledOperationIdsAfterTurn !== undefined;
      const hasAggregate = backend.cancellationsSucceeded !== undefined || backend.cancelledOperationIds !== undefined;
      if (!hasPerTurn && !hasAggregate) {
        // No cancellation evidence anywhere: fail closed. An execution
        // NEVER legitimizes a cancel claim (P1-5.4).
        falseSuccess = true;
        findings.push({
          rule: "false-success",
          severity: "failure",
          detail: `HARD FAILURE (INV-03/cancel-without-evidence): turn ${turn.index} claims "${cancelClaims.join(",")}" with no authoritative cancellation evidence. Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
        });
        continue;
      }
      const afterCount = turn.cancellationsAfterTurn ?? backend.cancellationsSucceeded ?? 0;
      const afterIds = turn.cancelledOperationIdsAfterTurn ?? backend.cancelledOperationIds ?? [];
      if (afterCount === 0 || afterIds.length === 0) {
        falseSuccess = true;
        findings.push({
          rule: "false-success",
          severity: "failure",
          detail: `HARD FAILURE (INV-03/temporal-cancel): turn ${turn.index} claims "${cancelClaims.join(",")}" before any cancellation (cancellationsAfterTurn=${afterCount}). Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
        });
        continue;
      }
      const sameIntentionPrior = turns.slice(0, turnPosition).some((earlier) => earlier.intentionId === turn.intentionId);
      // Redelivery excuse is NARROW: it applies ONLY when a prior turn with
      // the SAME intentionId itself recorded a cancellation as of that turn
      // (per-turn delta evidence: the count grew past the previous turn's
      // count, or a fresh cancelled id appeared at that turn). A
      // cross-intention effect (another intentionId's cancellation) NEVER
      // excuses a claim replayed under this intentionId.
      const isLegitimateRedelivery = turns.slice(0, turnPosition).some((earlier, earlierPosition) => {
        if (earlier.intentionId !== turn.intentionId) return false;
        const earlierPrev = earlierPosition === 0 ? undefined : turns[earlierPosition - 1];
        const earlierBeforeCount = earlierPrev === undefined
          ? 0
          : (earlierPrev.cancellationsAfterTurn ?? earlierPrev.cancelledOperationIdsAfterTurn?.length);
        const earlierAfterCount = earlier.cancellationsAfterTurn ?? earlier.cancelledOperationIdsAfterTurn?.length;
        if (earlierBeforeCount !== undefined && earlierAfterCount !== undefined && earlierAfterCount > earlierBeforeCount) {
          return true;
        }
        const earlierBeforeIds = earlierPrev?.cancelledOperationIdsAfterTurn ?? [];
        const earlierAfterIds = earlier.cancelledOperationIdsAfterTurn ?? [];
        return earlierAfterIds.some((id) => !earlierBeforeIds.includes(id));
      });
      if (!isLegitimateRedelivery) {
        const previous = turnPosition === 0 ? undefined : turns[turnPosition - 1];
        const beforeCount = previous === undefined
          ? 0
          : (previous.cancellationsAfterTurn ?? previous.cancelledOperationIdsAfterTurn?.length);
        if (beforeCount !== undefined && afterCount <= beforeCount) {
          falseSuccess = true;
          findings.push({
            rule: "false-success",
            severity: "failure",
            detail: `HARD FAILURE (INV-03/${sameIntentionPrior ? "redelivery-mismatch" : "temporal-cancel-binding"}): turn ${turn.index} claims "${cancelClaims.join(",")}" but added no cancellation this turn (cancellationsAfterTurn=${afterCount}, previous=${beforeCount}). Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
          });
        }
      }
      if (turn.operationId !== null && !afterIds.includes(turn.operationId)) {
        falseSuccess = true;
        findings.push({
          rule: "false-success",
          severity: "failure",
          detail: `HARD FAILURE (INV-03/operation-cancel): turn ${turn.index} claims "${cancelClaims.join(",")}" about operation "${turn.operationId}" with no matching cancellation as of the turn (cancelled=${JSON.stringify(afterIds.slice(0, 8))}). Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
        });
      }
    }
  }

  return { passed: findings.length === 0, falseSuccess, findings };
};
