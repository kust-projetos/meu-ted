/**
 * F1 PR-B (issue #107) — durable observability sink Agent-local (DO SQLite)
 * para attachments + baseline G07.
 *
 * Decisão EXP-PRB-SINK (aprovada pelo Planner): sink próprio no Agent via DO
 * SQLite (`durableSql()`/`ctx.storage.sql`, molde `ensureIntentionSnapshotColumns`
 * + `toMemorySql`/`transactionSync` do #102 — aqui degradando best-effort onde
 * `transactionSync` não existir, p.ex. mocks: um INSERT de linha única já é
 * atómico no SQLite, então nenhuma transação explícita é exigida). A API
 * `audit_logs` fica como mirror fase-2 (fora deste PR); CF Analytics está
 * fora (binding novo + custo).
 *
 * POR QUE UM SANITIZER PRÓPRIO (e não `sanitizeForEvent` de dlp/redaction.ts):
 * `sanitizeForEvent` REDACTA workspace/actor/ids (`TECHNICAL_KEY`) — correto
 * para eventos genéricos, fatal para um sink de observabilidade por tenant,
 * que PRECISA de (workspaceId, actorId, cohort) como ids técnicos para a
 * baseline G07. Este módulo usa allowlist própria: preserva os três ids
 * (validados por formato, cortados em 128 chars) e PROÍBE todo o resto —
 * bytes, base64, ref bruto, conteúdo, secret e filename cru (o nome entra
 * SÓ como banda de tamanho via `attachmentNameSizeBand`, ou é omitido).
 * O tipo de entrada nem sequer declara esses campos; extras são descartados.
 *
 * Mapeamento dos nomes do critério [2] para as colunas SQLite (convenção
 * snake_case do repo; `count` = 1 por evento de upload, = deletados no
 * cleanup; agregação COUNT(*) na leitura):
 *   ts→ts, event→event, capability→capability, count→count,
 *   success→success (1/0/NULL), latencyMs→latency_ms,
 *   storageResult→storage_result, providerFailure→provider_failure,
 *   fallback→fallback, workspaceId→workspace_id, actorId→actor_id,
 *   cohort→cohort (+ name_size_band, sem equivalente no critério).
 *
 * TTL/cap (critério [4]): retenção de 90 dias + teto de linhas, podados pelo
 * `pruneAttachmentObservabilityEvents` no caminho do sweep existente
 * (piggyback no upload) — sem crescimento infinito do SQLite do DO.
 */

export type AttachmentObservabilitySql = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

/** Retenção limitada: 90 dias (critério [4]). */
export const ATTACHMENT_OBSERVABILITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Teto de linhas da tabela (critério [4]): as mais recentes sobrevivem. */
export const ATTACHMENT_OBSERVABILITY_MAX_ROWS = 5000;

export const ATTACHMENT_OBSERVABILITY_TABLE = 'attachment_observability_events';

export const ATTACHMENT_OBSERVABILITY_EVENTS = [
  'requested',
  'blocked',
  'succeeded',
  'failed',
  'cleanup.succeeded',
  'cleanup.failed',
] as const;

export type AttachmentObservabilityEvent = (typeof ATTACHMENT_OBSERVABILITY_EVENTS)[number];

const EVENT_SET = new Set<string>(ATTACHMENT_OBSERVABILITY_EVENTS);

const CAPABILITIES = ['image', 'pdf', 'audio', 'upload', 'cleanup', 'unknown'] as const;
const STORAGE_RESULTS = [
  'written',
  'dedup_hit',
  'rejected',
  'unavailable',
  'disabled',
  'swept',
  'sweep_partial',
  'unknown',
] as const;
const PROVIDER_FAILURES = ['none', 'validation', 'storage', 'timeout', 'unknown'] as const;
const FALLBACKS = ['none', 'dedup', 'retry', 'unknown'] as const;
const COHORTS = ['member', 'none', 'unknown'] as const;

const pick = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((allowed as readonly string[]).includes(trimmed)) return trimmed as T;
  }
  return 'unknown' as T;
};

/**
 * Id técnico opaco (workspace/actor): preservado, nunca redactado aqui.
 * Formato fechado `[\w.:@-]{1,128}` — qualquer outra coisa vira 'unknown'
 * (nunca é persistida crua, nunca vaza para o sink).
 */
const sanitizeTechnicalId = (value: unknown): string => {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim().slice(0, 128);
  return /^[\w.:@-]{1,128}$/.test(trimmed) ? trimmed : 'unknown';
};

/** Banda de tamanho do nome de exibição — o nome cru NUNCA é persistido. */
export const attachmentNameSizeBand = (nameLength: number): 'empty' | 'short' | 'medium' | 'long' => {
  if (!Number.isFinite(nameLength) || nameLength <= 0) return 'empty';
  if (nameLength <= 32) return 'short';
  if (nameLength <= 100) return 'medium';
  return 'long';
};

/**
 * Schema idempotente (molde `ensureIntentionSnapshotColumns`: CREATE TABLE
 * IF NOT EXISTS + índices; tolera mocks sem PRAGMA — nunca joga).
 *
 * REV-F1-PRB-SINK [P2-c]: retorna se o schema está pronto (`true`) ou não
 * (`false`, incluindo sql ausente). O accessor do DO só marca pronto em
 * `true` e retenta na próxima chamada — uma falha de init engolida nunca
 * vira "baseline vazia saudável".
 */
export const initializeAttachmentObservabilitySchema = (
  sql: AttachmentObservabilitySql | null | undefined,
): boolean => {
  if (!sql || typeof sql.exec !== 'function') return false;
  try {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS ${ATTACHMENT_OBSERVABILITY_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        capability TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        success INTEGER,
        latency_ms INTEGER,
        storage_result TEXT,
        provider_failure TEXT,
        fallback TEXT,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        cohort TEXT NOT NULL,
        name_size_band TEXT
      );
    `);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_attachment_obs_ws_ts ON ${ATTACHMENT_OBSERVABILITY_TABLE}(workspace_id, ts);`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_attachment_obs_event ON ${ATTACHMENT_OBSERVABILITY_TABLE}(event);`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_attachment_obs_ws_actor ON ${ATTACHMENT_OBSERVABILITY_TABLE}(workspace_id, actor_id);`,
    );
    return true;
  } catch {
    // Best-effort: o upload/turno nunca quebram por causa do sink.
    return false;
  }
};

export type AttachmentObservabilityInput = {
  event: string;
  capability?: string;
  /** 1 por evento de upload; deletados no cleanup. Default 1. */
  count?: number;
  success?: boolean;
  latencyMs?: number | null;
  storageResult?: string;
  providerFailure?: string;
  fallback?: string;
  workspaceId?: string;
  actorId?: string;
  cohort?: string;
  /** Comprimento cru do nome (vira banda via `attachmentNameSizeBand`). */
  nameLength?: number;
  now?: number;
};

export type AttachmentObservabilityRow = {
  ts: number;
  event: AttachmentObservabilityEvent;
  capability: string;
  count: number;
  success: 0 | 1 | null;
  latencyMs: number | null;
  storageResult: string;
  providerFailure: string;
  fallback: string;
  workspaceId: string;
  actorId: string;
  cohort: string;
  nameSizeBand: string | null;
};

/**
 * Allowlist estrita: evento fora da lista ⇒ null (descarta); todo o resto
 * tem default seguro. Nenhum campo de bytes/base64/ref/conteúdo/secret/
 * filename existe no tipo — extras em runtime são ignorados por construção
 * (só as chaves conhecidas são lidas).
 */
export const sanitizeAttachmentObservabilityInput = (input: unknown): AttachmentObservabilityRow | null => {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const event = typeof record['event'] === 'string' ? record['event'].trim() : '';
  if (!EVENT_SET.has(event)) return null;

  const latencyRaw = record['latencyMs'];
  const latencyMs =
    typeof latencyRaw === 'number' && Number.isFinite(latencyRaw)
      ? Math.max(0, Math.min(3_600_000, Math.floor(latencyRaw)))
      : null;
  const countRaw = record['count'];
  const count =
    typeof countRaw === 'number' && Number.isFinite(countRaw)
      ? Math.max(0, Math.min(1_000_000, Math.floor(countRaw)))
      : 1;
  const successRaw = record['success'];
  const nameRaw = record['nameLength'];

  return {
    ts:
      typeof record['now'] === 'number' && Number.isFinite(record['now'])
        ? Math.floor(record['now'] as number)
        : Date.now(),
    event: event as AttachmentObservabilityEvent,
    capability: pick(record['capability'], CAPABILITIES),
    count,
    success: typeof successRaw === 'boolean' ? (successRaw ? 1 : 0) : null,
    latencyMs,
    storageResult: pick(record['storageResult'], STORAGE_RESULTS),
    providerFailure: pick(record['providerFailure'], PROVIDER_FAILURES),
    fallback: pick(record['fallback'], FALLBACKS),
    workspaceId: sanitizeTechnicalId(record['workspaceId']),
    actorId: sanitizeTechnicalId(record['actorId']),
    cohort: pick(record['cohort'], COHORTS),
    nameSizeBand:
      typeof nameRaw === 'number' && Number.isFinite(nameRaw) ? attachmentNameSizeBand(nameRaw) : null,
  };
};

/**
 * Emissão best-effort: retorna true quando persistiu, false quando o sink
 * está indisponível ou a entrada é inválida — NUNCA joga (o upload/turno
 * nunca quebram por causa do sink; fault injection cobre em teste).
 */
export const emitAttachmentObservabilityEvent = (
  sql: AttachmentObservabilitySql | null | undefined,
  input: unknown,
): boolean => {
  try {
    if (!sql || typeof sql.exec !== 'function') return false;
    const row = sanitizeAttachmentObservabilityInput(input);
    if (!row) return false;
    sql.exec(
      `INSERT INTO ${ATTACHMENT_OBSERVABILITY_TABLE}
        (ts, event, capability, count, success, latency_ms, storage_result, provider_failure, fallback, workspace_id, actor_id, cohort, name_size_band)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.ts,
      row.event,
      row.capability,
      row.count,
      row.success,
      row.latencyMs,
      row.storageResult,
      row.providerFailure,
      row.fallback,
      row.workspaceId,
      row.actorId,
      row.cohort,
      row.nameSizeBand,
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * Poda best-effort chamada pelo sweep existente: apaga além de 90 dias e
 * capa no teto de linhas (mais recentes sobrevivem). Nunca joga.
 *
 * REV-F1-PRB-SINK [P2-a]: `options.maxRows` permite exercitar o teto em
 * teste sem 5000 linhas (produção usa o default `ATTACHMENT_OBSERVABILITY_MAX_ROWS`).
 */
export const pruneAttachmentObservabilityEvents = (
  sql: AttachmentObservabilitySql | null | undefined,
  now: number = Date.now(),
  options: { maxRows?: number } = {},
): { deleted: number; capped: number; failed: boolean } => {
  const maxRows =
    typeof options.maxRows === 'number' && Number.isFinite(options.maxRows) && options.maxRows >= 0
      ? Math.floor(options.maxRows)
      : ATTACHMENT_OBSERVABILITY_MAX_ROWS;
  try {
    if (!sql || typeof sql.exec !== 'function') return { deleted: 0, capped: 0, failed: true };
    let deleted = 0;
    let capped = 0;
    try {
      const before = [...sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${ATTACHMENT_OBSERVABILITY_TABLE} WHERE ts < ?`,
        now - ATTACHMENT_OBSERVABILITY_RETENTION_MS,
      )][0]?.n ?? 0;
      sql.exec(`DELETE FROM ${ATTACHMENT_OBSERVABILITY_TABLE} WHERE ts < ?`, now - ATTACHMENT_OBSERVABILITY_RETENTION_MS);
      deleted = typeof before === 'number' ? before : 0;
    } catch {
      return { deleted: 0, capped: 0, failed: true };
    }
    try {
      const total = [...sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${ATTACHMENT_OBSERVABILITY_TABLE}`)][0]?.n ?? 0;
      if (typeof total === 'number' && total > maxRows) {
        capped = total - maxRows;
        sql.exec(
          `DELETE FROM ${ATTACHMENT_OBSERVABILITY_TABLE} WHERE id NOT IN (
             SELECT id FROM ${ATTACHMENT_OBSERVABILITY_TABLE} ORDER BY id DESC LIMIT ?
           )`,
          maxRows,
        );
      }
    } catch {
      // O TTL já foi aplicado; o teto é segunda linha de defesa.
    }
    return { deleted, capped, failed: false };
  } catch {
    return { deleted: 0, capped: 0, failed: true };
  }
};

export type AttachmentCapabilityBaseline = {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /**
   * REV-F1-PRB-SINK [P2-d]: denials (`blocked`) medidos à parte — nunca no
   * success rate. `blockedRate` = blocked / total da capability (null se 0).
   */
  blocked: number;
  blockedRate: number | null;
};

export type AttachmentObservabilityBaseline = {
  total: number;
  byEvent: Record<string, number>;
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  byCapability: Record<string, AttachmentCapabilityBaseline>;
  byCohort: Record<string, { total: number; succeeded: number; failed: number }>;
  /**
   * REV-F1-PRB-SINK [P2-d]: denials (`blocked`) medidos à parte — nunca no
   * success rate, cuja semântica permanece "sucesso condicionado à ingestão
   * aceita" (`succeeded/(succeeded+failed)`). `blockedRate` = blocked/total.
   */
  blockedCount: number;
  blockedRate: number | null;
  /**
   * REV-F1-PRB-SINK [P2-c]: `true` quando a leitura NÃO conseguiu ler o sink
   * (storage ausente/quebrado) — diferente de tabela vazia saudável (`total
   * 0, degraded false`). O RPC responde 503 nesse caso, nunca 200 vazio.
   */
  degraded: boolean;
};

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? null;
};

const emptyBaseline = (degraded = false): AttachmentObservabilityBaseline => ({
  total: 0,
  byEvent: {},
  successRate: null,
  p50LatencyMs: null,
  p95LatencyMs: null,
  byCapability: {},
  byCohort: {},
  blockedCount: 0,
  blockedRate: null,
  degraded,
});

/**
 * Agregação read-only para a baseline G07 (critério [3]): counts, success
 * rate e P50/P95 de latência por capability/cohort — SEM bytes/conteúdo
 * (a tabela nem sequer tem essas colunas).
 *
 * REV-F1-PRB-SINK:
 * - [P2-b] escopo por (workspace, actor) autenticado — sem leitura
 *   workspace-wide (baseline operacional ampla é passo futuro, fora deste PR).
 * - [P2-d] P50/P95 cobrem SÓ outcomes terminais (`succeeded`/`failed`); a
 *   latência de denials (`blocked`) NÃO entra nos percentis — denials têm
 *   `blockedCount`/`blockedRate` próprios, fora do success rate.
 * - [P2-c] storage quebrado ⇒ `degraded: true` (nunca throw); tabela vazia
 *   saudável ⇒ `total 0, degraded false`.
 */
export const queryAttachmentObservabilityBaseline = (
  sql: AttachmentObservabilitySql | null | undefined,
  filter: { workspaceId: string; actorId: string; capability?: string },
): AttachmentObservabilityBaseline => {
  try {
    if (!sql || typeof sql.exec !== 'function') return emptyBaseline(true);
    const workspaceId = typeof filter.workspaceId === 'string' ? filter.workspaceId : '';
    const actorId = typeof filter.actorId === 'string' ? filter.actorId : '';
    if (!workspaceId || !actorId) return emptyBaseline(false);
    const capability = typeof filter.capability === 'string' && filter.capability ? filter.capability : null;
    const rows = capability
      ? [...sql.exec<{ event: string; capability: string; success: number | null; latency_ms: number | null; cohort: string }>(
          `SELECT event, capability, success, latency_ms, cohort FROM ${ATTACHMENT_OBSERVABILITY_TABLE} WHERE workspace_id = ? AND actor_id = ? AND capability = ?`,
          workspaceId,
          actorId,
          capability,
        )]
      : [...sql.exec<{ event: string; capability: string; success: number | null; latency_ms: number | null; cohort: string }>(
          `SELECT event, capability, success, latency_ms, cohort FROM ${ATTACHMENT_OBSERVABILITY_TABLE} WHERE workspace_id = ? AND actor_id = ?`,
          workspaceId,
          actorId,
        )];
    const baseline = emptyBaseline(false);
    baseline.total = rows.length;
    let succeeded = 0;
    let failed = 0;
    let blocked = 0;
    const latencies: number[] = [];
    const capLatencies = new Map<string, number[]>();
    for (const row of rows) {
      baseline.byEvent[row.event] = (baseline.byEvent[row.event] ?? 0) + 1;
      const cap = baseline.byCapability[row.capability] ?? {
        total: 0,
        succeeded: 0,
        failed: 0,
        successRate: null,
        p50LatencyMs: null,
        p95LatencyMs: null,
        blocked: 0,
        blockedRate: null,
      };
      cap.total += 1;
      const cohort = baseline.byCohort[row.cohort ?? 'unknown'] ?? { total: 0, succeeded: 0, failed: 0 };
      cohort.total += 1;
      const isTerminal = row.event === 'succeeded' || row.event === 'failed';
      if (row.event === 'succeeded') {
        // G07: o success rate cobre SÓ outcomes terminais do ingest
        // (`succeeded`/`failed`) — denials (`blocked`) e `requested`/cleanup
        // são contados em `byEvent`, nunca no denominador do SLO.
        succeeded += 1;
        cap.succeeded += 1;
        cohort.succeeded += 1;
      } else if (row.event === 'failed') {
        failed += 1;
        cap.failed += 1;
        cohort.failed += 1;
      } else if (row.event === 'blocked') {
        blocked += 1;
        cap.blocked += 1;
      }
      if (isTerminal && typeof row.latency_ms === 'number' && Number.isFinite(row.latency_ms)) {
        latencies.push(row.latency_ms);
        const list = capLatencies.get(row.capability) ?? [];
        list.push(row.latency_ms);
        capLatencies.set(row.capability, list);
      }
      baseline.byCapability[row.capability] = cap;
      baseline.byCohort[row.cohort ?? 'unknown'] = cohort;
    }
    latencies.sort((a, b) => a - b);
    baseline.p50LatencyMs = percentile(latencies, 0.5);
    baseline.p95LatencyMs = percentile(latencies, 0.95);
    baseline.successRate = succeeded + failed > 0 ? succeeded / (succeeded + failed) : null;
    baseline.blockedCount = blocked;
    baseline.blockedRate = baseline.total > 0 ? blocked / baseline.total : null;
    for (const [capabilityName, cap] of Object.entries(baseline.byCapability)) {
      const list = (capLatencies.get(capabilityName) ?? []).sort((a, b) => a - b);
      cap.p50LatencyMs = percentile(list, 0.5);
      cap.p95LatencyMs = percentile(list, 0.95);
      cap.successRate = cap.succeeded + cap.failed > 0 ? cap.succeeded / (cap.succeeded + cap.failed) : null;
      cap.blockedRate = cap.total > 0 ? cap.blocked / cap.total : null;
    }
    return baseline;
  } catch {
    return emptyBaseline(true);
  }
};

/**
 * Coorte attachment-specific (gate PR-A): casa por workspaceId OU actorId
 * contra `TED_ATTACHMENTS_COHORT` (CSV). Ausente/vazia ⇒ 'none'
 * (fail-closed por construção — ninguém é membro por default).
 */
export const resolveAttachmentCohort = (
  env: unknown,
  workspaceId: string,
  actorId: string,
): 'member' | 'none' => {
  const raw = (env as { TED_ATTACHMENTS_COHORT?: unknown } | undefined)?.TED_ATTACHMENTS_COHORT;
  if (typeof raw !== 'string') return 'none';
  const allow = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (allow.length === 0) return 'none';
  return allow.includes(workspaceId) || allow.includes(actorId) ? 'member' : 'none';
};

export type AttachmentObservabilitySink = {
  emit: (input: AttachmentObservabilityInput) => void;
};

/**
 * Adaptador do sink para `ingest.ts` (emissão do cleanup): preenche os
 * defaults de identidade/coorte do DO; valores explícitos vencem. Nunca
 * joga — mesmo um sql quebrado vira no-op.
 */
export const createSqlAttachmentObservabilitySink = (
  sql: AttachmentObservabilitySql | null | undefined,
  defaults: { workspaceId?: string; actorId?: string; cohort?: string } = {},
): AttachmentObservabilitySink => ({
  emit: (input) => {
    try {
      emitAttachmentObservabilityEvent(sql, {
        workspaceId: defaults.workspaceId,
        actorId: defaults.actorId,
        cohort: defaults.cohort,
        ...input,
      });
    } catch {
      // Best-effort: o sweep nunca quebra por causa do sink.
    }
  },
});
