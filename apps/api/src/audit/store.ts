import type { Pool } from 'pg';

export type AuditLog = {
  id: string;
  workspaceId: string;
  actorType: 'device' | 'user';
  actorId: string;
  operation: string;
  eventType: string;
  payloadHash: string;
  effectRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AuditLogFilters = {
  limit?: number;
  operation?: string;
  eventType?: string;
  actorType?: AuditLog['actorType'];
  entityType?: string;
  entityId?: string;
};

export type AuditLogStore = {
  listAuditLogs(workspaceId: string, filters: AuditLogFilters): Promise<{ items: AuditLog[]; total: number }>;
};

type Row = {
  id: string;
  workspace_id: string;
  actor_type: AuditLog['actorType'];
  actor_id: string;
  operation: string;
  event_type: string;
  payload_hash: string;
  effect_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
};

const mapRow = (row: Row): AuditLog => ({
  id: row.id,
  workspaceId: row.workspace_id,
  actorType: row.actor_type,
  actorId: row.actor_id,
  operation: row.operation,
  eventType: row.event_type,
  payloadHash: row.payload_hash,
  ...(row.effect_ref === null ? {} : { effectRef: row.effect_ref }),
  metadata: row.metadata ?? {},
  createdAt: new Date(row.created_at).toISOString(),
});

export const createInMemoryAuditLogStore = (seed: AuditLog[] = []): AuditLogStore => ({
  async listAuditLogs(workspaceId, filters) {
    const filtered = seed
      .filter((log) => log.workspaceId === workspaceId)
      .filter((log) => filters.operation === undefined || log.operation === filters.operation)
      .filter((log) => filters.eventType === undefined || log.eventType === filters.eventType)
      .filter((log) => filters.actorType === undefined || log.actorType === filters.actorType)
      .filter((log) => filters.entityType === undefined || log.metadata.entityType === filters.entityType)
      .filter((log) => filters.entityId === undefined || log.effectRef === filters.entityId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = filtered.length;
    return { items: filtered.slice(0, filters.limit ?? 20), total };
  },
});

export const createPostgresAuditLogStore = (pool: Pool): AuditLogStore => ({
  async listAuditLogs(workspaceId, filters) {
    const where = ['workspace_id = $1'];
    const values: unknown[] = [workspaceId];
    if (filters.operation !== undefined) { values.push(filters.operation); where.push(`operation = $${values.length}`); }
    if (filters.eventType !== undefined) { values.push(filters.eventType); where.push(`event_type = $${values.length}`); }
    if (filters.actorType !== undefined) { values.push(filters.actorType); where.push(`actor_type = $${values.length}`); }
    if (filters.entityType !== undefined) { values.push(filters.entityType); where.push(`metadata->>'entityType' = $${values.length}`); }
    if (filters.entityId !== undefined) { values.push(filters.entityId); where.push(`effect_ref = $${values.length}`); }
    const limit = filters.limit ?? 20;
    values.push(limit);
    const result = await pool.query<Row & { total_count: string }>(
      `SELECT id, workspace_id, actor_type, actor_id, operation, event_type,
              payload_hash, effect_ref, metadata, created_at,
              COUNT(*) OVER ()::text AS total_count
         FROM audit_logs
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return {
      items: result.rows.map(mapRow),
      total: result.rows.length === 0 ? 0 : Number(result.rows[0]!.total_count),
    };
  },
});
