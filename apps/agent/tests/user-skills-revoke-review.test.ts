/**
 * A18/F4 — revoking a version that is NOT the active one must not resurrect a
 * predecessor next to the live version.
 *
 * The rollback restored "the newest non-revoked version below the revoked one"
 * unconditionally: promoting v1→v2→v3 and then revoking the HISTORICAL v2
 * deactivated v2 and activated v1, leaving v1 and v3 active at the same time.
 *
 * Desired: the predecessor comes back ONLY when the revoked version was the
 * active one. Revoking an inactive (historical) version is a state no-op and is
 * idempotent.
 */
import { describe, expect, it } from 'vitest';
import {
  initializeUserSkillsSchema,
  listActiveUserSkills,
  listUserSkillVersions,
  recordReplayEvidence,
  recordSafetyReport,
  recordSkillCandidate,
  revokeUserSkillVersion,
  type ReplayEvidence,
  type SkillSafetyReport,
} from '../src/agent-config/user-skills/store.js';
import { promoteSkillCandidate } from '../src/agent-config/user-skills/promotion.js';
import { createMemorySql } from './helpers/memory-sql.js';

const WORKSPACE = 'ws-f4';

const REPLAY_PASS: ReplayEvidence = {
  fixturesId: 'fixtures-2026-10-05-f4',
  readOnly: true,
  cases: 12,
  baselineAverage: 0.62,
  candidateAverage: 0.88,
  evalsFrozenAt: '2026-10-05T00:00:00.000Z',
};

const SAFETY_PASS: SkillSafetyReport = { passed: true, failures: [] };

const freshSql = () => {
  const sql = createMemorySql();
  initializeUserSkillsSchema(sql);
  return sql;
};

const promote = (sql: ReturnType<typeof freshSql>, merchantPattern: string): string => {
  const candidate = recordSkillCandidate(sql, {
    workspaceId: WORKSPACE,
    name: 'alias-padaria',
    rule: { merchantPattern, categoryId: 'cat_padarias' },
    source: 'learn',
    scope: 'user',
  });
  if (!candidate.stored) throw new Error(`candidate refused: ${candidate.code}`);
  recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId: candidate.candidate.id, evidence: REPLAY_PASS });
  recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId: candidate.candidate.id, safety: SAFETY_PASS });
  const result = promoteSkillCandidate(sql, {
    workspaceId: WORKSPACE,
    candidateId: candidate.candidate.id,
    approvedBy: 'operator@pi',
  });
  if (!result.promoted) throw new Error(`expected promotion, got ${result.reason}`);
  return result.version.id;
};

const activeIds = (sql: ReturnType<typeof freshSql>): string[] =>
  listActiveUserSkills(sql, WORKSPACE).map((version) => version.id);

describe('A18/F4 rollback only restores a predecessor for the LIVE version', () => {
  it('revoking an already inactive historical version keeps exactly one active version', () => {
    const sql = freshSql();
    promote(sql, 'padaria do bairro');
    const v2 = promote(sql, 'padaria central');
    const v3 = promote(sql, 'padaria nova');
    expect(activeIds(sql)).toEqual([v3]);

    // v2 is historical (not active): revoking it must not activate the v1 row.
    const rollback = revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: v2 });
    expect(rollback.revoked).toBe(true);
    if (!rollback.revoked) throw new Error('expected revocation');
    expect(rollback.restored).toBeNull();
    // Exactly one live version, and it is still v3.
    expect(activeIds(sql)).toEqual([v3]);

    // Idempotent: repeating the same revocation changes nothing.
    const again = revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: v2 });
    expect(again).toEqual({ revoked: false, reason: 'already_revoked' });
    expect(activeIds(sql)).toEqual([v3]);
  });

  it('revoking the ACTIVE version still restores the previous one', () => {
    const sql = freshSql();
    const v1 = promote(sql, 'padaria do bairro');
    const v2 = promote(sql, 'padaria central');
    const v3 = promote(sql, 'padaria nova');
    // v2 was revoked above? No: fresh workspace here, so v2 is still a valid
    // predecessor even though it was deactivated by the v3 promotion.
    const rollback = revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: v3 });
    expect(rollback.revoked).toBe(true);
    if (!rollback.revoked) throw new Error('expected revocation');
    expect(rollback.restored?.id).toBe(v2);
    expect(activeIds(sql)).toEqual([v2]);
    expect(listUserSkillVersions(sql, { workspaceId: WORKSPACE, name: 'alias-padaria' })).toHaveLength(3);
    expect(v1).not.toBe(v2);
  });

  it('an inactive version revoked afterwards never becomes a second active row', () => {
    const sql = freshSql();
    const v1 = promote(sql, 'padaria do bairro');
    const v2 = promote(sql, 'padaria central');
    const v3 = promote(sql, 'padaria nova');

    revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: v2 });
    expect(activeIds(sql)).toEqual([v3]);

    // Now roll back the live one: the newest NON-REVOKED predecessor is v1
    // (v2 is revoked), so exactly one version is active again.
    revokeUserSkillVersion(sql, { workspaceId: WORKSPACE, id: v3 });
    expect(activeIds(sql)).toEqual([v1]);
    expect(listUserSkillVersions(sql, { workspaceId: WORKSPACE, name: 'alias-padaria' }).filter((v) => v.active))
      .toHaveLength(1);
  });
});