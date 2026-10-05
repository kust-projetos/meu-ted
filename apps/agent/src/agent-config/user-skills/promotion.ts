/**
 * A18 / R17 (AC28): the promotion gate for user skills.
 *
 * A candidate becomes an active user skill ONLY when all three independent
 * inputs are present:
 *
 *   (a) offline read-only replay evidence (pinned fixtures + frozen evals),
 *   (b) a passed safety report,
 *   (c) an explicit human approval (`approvedBy`).
 *
 * A candidate that improves the average but fails safety is refused, and so is
 * one that misses any of the three. The gate also re-validates the stored rule
 * at promotion time (schema drift) and refuses core-scope candidates outright.
 *
 * The periodic routine has NO promotion path at all: it may only deactivate a
 * version whose stored rule no longer validates, and it never writes a core
 * skill (core skills are versioned modules, not rows).
 */

import { parseUserSkillRule } from './schema.js';
import {
  getSkillCandidate,
  insertActiveUserSkillVersion,
  listActiveUserSkills,
  listSkillCandidates,
  markCandidate,
  deactivateUserSkillVersion,
  type PromotionEvidence,
  type ReplayEvidence,
  type SkillCandidate,
  type UserSkillVersion,
  type UserSkillsSql,
} from './store.js';

export type PromotionRejection =
  | 'candidate_not_found'
  | 'already_promoted'
  | 'already_rejected'
  | 'core_immutable'
  | 'missing_replay_evidence'
  | 'replay_not_read_only'
  | 'missing_safety'
  | 'safety_failed'
  | 'missing_approval'
  | 'invalid_rule';

export type PromotionResult =
  | { promoted: true; version: UserSkillVersion; reason: null }
  | { promoted: false; reason: PromotionRejection };

/** Replay evidence is only acceptable when it is a frozen, read-only replay. */
const isAcceptableReplay = (evidence: ReplayEvidence | null): boolean =>
  evidence != null &&
  evidence.readOnly === true &&
  typeof evidence.fixturesId === 'string' &&
  evidence.fixturesId.trim().length > 0 &&
  typeof evidence.evalsFrozenAt === 'string' &&
  evidence.evalsFrozenAt.trim().length > 0;

const reject = (
  sql: UserSkillsSql,
  candidate: SkillCandidate,
  reason: PromotionRejection,
  options?: { terminal?: boolean },
): PromotionResult => {
  // A pending input (no replay yet, no safety report, no approval yet) leaves
  // the candidate pending: a human can still complete it. A definitive fail
  // (unsafe body, non read-only replay, schema drift, core scope) is terminal.
  if (options?.terminal === false) return { promoted: false, reason };
  markCandidate(sql, {
    workspaceId: candidate.workspaceId,
    candidateId: candidate.id,
    status: 'rejected',
    rejectionReason: reason,
  });
  return { promoted: false, reason };
};

/**
 * AC28. All refusals are typed and recorded on the candidate; the function
 * never throws and never writes an active version without the three inputs.
 */
export const promoteSkillCandidate = (
  sql: UserSkillsSql,
  input: { workspaceId: string; candidateId: string; approvedBy?: string | null },
): PromotionResult => {
  const candidate = getSkillCandidate(sql, {
    workspaceId: input.workspaceId,
    candidateId: input.candidateId,
  });
  if (!candidate) return { promoted: false, reason: 'candidate_not_found' };
  if (candidate.status === 'promoted') return { promoted: false, reason: 'already_promoted' };
  if (candidate.status === 'rejected') return { promoted: false, reason: 'already_rejected' };
  // Core skills are promoted by shipping a new module version, never by a row.
  if (candidate.scope === 'core') return reject(sql, candidate, 'core_immutable');

  if (candidate.replayEvidence == null) return reject(sql, candidate, 'missing_replay_evidence', { terminal: false });
  if (!isAcceptableReplay(candidate.replayEvidence)) return reject(sql, candidate, 'replay_not_read_only');

  if (candidate.safety == null) return reject(sql, candidate, 'missing_safety', { terminal: false });
  if (candidate.safety.passed !== true) return reject(sql, candidate, 'safety_failed');

  const approvedBy = (input.approvedBy ?? '').trim();
  if (approvedBy.length === 0) return reject(sql, candidate, 'missing_approval', { terminal: false });

  // Re-validate: a row that drifted out of the closed schema never activates.
  const parsed = parseUserSkillRule(candidate.rule);
  if (!parsed.ok) return reject(sql, candidate, 'invalid_rule');

  const evidence: PromotionEvidence = {
    fixturesId: candidate.replayEvidence.fixturesId,
    readOnly: candidate.replayEvidence.readOnly,
    evalsFrozenAt: candidate.replayEvidence.evalsFrozenAt,
    baselineAverage: candidate.replayEvidence.baselineAverage,
    candidateAverage: candidate.replayEvidence.candidateAverage,
    safetyFailures: candidate.safety.failures,
    approvedBy,
    recordedAt: new Date().toISOString(),
  };
  const version = insertActiveUserSkillVersion(sql, {
    workspaceId: input.workspaceId,
    name: candidate.name,
    rule: parsed.rule,
    approvedBy,
    evidence,
  });
  markCandidate(sql, {
    workspaceId: input.workspaceId,
    candidateId: candidate.id,
    status: 'promoted',
    rejectionReason: null,
    approvedBy,
    promotedSkillId: version.id,
  });
  return { promoted: true, version, reason: null };
};

export type UserSkillSweepResult = {
  inspectedCandidates: number;
  deactivatedStale: number;
  /** Literal zero: a periodic routine can never promote, by construction. */
  promotions: 0;
};

/**
 * Periodic maintenance bound to the learning cadence (every N turns). It only
 * inspects candidates and deactivates versions whose stored rule no longer
 * validates the closed schema. It never promotes (G06.5: only an explicit,
 * human-approved promotion path may activate a user skill) and never writes a
 * core skill.
 */
export const runPeriodicUserSkillSweep = (
  sql: UserSkillsSql,
  input: { workspaceId: string },
): UserSkillSweepResult => {
  const pending = listSkillCandidates(sql, input.workspaceId, 'candidate');
  let deactivatedStale = 0;
  for (const version of listActiveUserSkills(sql, input.workspaceId)) {
    if (parseUserSkillRule(version.rule).ok) continue;
    deactivateUserSkillVersion(sql, { workspaceId: input.workspaceId, id: version.id });
    deactivatedStale += 1;
  }
  return { inspectedCandidates: pending.length, deactivatedStale, promotions: 0 };
};