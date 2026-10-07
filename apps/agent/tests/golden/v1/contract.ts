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
 */
const SUCCESS_CLAIM_SOURCES = [
  String.raw`\bregistrad[oa]s?\b`,
  String.raw`\blan[cç]ad[oa]s?\b`,
  String.raw`\bpag[oa]s?\b`,
  String.raw`\bfeit[oa]s?\b`,
  String.raw`\bconclu[ií]d[oa]s?\b`,
  String.raw`\bconfirmad[oa]s?\b`,
  String.raw`\bcancelad[oa]s?\b`,
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
}>;

export type BackendSnapshot = Readonly<{
  proposalsCreated: number;
  executionsSucceeded: number;
  ledgerEntries: number;
  operationIds: readonly string[];
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

  // INV-03 — false-success = HARD FAILURE. A success claim is legitimate ONLY
  // when the authoritative backend holds a matching execution AT OR BEFORE
  // the claiming turn's response — never a later turn's — and, when the turn
  // carries an operationId, that SAME operation (not any other operation Y).
  // A proposal is NOT an execution: "Proposta ... Confirma?" carries no claim
  // by construction, and any past-tense claim over a merely-proposed op fails.
  // Turns carrying a per-turn snapshot (`executionsSucceededAfterTurn` /
  // `executedOperationIdsAfterTurn`, recorded by the runner) use it; turns
  // without one fall back to the final `backend` aggregate (legacy unit-call
  // path). A null-operationId claim is a summary reference: legitimate only
  // when at least one execution already exists as of the turn.
  let falseSuccess = false;
  for (const turn of turns) {
    const claims = detectSuccessClaim(turn.responseText);
    if (claims.length === 0) continue;
    const hasPerTurn = turn.executionsSucceededAfterTurn !== undefined || turn.executedOperationIdsAfterTurn !== undefined;
    if (!hasPerTurn) {
      if (backend.executionsSucceeded === 0) {
        falseSuccess = true;
        findings.push({
          rule: "false-success",
          severity: "failure",
          detail: `HARD FAILURE (INV-03): turn ${turn.index} claims "${claims.join(",")}" with executionsSucceeded=0. Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
        });
      }
      continue;
    }
    const afterCount = turn.executionsSucceededAfterTurn ?? backend.executionsSucceeded;
    const afterIds = turn.executedOperationIdsAfterTurn ?? backend.operationIds;
    if (afterCount === 0 || afterIds.length === 0) {
      falseSuccess = true;
      findings.push({
        rule: "false-success",
        severity: "failure",
        detail: `HARD FAILURE (INV-03/temporal): turn ${turn.index} claims "${claims.join(",")}" before any execution (executionsSucceededAfterTurn=${afterCount}). Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
      });
      continue;
    }
    if (turn.operationId !== null && !afterIds.includes(turn.operationId)) {
      falseSuccess = true;
      findings.push({
        rule: "false-success",
        severity: "failure",
        detail: `HARD FAILURE (INV-03/operation): turn ${turn.index} claims "${claims.join(",")}" about operation "${turn.operationId}" with no matching execution as of the turn (executed=${JSON.stringify(afterIds.slice(0, 8))}). Response: ${JSON.stringify(turn.responseText.slice(0, 160))}`,
      });
    }
  }

  return { passed: findings.length === 0, falseSuccess, findings };
};
