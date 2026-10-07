/**
 * F1 PR-B (issue #107) — durable observability sink Agent-local (DO SQLite)
 * para attachments + baseline G07.
 *
 * RED: estes testes descrevem o comportamento normativo novo e FALHAM contra
 * a implementação atual (eventos ainda inexistentes — só existe o sink
 * transitório `emitSanitizedEvent`, sem tabela durável e sem agregação).
 *
 * Contrato (decisão EXP-PRB-SINK aprovada pelo Planner):
 * - sink próprio no Agent via DO SQLite (`durableSql()`/`ctx.storage.sql`,
 *   molde `ensureIntentionSnapshotColumns` + `toMemorySql` do #102);
 * - sanitizer/allowlist PRÓPRIO que preserva (workspaceId, actorId, cohort)
 *   como ids técnicos e PROÍBE bytes/base64/ref bruto/conteúdo/secret/
 *   filename cru (nome → banda de tamanho ou omitir). `sanitizeForEvent`
 *   (dlp/redaction.ts) REDACTA workspace/actor/ids — NÃO reutilizar cego.
 * - escrita do sink NUNCA quebra o upload (best-effort + fault injection).
 * - API `audit_logs` fica como mirror fase-2 (fora deste PR).
 *
 * Todos os testes de persistência usam SQLite REAL (`node:sqlite`):
 * o mock permissivo ignora literais em WHERE, então agregação/TTL/cap só
 * são prováveis aqui (precedente: `memory-forget-transactional.test.ts`).
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_OBSERVABILITY_MAX_ROWS,
  ATTACHMENT_OBSERVABILITY_RETENTION_MS,
  attachmentNameSizeBand,
  createSqlAttachmentObservabilitySink,
  emitAttachmentObservabilityEvent,
  initializeAttachmentObservabilitySchema,
  pruneAttachmentObservabilityEvents,
  queryAttachmentObservabilityBaseline,
  resolveAttachmentCohort,
  sanitizeAttachmentObservabilityInput,
} from '../../src/attachments/observability.js';
import { cleanupExpiredAttachments } from '../../src/attachments/ingest.js';
import { createMemoryAttachmentStorage } from '../../src/attachments/storage.js';
import { createRelayUsageStorage } from '../helpers/relay-usage-storage.js';
import { ATTACHMENT_TTL_MS } from '../../src/attachments/types.js';
import { pngBytes } from './fixtures.js';
import {
  bytesOf,
  createAttachmentTestAgent,
  uploadRequest,
} from './helpers.js';

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createRealSql = (): { db: DatabaseSync; sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  const sql: SqlShim = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query)) return statement.all(...(bindings as never[])) as T[];
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  };
  return { db, sql };
};

/** Troca o sql permissivo do harness por SQLite real (mantém transactionSync). */
const installRealSql = (agent: object): { db: DatabaseSync; sql: SqlShim } => {
  const { db, sql } = createRealSql();
  Object.defineProperty(agent, 'ctx', {
    value: {
      storage: {
        sql,
        transactionSync: <T>(fn: () => T): T => fn(),
      },
    },
    configurable: true,
    writable: true,
  });
  return { db, sql };
};

const KIND_HEADER = 'x-ted-attachment-kind';
const NAME_HEADER = 'x-ted-attachment-name';

const GATE_OPT_IN = {
  extraEnv: { TED_ATTACHMENTS_ENABLED: '1', TED_ATTACHMENTS_COHORT: 'ws-1,actor-1' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PR-B sink — schema idempotente (molde intention_snapshots/#102)', () => {
  it('(1) init cria a tabela com as colunas do contrato e é idempotente', () => {
    const { sql } = createRealSql();
    initializeAttachmentObservabilitySchema(sql);
    initializeAttachmentObservabilitySchema(sql);
    const cols = [...sql.exec<{ name: string }>('PRAGMA table_info(attachment_observability_events)')].map(
      (row) => row.name,
    );
    for (const expected of [
      'ts',
      'event',
      'capability',
      'count',
      'success',
      'latency_ms',
      'storage_result',
      'provider_failure',
      'fallback',
      'workspace_id',
      'actor_id',
      'cohort',
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it('(2) init com sql null/quebrado nunca joga (best-effort, mocks sem PRAGMA)', () => {
    expect(() => initializeAttachmentObservabilitySchema(null)).not.toThrow();
    expect(() => initializeAttachmentObservabilitySchema(undefined)).not.toThrow();
    expect(() =>
      initializeAttachmentObservabilitySchema({
        exec: () => {
          throw new Error('no sqlite here');
        },
      }),
    ).not.toThrow();
  });
});

describe('PR-B sink — sanitizer próprio (NÃO é sanitizeForEvent)', () => {
  it('(3) preserva workspaceId/actorId/cohort como ids técnicos', () => {
    const row = sanitizeAttachmentObservabilityInput({
      event: 'requested',
      capability: 'image',
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      cohort: 'member',
    });
    expect(row).not.toBeNull();
    expect(row?.workspaceId).toBe('ws-1');
    expect(row?.actorId).toBe('actor-1');
    expect(row?.cohort).toBe('member');
  });

  it('(4) PROÍBE bytes/base64/ref/filename cru/secret/conteúdo — extras descartados, nome vira banda', () => {
    const row = sanitizeAttachmentObservabilityInput({
      event: 'succeeded',
      capability: 'image',
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      cohort: 'member',
      ref: 'att_AAAAAAAAAAAAAAAAAAAAAA',
      bytes: 'iVBORw0KGgoAAAANSUhEUg==',
      filename: 'cartao 4111111111111111.png',
      secret: 'GROQ_API_KEY=gsk_test_123',
      content: 'transcrição sigilosa do áudio',
      nameLength: 'cartao 4111111111111111.png'.length,
    } as unknown as Record<string, unknown>);
    expect(row).not.toBeNull();
    const blob = JSON.stringify(row);
    expect(blob).not.toContain('att_AAAAAAAAAAAAAAAAAAAAAA');
    expect(blob).not.toContain('iVBORw0KGgo');
    expect(blob).not.toContain('4111111111111111');
    expect(blob).not.toContain('gsk_test_123');
    expect(blob).not.toContain('transcrição sigilosa');
    expect(blob).not.toContain('cartao');
    // Nome cru some; só a banda de tamanho permanece.
    expect(row?.nameSizeBand).toBe(attachmentNameSizeBand('cartao 4111111111111111.png'.length));
  });

  it('(5) evento fora da allowlist é descartado (null); enums inválidos viram unknown/nulo', () => {
    expect(
      sanitizeAttachmentObservabilityInput({ event: 'attachment.upload.hacked', workspaceId: 'ws-1' }),
    ).toBeNull();
    const row = sanitizeAttachmentObservabilityInput({
      event: 'blocked',
      capability: 'video' as string,
      storageResult: 'exfiltrated' as string,
      providerFailure: ' Spiegel ' as string,
      latencyMs: Number.NaN,
      workspaceId: 'ws-1',
      actorId: 'actor-1',
    });
    expect(row?.capability).toBe('unknown');
    expect(row?.storageResult).toBe('unknown');
    expect(row?.providerFailure).toBe('unknown');
    expect(row?.latencyMs).toBeNull();
  });

  it('(6) latencyMs é clampada a inteiros finitos; ids malformados viram unknown', () => {
    const row = sanitizeAttachmentObservabilityInput({
      event: 'succeeded',
      latencyMs: 12.7,
      workspaceId: 'ws-1; DROP TABLE x; --',
      actorId: '',
    });
    expect(row?.latencyMs).toBe(12);
    expect(row?.workspaceId).toBe('unknown');
    expect(row?.actorId).toBe('unknown');
  });
});

describe('PR-B sink — emissão e baseline G07 em SQLite real', () => {
  it('(7) requested/blocked/succeeded/failed agregam counts, success rate e P50/P95 por capability/cohort', () => {
    const { sql } = createRealSql();
    initializeAttachmentObservabilitySchema(sql);
    const base = { workspaceId: 'ws-1', actorId: 'actor-1', cohort: 'member' };
    expect(emitAttachmentObservabilityEvent(sql, { ...base, event: 'requested', capability: 'image' })).toBe(true);
    expect(
      emitAttachmentObservabilityEvent(sql, { ...base, event: 'succeeded', capability: 'image', success: true, latencyMs: 100 }),
    ).toBe(true);
    expect(
      emitAttachmentObservabilityEvent(sql, { ...base, event: 'succeeded', capability: 'image', success: true, latencyMs: 300 }),
    ).toBe(true);
    expect(
      emitAttachmentObservabilityEvent(sql, { ...base, event: 'failed', capability: 'pdf', success: false, latencyMs: 500 }),
    ).toBe(true);
    expect(emitAttachmentObservabilityEvent(sql, { ...base, event: 'blocked', capability: 'unknown', success: false })).toBe(
      true,
    );

    const baseline = queryAttachmentObservabilityBaseline(sql, { workspaceId: 'ws-1', actorId: 'actor-1' });
    expect(baseline.total).toBe(5);
    expect(baseline.byEvent['requested']).toBe(1);
    expect(baseline.byEvent['succeeded']).toBe(2);
    expect(baseline.byEvent['failed']).toBe(1);
    expect(baseline.byEvent['blocked']).toBe(1);
    // success rate = succeeded / (succeeded + failed).
    expect(baseline.successRate).toBeCloseTo(2 / 3, 5);
    expect(baseline.byCapability['image']?.total).toBe(3);
    expect(baseline.byCapability['pdf']?.total).toBe(1);
    expect(baseline.byCohort['member']?.total).toBe(5);
    // Latências registradas: 100, 300, 500 → P50=300, P95=500.
    expect(baseline.p50LatencyMs).toBe(300);
    expect(baseline.p95LatencyMs).toBe(500);
  });

  it('(8) baseline é read-only por workspace: outro tenant não lê, filtro por capability funciona', () => {
    const { sql } = createRealSql();
    initializeAttachmentObservabilitySchema(sql);
    emitAttachmentObservabilityEvent(sql, { workspaceId: 'ws-1', actorId: 'a', cohort: 'member', event: 'succeeded', capability: 'image', success: true });
    const foreign = queryAttachmentObservabilityBaseline(sql, { workspaceId: 'ws-2', actorId: 'x' });
    expect(foreign.total).toBe(0);
    expect(foreign.successRate).toBeNull();
    const filtered = queryAttachmentObservabilityBaseline(sql, { workspaceId: 'ws-1', actorId: 'a', capability: 'pdf' });
    expect(filtered.total).toBe(0);
  });

  it('(9) TTL 90d + teto de linhas: prune apaga antigos e capa o crescimento', () => {
    expect(ATTACHMENT_OBSERVABILITY_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(ATTACHMENT_OBSERVABILITY_MAX_ROWS).toBeGreaterThan(0);
    const { sql } = createRealSql();
    initializeAttachmentObservabilitySchema(sql);
    const now = 1_800_000_000_000;
    emitAttachmentObservabilityEvent(sql, {
      workspaceId: 'ws-1', actorId: 'a', cohort: 'member',
      event: 'succeeded', capability: 'image', success: true,
      now: now - ATTACHMENT_OBSERVABILITY_RETENTION_MS - 1,
    });
    emitAttachmentObservabilityEvent(sql, {
      workspaceId: 'ws-1', actorId: 'a', cohort: 'member',
      event: 'succeeded', capability: 'image', success: true, now,
    });
    const report = pruneAttachmentObservabilityEvents(sql, now);
    expect(report.failed).toBe(false);
    expect(report.deleted).toBeGreaterThanOrEqual(1);
    expect(queryAttachmentObservabilityBaseline(sql, { workspaceId: 'ws-1', actorId: 'a' }).total).toBe(1);
  });

  it('(10) emit/prune/query com storage quebrado nunca jogam (best-effort onde transactionSync não existe)', () => {
    const broken: SqlShim = {
      exec: () => {
        throw new Error('sqlite down');
      },
    };
    expect(() => emitAttachmentObservabilityEvent(broken, { event: 'requested' })).not.toThrow();
    expect(emitAttachmentObservabilityEvent(broken, { event: 'requested' })).toBe(false);
    expect(() => pruneAttachmentObservabilityEvents(broken)).not.toThrow();
    expect(() => queryAttachmentObservabilityBaseline(broken, { workspaceId: 'ws-1', actorId: 'a' })).not.toThrow();
    expect(queryAttachmentObservabilityBaseline(broken, { workspaceId: 'ws-1', actorId: 'a' }).total).toBe(0);
    expect(queryAttachmentObservabilityBaseline(null, { workspaceId: 'ws-1', actorId: 'a' }).total).toBe(0);
  });
});

describe('PR-B sink — upload RPC emite eventos best-effort', () => {
  it('(11) upload válido emite requested + succeeded com latência, sem bytes/conteúdo no sink', async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    const { db } = installRealSql(agent);
    const res = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(10, 5)), { [KIND_HEADER]: 'image', [NAME_HEADER]: 'comprovante.png' }),
    );
    expect(res.status).toBe(200);
    const rows = db.prepare('SELECT event, capability, workspace_id, actor_id, cohort FROM attachment_observability_events').all() as Array<{
      event: string; capability: string; workspace_id: string; actor_id: string; cohort: string;
    }>;
    const events = rows.map((row) => row.event);
    expect(events).toContain('requested');
    expect(events).toContain('succeeded');
    for (const row of rows) {
      expect(row.workspace_id).toBe('ws-1');
      expect(row.actor_id).toBe('actor-1');
    }
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain('comprovante');
    expect(blob).not.toContain('att_');
  });

  it('(12) gate 503 emite blocked e validações 400/413 emitem blocked (zero-write no bucket)', async () => {
    const gated = createAttachmentTestAgent({ extraEnv: {} });
    const gatedSql = installRealSql(gated.agent);
    const denied = await gated.agent.fetch(
      uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: 'image' }),
    );
    expect(denied.status).toBe(503);
    expect(gated.bucket.objects.size).toBe(0);
    let rows = gatedSql.db.prepare('SELECT event FROM attachment_observability_events').all() as Array<{ event: string }>;
    expect(rows.map((row) => row.event)).toContain('blocked');

    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    const { db } = installRealSql(agent);
    const badKind = await agent.fetch(uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: 'video' }));
    expect(badKind.status).toBe(400);
    rows = db.prepare('SELECT event FROM attachment_observability_events').all() as Array<{ event: string }>;
    expect(rows.map((row) => row.event)).toContain('blocked');
  });

  it('(13) fault injection: sink falhando NÃO quebra o upload (falha registrada best-effort)', async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    Object.defineProperty(agent, 'ctx', {
      value: {
        storage: {
          sql: {
            exec: () => {
              throw new Error('sink down');
            },
          },
          transactionSync: <T>(fn: () => T): T => fn(),
        },
      },
      configurable: true,
      writable: true,
    });
    const res = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(8, 8)), { [KIND_HEADER]: 'image', [NAME_HEADER]: 'ok.png' }),
    );
    expect(res.status).toBe(200);
  });

  it('(14) GET /rpc/attachments/observability devolve a baseline G07 read-only, sem bytes/conteúdo', async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    installRealSql(agent);
    const up = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(8, 8)), { [KIND_HEADER]: 'image', [NAME_HEADER]: 'a.png' }),
    );
    expect(up.status).toBe(200);
    const res = await agent.fetch(
      new Request('https://agent.test.local/rpc/attachments/observability', {
        headers: { 'x-agent-actor': 'actor-1', 'x-agent-workspace': 'ws-1' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      baseline: { total: number; successRate: number | null; byCapability: Record<string, { total: number }> };
    };
    expect(body.workspaceId).toBe('ws-1');
    expect(body.baseline.total).toBeGreaterThanOrEqual(2);
    expect(body.baseline.byCapability['image']?.total).toBeGreaterThanOrEqual(2);
    const blob = JSON.stringify(body);
    expect(blob).not.toContain('att_');
    expect(blob).not.toContain('data:');
    expect(blob).not.toContain('iVBOR');

    const noAuth = await agent.fetch(new Request('https://agent.test.local/rpc/attachments/observability'));
    expect(noAuth.status).toBe(401);
  });
});

describe('PR-B sink — cleanup emite cleanup.succeeded/failed', () => {
  it('(15) sweep com expirados emite cleanup.succeeded; sweep quebrado emite cleanup.failed sem jogar', async () => {
    const { sql } = createRealSql();
    initializeAttachmentObservabilitySchema(sql);
    const sink = createSqlAttachmentObservabilitySink(sql, { workspaceId: 'ws-1', actorId: 'actor-1', cohort: 'member' });
    const storage = createMemoryAttachmentStorage();
    const now = 1_700_000_000_000;
    const { ingestAttachment } = await import('../../src/attachments/ingest.js');
    await ingestAttachment({
      storage,
      identity: { workspaceId: 'ws-1', actorId: 'actor-1' },
      kind: 'image',
      name: 'a.png',
      bytes: bytesOf(pngBytes(4, 4)),
      now: now - ATTACHMENT_TTL_MS - 1,
    });
    const report = await cleanupExpiredAttachments(storage, now, { observability: sink });
    expect(report.deleted).toBe(1);
    let baseline = queryAttachmentObservabilityBaseline(sql, { workspaceId: 'ws-1', actorId: 'actor-1' });
    expect(baseline.byEvent['cleanup.succeeded']).toBe(1);

    const brokenStorage = {
      ...storage,
      sweepByExpiry: async () => {
        throw new Error('r2 down');
      },
    };
    const failed = await cleanupExpiredAttachments(brokenStorage, now, { observability: sink });
    expect(failed.failed).toBe(true);
    baseline = queryAttachmentObservabilityBaseline(sql, { workspaceId: 'ws-1', actorId: 'actor-1' });
    expect(baseline.byEvent['cleanup.failed']).toBe(1);
  });
});

describe('PR-B sink — coorte attachment-specific', () => {
  it('(16) resolveAttachmentCohort casa por workspace OU actor; ausente/vazia = none', () => {
    expect(resolveAttachmentCohort({ TED_ATTACHMENTS_COHORT: 'ws-1,actor-9' }, 'ws-1', 'actor-1')).toBe('member');
    expect(resolveAttachmentCohort({ TED_ATTACHMENTS_COHORT: 'ws-9,actor-1' }, 'ws-1', 'actor-1')).toBe('member');
    expect(resolveAttachmentCohort({ TED_ATTACHMENTS_COHORT: 'ws-9' }, 'ws-1', 'actor-1')).toBe('none');
    expect(resolveAttachmentCohort({}, 'ws-1', 'actor-1')).toBe('none');
  });
});

describe('REV-F1-PRB-SINK — regressão dos findings do review (issue #107)', () => {
  const countRows = (db: DatabaseSync): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM attachment_observability_events').get() as { n: number }).n;

  const seedRows = (
    sql: SqlShim,
    n: number,
    options: { workspaceId?: string; actorId?: string; event?: string; now?: number } = {},
  ): void => {
    const { workspaceId = 'ws-1', actorId = 'actor-1', event = 'blocked', now = 1_800_000_000_000 } = options;
    for (let i = 0; i < n; i++) {
      emitAttachmentObservabilityEvent(sql, {
        workspaceId, actorId, cohort: 'member', event, capability: 'unknown', success: false, now,
      });
    }
  };

  it('[P2-a] denial antecipado poda o sink: tabela acima do teto converge após blocked', () => {
    const { db, sql } = createRealSql();
    initializeAttachmentObservabilitySchema(sql);
    // Base no relógio real: o prune do denial usa `Date.now()`, então as
    // expiradas precisam ser antigas de verdade para o TTL morder.
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      emitAttachmentObservabilityEvent(sql, {
        workspaceId: 'ws-1', actorId: 'a', cohort: 'member',
        event: 'blocked', capability: 'unknown', success: false,
        now: now - ATTACHMENT_OBSERVABILITY_RETENTION_MS - 1000,
      });
    }
    seedRows(sql, ATTACHMENT_OBSERVABILITY_MAX_ROWS, { now });
    expect(countRows(db)).toBe(ATTACHMENT_OBSERVABILITY_MAX_ROWS + 10);

    // Caminho de denial antecipado (kind inválido → blocked, sem ingest).
    return (async () => {
      const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
      installRealSql(agent);
      // Move o sql real pré-cheio para dentro do DO.
      const ctx = (agent as unknown as { ctx: { storage: { sql: SqlShim } } }).ctx;
      (ctx.storage as { sql: SqlShim }).sql = sql;
      const denied = await agent.fetch(
        uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: 'video' }),
      );
      expect(denied.status).toBe(400);
      // +1 blocked do denial, −10 expiradas, capado no teto.
      expect(countRows(db)).toBeLessThanOrEqual(ATTACHMENT_OBSERVABILITY_MAX_ROWS);
      const remaining = db
        .prepare('SELECT COUNT(*) AS n FROM attachment_observability_events WHERE ts < ?')
        .get(now - ATTACHMENT_OBSERVABILITY_RETENTION_MS) as { n: number };
      expect(remaining.n).toBe(0);
    })();
  });

  it('[P2-a] prune aceita teto injetável (cap exercitado sem 5000 linhas)', () => {
    const { db, sql } = createRealSql();
    initializeAttachmentObservabilitySchema(sql);
    seedRows(sql, 5);
    const report = pruneAttachmentObservabilityEvents(sql, Date.now(), { maxRows: 3 });
    expect(report.failed).toBe(false);
    expect(report.capped).toBe(2);
    expect(countRows(db)).toBe(3);
  });

  it('[P2-b] baseline isolada por ator: dois atores do mesmo workspace não se leem', async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    installRealSql(agent);
    const up = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(8, 8)), { [KIND_HEADER]: 'image', [NAME_HEADER]: 'a.png' }),
    );
    expect(up.status).toBe(200);
    const own = await agent.fetch(
      new Request('https://agent.test.local/rpc/attachments/observability', {
        headers: { 'x-agent-actor': 'actor-1', 'x-agent-workspace': 'ws-1' },
      }),
    );
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { baseline: { total: number } };
    expect(ownBody.baseline.total).toBeGreaterThan(0);
    const foreign = await agent.fetch(
      new Request('https://agent.test.local/rpc/attachments/observability', {
        headers: { 'x-agent-actor': 'actor-2', 'x-agent-workspace': 'ws-1' },
      }),
    );
    expect(foreign.status).toBe(200);
    const foreignBody = (await foreign.json()) as { baseline: { total: number } };
    expect(foreignBody.baseline.total).toBe(0);
  });

  it('[P2-c] leitura com sink quebrado sinaliza indisponibilidade (503, não baseline vazia 200)', async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    Object.defineProperty(agent, 'ctx', {
      value: {
        storage: {
          sql: {
            exec: () => {
              throw new Error('sink down');
            },
          },
          transactionSync: <T>(fn: () => T): T => fn(),
        },
      },
      configurable: true,
      writable: true,
    });
    const res = await agent.fetch(
      new Request('https://agent.test.local/rpc/attachments/observability', {
        headers: { 'x-agent-actor': 'actor-1', 'x-agent-workspace': 'ws-1' },
      }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('agent.observability_unavailable');
  });

  it('[P2-c] init marca pronto só após sucesso: falha tenta de novo na próxima chamada', async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    let createAttempts = 0;
    let failCreates = 1;
    const base = createRelayUsageStorage().exec;
    const countingSql: SqlShim = {
      exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
        if (/CREATE/i.test(query) && query.includes('attachment_observability_events')) {
          createAttempts += 1;
          if (failCreates > 0) {
            failCreates -= 1;
            throw new Error('ddl down');
          }
        }
        return base<T>(query, ...bindings);
      },
    };
    Object.defineProperty(agent, 'ctx', {
      value: { storage: { sql: countingSql, transactionSync: <T>(fn: () => T): T => fn() } },
      configurable: true,
      writable: true,
    });
    const first = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: 'image' }),
    );
    expect(first.status).toBe(200);
    const afterFirst = createAttempts;
    expect(afterFirst).toBeGreaterThan(0);
    // Init falhou ⇒ pronto NÃO marcado ⇒ segunda chamada retenta o DDL.
    const second = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: 'image' }),
    );
    expect(second.status).toBe(200);
    expect(createAttempts).toBeGreaterThan(afterFirst);
    // Init ok ⇒ pronto marcado ⇒ terceira chamada não reemite DDL.
    const afterSecond = createAttempts;
    const third = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(4, 4)), { [KIND_HEADER]: 'image' }),
    );
    expect(third.status).toBe(200);
    expect(createAttempts).toBe(afterSecond);
  });

  it('[P2-d] percentis cobrem SÓ outcomes terminais; denials têm métricas próprias', () => {
    const { sql } = createRealSql();
    initializeAttachmentObservabilitySchema(sql);
    const base = { workspaceId: 'ws-1', actorId: 'actor-1', cohort: 'member' };
    emitAttachmentObservabilityEvent(sql, { ...base, event: 'succeeded', capability: 'image', success: true, latencyMs: 100 });
    emitAttachmentObservabilityEvent(sql, { ...base, event: 'succeeded', capability: 'image', success: true, latencyMs: 300 });
    emitAttachmentObservabilityEvent(sql, { ...base, event: 'blocked', capability: 'image', success: false, latencyMs: 1000 });
    emitAttachmentObservabilityEvent(sql, { ...base, event: 'blocked', capability: 'image', success: false, latencyMs: 1000 });
    const baseline = queryAttachmentObservabilityBaseline(sql, { workspaceId: 'ws-1', actorId: 'actor-1' });
    // Latência de denial (1000) NÃO entra nos percentis: [100,300].
    expect(baseline.p50LatencyMs).toBe(100);
    expect(baseline.p95LatencyMs).toBe(300);
    // Success rate condicionado à ingestão aceita: 2/2.
    expect(baseline.successRate).toBe(1);
    // Denials medidos à parte, fora do success rate.
    expect(baseline.blockedCount).toBe(2);
    expect(baseline.blockedRate).toBeCloseTo(2 / 4, 5);
    expect(baseline.byCapability['image']?.blocked).toBe(2);
  });

  it('[P3] dedup emite dedup_hit (não written) e a resposta HTTP mantém os 5 campos públicos', async () => {
    const { agent } = createAttachmentTestAgent(GATE_OPT_IN);
    const { db } = installRealSql(agent);
    const bytes = bytesOf(pngBytes(6, 6));
    const first = await agent.fetch(uploadRequest(bytes, { [KIND_HEADER]: 'image' }));
    expect(first.status).toBe(200);
    const second = await agent.fetch(uploadRequest(bytes, { [KIND_HEADER]: 'image' }));
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.ref).toBe(firstBody.ref);
    expect(Object.keys(secondBody).sort()).toEqual(['expiresAt', 'kind', 'name', 'ref', 'size']);
    const results = db
      .prepare("SELECT storage_result AS r FROM attachment_observability_events WHERE event = 'succeeded' ORDER BY rowid")
      .all() as Array<{ r: string }>;
    expect(results.map((row) => row.r)).toEqual(['written', 'dedup_hit']);
  });
});
