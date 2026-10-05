/**
 * A18 / R17 (AC27/AC28): user skill versions and promotion candidates in the
 * DO SQLite database.
 *
 * - `agent_skill_candidates`: what the learning path proposes. A candidate is
 *   inert data until the promotion gate (AC28) clears it.
 * - `agent_user_skills`: versioned user skills (`version` increments per
 *   `name`), with `active` marking the single live version and `revoked_at`
 *   marking a permanently disabled one.
 *
 * Both tables are ADDITIVE (CREATE TABLE IF NOT EXISTS, no destructive
 * migration, no delete path): revoking deactivates and keeps the row for
 * audit. Everything is workspace-scoped on every read and write.
 *
 * Core skills live in versioned TypeScript modules (`skills/*.ts`) and are
 * never read from or written to here: `isCoreSkillName` refuses collisions.
 */

import { randomUUID } from 'node:crypto';
import { parseUserSkillRule, userSkillKeywords, type UserSkillRule, type UserSkillRuleErrorCode } from './schema.js';
import { ALL_SKILLS } from '../skills/index.js';

export { userSkillKeywords };

export type UserSkillsSql = {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>;
};

/** `core` candidates exist only to be refused: core skills are not promotable. */
export type UserSkillScope = 'user' | 'core';
export type SkillCandidateStatus = 'candidate' | 'promoted' | 'rejected';

/** (a) offline read-only replay artifact required before any promotion. */
export type ReplayEvidence = {
  /** Versioned fixture set the replay ran against. */
  fixturesId: string;
  /** True only when the replay performed no writes of any kind. */
  readOnly: boolean;
  cases: number;
  baselineAverage: number;
  candidateAverage: number;
  /** Timestamp of the frozen eval set (must be pinned, not "latest"). */
  evalsFrozenAt: string;
};

/** (b) safety verdict for the candidate body. */
export type SkillSafetyReport = {
  passed: boolean;
  failures: string[];
};

/** The three promotion inputs, persisted with the version they promoted. */
export type PromotionEvidence = {
  fixturesId: string;
  readOnly: boolean;
  evalsFrozenAt: string;
  baselineAverage: number;
  candidateAverage: number;
  safetyFailures: string[];
  approvedBy: string;
  recordedAt: string;
};

export type SkillCandidate = {
  id: string;
  workspaceId: string;
  name: string;
  scope: UserSkillScope;
  rule: UserSkillRule;
  source: string;
  status: SkillCandidateStatus;
  rejectionReason: string | null;
  replayEvidence: ReplayEvidence | null;
  safety: SkillSafetyReport | null;
  approvedBy: string | null;
  promotedSkillId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UserSkillVersion = {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  rule: UserSkillRule;
  keywords: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
  approvedBy: string | null;
  promotionEvidence: PromotionEvidence | null;
  revokedAt: string | null;
};

export type UserSkillWriteErrorCode =
  | UserSkillRuleErrorCode
  | 'invalid_name'
  | 'core_name_conflict'
  | 'missing_workspace';

export type UserSkillWriteResult =
  | { stored: true; candidate: SkillCandidate }
  | { stored: false; code: UserSkillWriteErrorCode; field: string | null };

export type RevokeResult =
  | { revoked: true; restored: UserSkillVersion | null }
  | { revoked: false; reason: 'not_found' | 'already_revoked' | 'core_immutable' };

const CORE_SKILL_NAMES: ReadonlySet<string> = new Set(ALL_SKILLS.map((skill) => skill.name));

/** Case-insensitive so `Registros` cannot smuggle a core-skill version. */
export const isCoreSkillName = (name: string): boolean =>
  CORE_SKILL_NAMES.has((name ?? '').trim().toLowerCase());

const USER_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{2,47}$/;

const nowIso = (): string => new Date().toISOString();

export const initializeUserSkillsSchema = (sql: UserSkillsSql): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_skill_candidates (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'user',
      rule TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'learn',
      status TEXT NOT NULL DEFAULT 'candidate',
      rejection_reason TEXT,
      replay_evidence TEXT,
      safety TEXT,
      approved_by TEXT,
      promoted_skill_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS agent_skill_candidates_pending_idx ON agent_skill_candidates (workspace_id, status);`,
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_user_skills (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      rule TEXT NOT NULL,
      keywords TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_by TEXT,
      promotion_evidence TEXT,
      revoked_at TEXT
    );
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS agent_user_skills_active_idx ON agent_user_skills (workspace_id, active);`,
  );
};

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

const toRule = (raw: unknown): UserSkillRule => {
  const record = parseJson<Record<string, unknown>>(raw, {});
  return {
    merchantPattern: String(record['merchantPattern'] ?? ''),
    ...(record['categoryId'] === undefined ? {} : { categoryId: String(record['categoryId']) }),
    ...(record['categoryName'] === undefined ? {} : { categoryName: String(record['categoryName']) }),
    ...(record['note'] === undefined ? {} : { note: String(record['note']) }),
  };
};

const mapCandidate = (row: Record<string, unknown>): SkillCandidate => ({
  id: String(row['id']),
  workspaceId: String(row['workspace_id']),
  name: String(row['name']),
  scope: row['scope'] === 'core' ? 'core' : 'user',
  rule: toRule(row['rule']),
  source: String(row['source'] ?? 'learn'),
  status: (['candidate', 'promoted', 'rejected'].includes(String(row['status']))
    ? String(row['status'])
    : 'candidate') as SkillCandidateStatus,
  rejectionReason: row['rejection_reason'] == null ? null : String(row['rejection_reason']),
  replayEvidence: parseJson<ReplayEvidence | null>(row['replay_evidence'], null),
  safety: parseJson<SkillSafetyReport | null>(row['safety'], null),
  approvedBy: row['approved_by'] == null ? null : String(row['approved_by']),
  promotedSkillId: row['promoted_skill_id'] == null ? null : String(row['promoted_skill_id']),
  createdAt: String(row['created_at']),
  updatedAt: String(row['updated_at']),
});

const mapVersion = (row: Record<string, unknown>): UserSkillVersion => ({
  id: String(row['id']),
  workspaceId: String(row['workspace_id']),
  name: String(row['name']),
  version: Number(row['version'] ?? 1),
  rule: toRule(row['rule']),
  keywords: parseJson<string[]>(row['keywords'], []),
  active: Number(row['active'] ?? 0) !== 0,
  createdAt: String(row['created_at']),
  updatedAt: String(row['updated_at']),
  approvedBy: row['approved_by'] == null ? null : String(row['approved_by']),
  promotionEvidence: parseJson<PromotionEvidence | null>(row['promotion_evidence'], null),
  revokedAt: row['revoked_at'] == null ? null : String(row['revoked_at']),
});

const selectRows = (sql: UserSkillsSql, query: string, ...bindings: unknown[]): Record<string, unknown>[] =>
  [...sql.exec<Record<string, unknown>>(query, ...bindings)];

/**
 * Records a proposal. The rule is validated here — an invalid or non
 * declarative rule never reaches the table (nothing is persisted).
 */
export const recordSkillCandidate = (
  sql: UserSkillsSql,
  input: {
    workspaceId: string;
    name: string;
    rule: unknown;
    source?: string;
    scope?: UserSkillScope;
  },
): UserSkillWriteResult => {
  const workspaceId = (input.workspaceId ?? '').trim();
  if (workspaceId.length === 0) return { stored: false, code: 'missing_workspace', field: null };
  const name = (input.name ?? '').trim();
  if (!USER_SKILL_NAME_RE.test(name)) return { stored: false, code: 'invalid_name', field: 'name' };
  // Core skills are versioned modules; a user version of the same name would
  // shadow them at selection time.
  if (isCoreSkillName(name)) return { stored: false, code: 'core_name_conflict', field: 'name' };

  const parsed = parseUserSkillRule(input.rule);
  if (!parsed.ok) return { stored: false, code: parsed.code, field: parsed.field };

  const candidate: SkillCandidate = {
    id: randomUUID(),
    workspaceId,
    name,
    scope: input.scope === 'core' ? 'core' : 'user',
    rule: parsed.rule,
    source: (input.source ?? 'learn').trim() || 'learn',
    status: 'candidate',
    rejectionReason: null,
    replayEvidence: null,
    safety: null,
    approvedBy: null,
    promotedSkillId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  sql.exec(
    `INSERT INTO agent_skill_candidates (id, workspace_id, name, scope, rule, source, status, rejection_reason, replay_evidence, safety, approved_by, promoted_skill_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    candidate.id,
    candidate.workspaceId,
    candidate.name,
    candidate.scope,
    JSON.stringify(candidate.rule),
    candidate.source,
    candidate.status,
    candidate.rejectionReason,
    null,
    null,
    candidate.approvedBy,
    candidate.promotedSkillId,
    candidate.createdAt,
    candidate.updatedAt,
  );
  return { stored: true, candidate };
};

export const recordReplayEvidence = (
  sql: UserSkillsSql,
  input: { workspaceId: string; candidateId: string; evidence: ReplayEvidence },
): SkillCandidate | null => {
  const candidate = selectRows(
    sql,
    `SELECT * FROM agent_skill_candidates WHERE workspace_id = ? AND id = ?`,
    input.workspaceId,
    input.candidateId,
  )[0];
  if (!candidate) return null;
  const updatedAt = nowIso();
  sql.exec(
    `UPDATE agent_skill_candidates SET replay_evidence = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(input.evidence ?? {}),
    updatedAt,
    input.candidateId,
  );
  return mapCandidate({ ...candidate, ['replay_evidence']: JSON.stringify(input.evidence ?? {}), ['updated_at']: updatedAt });
};

export const recordSafetyReport = (
  sql: UserSkillsSql,
  input: { workspaceId: string; candidateId: string; safety: SkillSafetyReport },
): SkillCandidate | null => {
  const candidate = selectRows(
    sql,
    `SELECT * FROM agent_skill_candidates WHERE workspace_id = ? AND id = ?`,
    input.workspaceId,
    input.candidateId,
  )[0];
  if (!candidate) return null;
  const updatedAt = nowIso();
  sql.exec(
    `UPDATE agent_skill_candidates SET safety = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(input.safety ?? { passed: false, failures: ['missing_safety_report'] }),
    updatedAt,
    input.candidateId,
  );
  return mapCandidate({ ...candidate, ['safety']: JSON.stringify(input.safety ?? {}), ['updated_at']: updatedAt });
};

export const getSkillCandidate = (
  sql: UserSkillsSql,
  input: { workspaceId: string; candidateId: string },
): SkillCandidate | null => {
  const row = selectRows(
    sql,
    `SELECT * FROM agent_skill_candidates WHERE workspace_id = ? AND id = ?`,
    input.workspaceId,
    input.candidateId,
  )[0];
  return row ? mapCandidate(row) : null;
};

const listCandidates = (sql: UserSkillsSql, workspaceId: string, status?: SkillCandidateStatus): SkillCandidate[] => {
  const rows =
    status === undefined
      ? selectRows(sql, `SELECT * FROM agent_skill_candidates WHERE workspace_id = ?`, workspaceId)
      : selectRows(
          sql,
          `SELECT * FROM agent_skill_candidates WHERE workspace_id = ? AND status = ?`,
          workspaceId,
          status,
        );
  return rows.map(mapCandidate).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

const listVersions = (sql: UserSkillsSql, workspaceId: string, name?: string): UserSkillVersion[] => {
  const rows =
    name === undefined
      ? selectRows(sql, `SELECT * FROM agent_user_skills WHERE workspace_id = ?`, workspaceId)
      : selectRows(
          sql,
          `SELECT * FROM agent_user_skills WHERE workspace_id = ? AND name = ?`,
          workspaceId,
          name,
        );
  return rows.map(mapVersion).sort((a, b) => b.version - a.version);
};

export const listActiveUserSkills = (sql: UserSkillsSql, workspaceId: string): UserSkillVersion[] =>
  listVersions(sql, workspaceId).filter((version) => version.active && version.revokedAt == null);

export const listUserSkillVersions = (
  sql: UserSkillsSql,
  input: { workspaceId: string; name?: string },
): UserSkillVersion[] => listVersions(sql, input.workspaceId, input.name);

const setActive = (sql: UserSkillsSql, versionId: string, active: boolean): void => {
  sql.exec(`UPDATE agent_user_skills SET active = ?, updated_at = ? WHERE id = ?`, active ? 1 : 0, nowIso(), versionId);
};

export const deactivateUserSkillVersion = (
  sql: UserSkillsSql,
  input: { workspaceId: string; id: string },
): UserSkillVersion | null => {
  const version = listVersions(sql, input.workspaceId).find((entry) => entry.id === input.id);
  if (!version) return null;
  setActive(sql, input.id, false);
  return { ...version, active: false, updatedAt: nowIso() };
};

/**
 * Appends a new version of `name` and makes it the live one. Only the
 * promotion gate calls this (AC28): the periodic sweep has no path to it.
 */
export const insertActiveUserSkillVersion = (
  sql: UserSkillsSql,
  input: {
    workspaceId: string;
    name: string;
    rule: UserSkillRule;
    approvedBy: string;
    evidence: PromotionEvidence;
  },
): UserSkillVersion => {
  const existing = listVersions(sql, input.workspaceId, input.name);
  const nextVersion = existing.reduce((max, entry) => Math.max(max, entry.version), 0) + 1;
  for (const entry of existing) {
    if (entry.active) setActive(sql, entry.id, false);
  }
  const version: UserSkillVersion = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    name: input.name,
    version: nextVersion,
    rule: input.rule,
    keywords: userSkillKeywords(input.rule),
    active: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    approvedBy: input.approvedBy,
    promotionEvidence: input.evidence,
    revokedAt: null,
  };
  sql.exec(
    `INSERT INTO agent_user_skills (id, workspace_id, name, version, rule, keywords, active, created_at, updated_at, approved_by, promotion_evidence, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    version.id,
    version.workspaceId,
    version.name,
    version.version,
    JSON.stringify(version.rule),
    JSON.stringify(version.keywords),
    1,
    version.createdAt,
    version.updatedAt,
    version.approvedBy,
    JSON.stringify(version.promotionEvidence),
    null,
  );
  return version;
};

/**
 * AC28 rollback: revoking a version reactivates the newest non-revoked version
 * below it, restoring the previous behavior. Nothing is deleted and core is
 * never touched (core has no rows here at all).
 */
export const revokeUserSkillVersion = (
  sql: UserSkillsSql,
  input: { workspaceId: string; id: string },
): RevokeResult => {
  const versions = listVersions(sql, input.workspaceId);
  const version = versions.find((entry) => entry.id === input.id);
  if (!version) return { revoked: false, reason: 'not_found' };
  if (isCoreSkillName(version.name)) return { revoked: false, reason: 'core_immutable' };
  if (version.revokedAt != null) return { revoked: false, reason: 'already_revoked' };

  const revokedAt = nowIso();
  sql.exec(
    `UPDATE agent_user_skills SET active = ?, revoked_at = ?, updated_at = ? WHERE id = ?`,
    0,
    revokedAt,
    revokedAt,
    version.id,
  );
  /**
   * F4: the predecessor comes back ONLY when the revoked version WAS the live
   * one. Revoking a historical (already inactive) version is a state no-op for
   * the rest of the chain: restoring a predecessor next to the still-active
   * newest version would leave two active versions of the same skill.
   */
  const restored =
    version.active
      ? (versions
          .filter((entry) => entry.name === version.name && entry.version < version.version && entry.revokedAt == null)
          .sort((a, b) => b.version - a.version)[0] ?? null)
      : null;
  if (restored) setActive(sql, restored.id, true);
  return {
    revoked: true,
    restored: restored ? { ...restored, active: true } : null,
  };
};

export const markCandidate = (
  sql: UserSkillsSql,
  input: {
    workspaceId: string;
    candidateId: string;
    status: SkillCandidateStatus;
    rejectionReason?: string | null;
    approvedBy?: string | null;
    promotedSkillId?: string | null;
  },
): void => {
  sql.exec(
    `UPDATE agent_skill_candidates SET status = ?, rejection_reason = ?, approved_by = ?, promoted_skill_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    input.status,
    input.rejectionReason ?? null,
    input.approvedBy ?? null,
    input.promotedSkillId ?? null,
    nowIso(),
    input.workspaceId,
    input.candidateId,
  );
};

export { listCandidates as listSkillCandidates };