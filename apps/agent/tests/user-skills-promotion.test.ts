/**
 * A18 / R17 - AC28: promotion is gated by three independent inputs and
 * rollback restores the previous version.
 *
 * A candidate becomes an active user skill ONLY with (a) offline read-only
 * replay evidence (fixtures + frozen evals), (b) a passed safety report and
 * (c) an explicit human approval. A candidate that improves the average but
 * fails safety is never promoted, and the periodic sweep (the every-N-turns
 * routine bound to the learning job) has no promotion path at all and never
 * touches core skills.
 */

import { describe, expect, it } from 'vitest';
import { ALL_SKILLS } from '../src/agent-config/skills/index.js';
import {
  initializeUserSkillsSchema,
  getSkillCandidate,
  listActiveUserSkills,
  listUserSkillVersions,
  recordReplayEvidence,
  recordSafetyReport,
  recordSkillCandidate,
  revokeUserSkillVersion,
  type ReplayEvidence,
  type SkillSafetyReport,
} from '../src/agent-config/user-skills/store.js';
import {
  promoteSkillCandidate,
  runPeriodicUserSkillSweep,
} from '../src/agent-config/user-skills/promotion.js';
import { createMemorySql } from './helpers/memory-sql.js';

const WORKSPACE = 'ws-a18';

const RULE = { merchantPattern: 'padaria do bairro', categoryId: 'cat_padarias' };

const REPLAY_PASS: ReplayEvidence = {
  fixturesId: 'fixtures-2026-10-04-a18',
  readOnly: true,
  cases: 42,
  baselineAverage: 0.62,
  candidateAverage: 0.79,
  evalsFrozenAt: '2026-10-04T00:00:00.000Z',
};

/**
 * The announced case is "the candidate IMPROVES the average but fails safety",
 * so the fixture must really improve it: a candidate AVERAGE BELOW the baseline
 * would let the safety assertion pass for the wrong reason (the gate refuses a
 * regression on its own).
 */
const REPLAY_FAILING: ReplayEvidence = {
  ...REPLAY_PASS,
  candidateAverage: 0.99,
};

const IMPROVES_AVERAGE = (evidence: ReplayEvidence): boolean =>
  evidence.candidateAverage > evidence.baselineAverage;

const SAFETY_PASS: SkillSafetyReport = { passed: true, failures: [] };

const SAFETY_FAIL: SkillSafetyReport = {
  passed: false,
  failures: ['writes_pending_operation'],
};

const freshSql = () => {
  const sql = createMemorySql();
  initializeUserSkillsSchema(sql);
  return sql;
};

/** Records a candidate and returns its id. */
const seedCandidate = (
  sql: ReturnType<typeof freshSql>,
  overrides: {
    rule?: unknown;
    name?: string;
    scope?: 'user' | 'core';
  } = {},
): string => {
  const result = recordSkillCandidate(sql, {
    workspaceId: WORKSPACE,
    name: overrides.name ?? 'alias-padaria',
    rule: (overrides.rule ?? RULE) as never,
    source: 'learn',
    scope: overrides.scope ?? 'user',
  });
  if (!result.stored) throw new Error(`candidate refused: ${result.code}`);
  return result.candidate.id;
};

describe('A18 promotion gate (AC28)', () => {
  it('promotes when replay evidence, safety and human approval are all present', () => {
    const sql = freshSql();
    const candidateId = seedCandidate(sql);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });

    const result = promoteSkillCandidate(sql, {
      workspaceId: WORKSPACE,
      candidateId,
      approvedBy: 'operator@pi',
    });
    expect(result.promoted).toBe(true);
    if (!result.promoted) throw new Error('expected promotion');
    expect(result.version.name).toBe('alias-padaria');
    expect(result.version.version).toBe(1);
    expect(result.version.active).toBe(true);
    expect(result.version.approvedBy).toBe('operator@pi');

    const active = listActiveUserSkills(sql, WORKSPACE);
    expect(active.map((version) => version.name)).toEqual(['alias-padaria']);
    expect(getSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId })?.status).toBe('promoted');
  });

  it('does NOT promote a candidate that improves the average but fails safety', () => {
    const sql = freshSql();
    // The fixture really does improve the average: safety is the only reason.
    expect(IMPROVES_AVERAGE(REPLAY_FAILING)).toBe(true);
    const candidateId = seedCandidate(sql);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_FAILING });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_FAIL });

    const result = promoteSkillCandidate(sql, {
      workspaceId: WORKSPACE,
      candidateId,
      approvedBy: 'operator@pi',
    });
    expect(result.promoted).toBe(false);
    if (result.promoted) throw new Error('expected refusal');
    expect(result.reason).toBe('safety_failed');

    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(0);
    expect(listUserSkillVersions(sql, { workspaceId: WORKSPACE, name: 'alias-padaria' })).toHaveLength(0);
    const candidate = getSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId });
    expect(candidate?.status).toBe('rejected');
    expect(candidate?.rejectionReason).toBe('safety_failed');
  });

  it('does NOT promote a candidate whose replay only passes safety and approval', () => {
    const sql = freshSql();
    const candidateId = seedCandidate(sql);
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });
    const result = promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' });
    expect(result.promoted).toBe(false);
    if (result.promoted) throw new Error('expected refusal');
    expect(result.reason).toBe('missing_replay_evidence');
    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(0);
  });

  it('refuses replay evidence that is not offline/read-only or has no frozen evals', () => {
    const writes = freshSql();
    const writeCandidate = seedCandidate(writes, { name: 'alias-escrita' });
    recordReplayEvidence(writes, { workspaceId: WORKSPACE, candidateId: writeCandidate, evidence: { ...REPLAY_PASS, readOnly: false } });
    recordSafetyReport(writes, { workspaceId: WORKSPACE, candidateId: writeCandidate, safety: SAFETY_PASS });
    const writeResult = promoteSkillCandidate(writes, {
      workspaceId: WORKSPACE,
      candidateId: writeCandidate,
      approvedBy: 'operator@pi',
    });
    expect(writeResult.promoted).toBe(false);
    if (writeResult.promoted) throw new Error('expected refusal');
    expect(writeResult.reason).toBe('replay_not_read_only');

    const unfrozen = freshSql();
    const frozenCandidate = seedCandidate(unfrozen, { name: 'alias-sem-evals' });
    recordReplayEvidence(unfrozen, {
      workspaceId: WORKSPACE,
      candidateId: frozenCandidate,
      evidence: { ...REPLAY_PASS, evalsFrozenAt: '' },
    });
    recordSafetyReport(unfrozen, { workspaceId: WORKSPACE, candidateId: frozenCandidate, safety: SAFETY_PASS });
    const frozenResult = promoteSkillCandidate(unfrozen, {
      workspaceId: WORKSPACE,
      candidateId: frozenCandidate,
      approvedBy: 'operator@pi',
    });
    expect(frozenResult.promoted).toBe(false);
    if (frozenResult.promoted) throw new Error('expected refusal');
    expect(frozenResult.reason).toBe('replay_not_read_only');
    expect(listActiveUserSkills(unfrozen, WORKSPACE)).toHaveLength(0);
  });

  it('does NOT promote without explicit human approval, even with replay and safety', () => {
    const sql = freshSql();
    const candidateId = seedCandidate(sql);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });

    for (const approvedBy of [undefined, '', '   ']) {
      const result = promoteSkillCandidate(sql, {
        workspaceId: WORKSPACE,
        candidateId,
        approvedBy: approvedBy as string | undefined,
      });
      expect(result.promoted).toBe(false);
      if (result.promoted) throw new Error('expected refusal');
      expect(result.reason).toBe('missing_approval');
    }
    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(0);
    // A pending input keeps the candidate pending so a human can still approve.
    expect(getSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId })?.status).toBe('candidate');
    // ...and approving afterwards promotes it.
    expect(promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' }).promoted).toBe(
      true,
    );
  });

  it('does NOT promote without a safety report at all', () => {
    const sql = freshSql();
    const candidateId = seedCandidate(sql);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    const result = promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' });
    expect(result.promoted).toBe(false);
    if (result.promoted) throw new Error('expected refusal');
    expect(result.reason).toBe('missing_safety');
    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(0);
  });

  it('never promotes a core skill, whatever the evidence says', () => {
    const sql = freshSql();
    const coreName = ALL_SKILLS[0]!.name;
    // A candidate declared as a core-scope change (a non-core name, so the
    // store's own name guard is not what stops it) must still never promote.
    const candidateId = seedCandidate(sql, { name: 'alias-core-override', scope: 'core' });
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });

    const result = promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' });
    expect(result.promoted).toBe(false);
    if (result.promoted) throw new Error('expected refusal');
    expect(result.reason).toBe('core_immutable');
    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(0);
    expect(listUserSkillVersions(sql, { workspaceId: WORKSPACE, name: 'alias-core-override' })).toHaveLength(0);
    // Core catalog object itself is untouched.
    expect(ALL_SKILLS.map((skill) => skill.name)).toContain(coreName);
    expect(sql.rows('agent_user_skills')).toHaveLength(0);
  });

  it('re-validates the rule at promotion time', () => {
    const sql = freshSql();
    const candidateId = seedCandidate(sql);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });
    // Corrupt the stored rule behind the API (schema drift), then promote.
    const row = sql.rows('agent_skill_candidates').find((candidate) => candidate['id'] === candidateId);
    row!['rule'] = JSON.stringify({ merchantPattern: 'padaria', tool: 'transactions_create' });
    const result = promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' });
    expect(result.promoted).toBe(false);
    if (result.promoted) throw new Error('expected refusal');
    expect(result.reason).toBe('invalid_rule');
    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(0);
  });

  it('refuses an unknown candidate and refuses to promote the same candidate twice', () => {
    const sql = freshSql();
    const missing = promoteSkillCandidate(sql, {
      workspaceId: WORKSPACE,
      candidateId: 'does-not-exist',
      approvedBy: 'operator@pi',
    });
    expect(missing.promoted).toBe(false);
    if (missing.promoted) throw new Error('expected refusal');
    expect(missing.reason).toBe('candidate_not_found');

    const candidateId = seedCandidate(sql);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });
    expect(promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' }).promoted).toBe(
      true,
    );
    const second = promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' });
    expect(second.promoted).toBe(false);
    if (second.promoted) throw new Error('expected refusal');
    expect(second.reason).toBe('already_promoted');
    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(1);
  });

  it('scopes every read and write to the workspace', () => {
    const sql = freshSql();
    const candidateId = seedCandidate(sql);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });
    promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' });

    expect(listActiveUserSkills(sql, 'other-workspace')).toHaveLength(0);
    expect(listUserSkillVersions(sql, { workspaceId: 'other-workspace', name: 'alias-padaria' })).toHaveLength(0);
    const crossWorkspace = promoteSkillCandidate(sql, {
      workspaceId: 'other-workspace',
      candidateId,
      approvedBy: 'operator@pi',
    });
    expect(crossWorkspace.promoted).toBe(false);
    if (crossWorkspace.promoted) throw new Error('expected refusal');
    expect(crossWorkspace.reason).toBe('candidate_not_found');
  });
});

describe('A18 rollback restores the previous version (AC28)', () => {
  const promote = (sql: ReturnType<typeof freshSql>, rule: unknown, name = 'alias-padaria'): string => {
    const candidateId = seedCandidate(sql, { rule, name });
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });
    const result = promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' });
    if (!result.promoted) throw new Error(`expected promotion, got ${result.reason}`);
    return result.version.id;
  };

  it('activating a new version deactivates the previous one and revoking restores it', () => {
    const sql = freshSql();
    const v1 = promote(sql, { merchantPattern: 'padaria do bairro', categoryId: 'cat_padarias' });
    const v2 = promote(sql, { merchantPattern: 'padaria central', categoryId: 'cat_padarias' });

    expect(listActiveUserSkills(sql, WORKSPACE).map((version) => version.id)).toEqual([v2]);
    const versions = listUserSkillVersions(sql, { workspaceId: WORKSPACE, name: 'alias-padaria' });
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions.find((version) => version.id === v1)?.active).toBe(false);

    const rollback = revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: v2 });
    expect(rollback.revoked).toBe(true);
    if (!rollback.revoked) throw new Error('expected revocation');
    expect(rollback.restored?.id).toBe(v1);

    const active = listActiveUserSkills(sql, WORKSPACE);
    expect(active.map((version) => version.id)).toEqual([v1]);
    expect(active[0]!.rule).toEqual({ merchantPattern: 'padaria do bairro', categoryId: 'cat_padarias' });
    expect(active[0]!.revokedAt).toBeNull();
  });

  it('revoking the only version leaves nothing active and never touches core skills', () => {
    const sql = freshSql();
    const only = promote(sql, RULE);
    const rollback = revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: only });
    expect(rollback.revoked).toBe(true);
    if (!rollback.revoked) throw new Error('expected revocation');
    expect(rollback.restored).toBeNull();
    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(0);
    // Revoked rows are kept (additive, non destructive) but excluded.
    expect(listUserSkillVersions(sql, { workspaceId: WORKSPACE, name: 'alias-padaria' })).toHaveLength(1);
    expect(ALL_SKILLS.map((skill) => skill.name)).toContain('registros');
  });

  it('refuses to revoke a revoked, unknown or cross-workspace version', () => {
    const sql = freshSql();
    const only = promote(sql, RULE);
    expect(revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: only }).revoked).toBe(true);
    expect(revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: only })).toEqual({
      revoked: false,
      reason: 'already_revoked',
    });
    expect(revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: 'nope' })).toEqual({
      revoked: false,
      reason: 'not_found',
    });
    expect(revokeUserSkillVersion(sql, { workspaceId: 'other-workspace', id: only })).toEqual({
      revoked: false,
      reason: 'not_found',
    });
  });
});

describe('A18 periodic sweep never promotes (AC28)', () => {
  it('records candidates but promotes nothing, even with a fully approved candidate pending', () => {
    const sql = freshSql();
    const candidateId = seedCandidate(sql);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });

    const sweep = runPeriodicUserSkillSweep(sql, { workspaceId: WORKSPACE });
    expect(sweep.inspectedCandidates).toBe(1);
    expect(sweep.promotions).toBe(0);
    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(0);
    expect(getSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId })?.status).toBe('candidate');
  });

  it('deactivates (never deletes) a version whose stored rule no longer validates', () => {
    const sql = freshSql();
    const candidateId = seedCandidate(sql);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId, evidence: REPLAY_PASS });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId, safety: SAFETY_PASS });
    const promoted = promoteSkillCandidate(sql, { workspaceId: WORKSPACE, candidateId, approvedBy: 'operator@pi' });
    if (!promoted.promoted) throw new Error('expected promotion');
    const row = sql.rows('agent_user_skills').find((entry) => entry['id'] === promoted.version.id);
    row!['rule'] = JSON.stringify({ merchantPattern: 'padaria', sql: 'delete from transactions' });

    const sweep = runPeriodicUserSkillSweep(sql, { workspaceId: WORKSPACE });
    expect(sweep.deactivatedStale).toBe(1);
    expect(sweep.promotions).toBe(0);
    expect(listActiveUserSkills(sql, WORKSPACE)).toHaveLength(0);
    // Additive: the row is still there for audit.
    expect(sql.rows('agent_user_skills')).toHaveLength(1);
    expect(ALL_SKILLS).toHaveLength(10);
  });

  it('is a no-op on an empty workspace', () => {
    const sql = freshSql();
    expect(runPeriodicUserSkillSweep(sql, { workspaceId: WORKSPACE })).toEqual({
      inspectedCandidates: 0,
      deactivatedStale: 0,
      promotions: 0,
    });
  });
});