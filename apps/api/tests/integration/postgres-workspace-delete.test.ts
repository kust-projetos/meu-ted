import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/pool.js";
import { createPostgresWorkspaceStore } from "../../src/auth/workspaces-postgres.js";
import { buildDeleteConfirmation, signAgentEmptyProof } from "../../src/auth/workspace-deletion.js";

/**
 * D2 (ADR-027) em Postgres real descartável: migration V062, delete
 * vazio ponta a ponta, concorrência e tombstone. Sem DML prod, sem
 * aplicar migration em prod — SOMENTE DATABASE_URL_TEST.
 */
const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;
let pool: Pool | undefined;

describe("Postgres workspace D2 delete-vazio integration", () => {
  // Segredo HMAC só-teste, explícito por store (nunca segredo real —
  // SOMENTE DATABASE_URL_TEST). A prova do lado Agent é assinada
  // white-box com ele (o Agent real emite com o mesmo segredo
  // compartilhado); sem segredo, tudo bloqueia fail-closed.
  const TEST_SECRET = 'test-only-workspace-deletion-hmac-secret';
  const testStore = () => {
    if (!pool) throw new Error("database pool not initialized");
    return createPostgresWorkspaceStore(pool, undefined, { deletionHmacSecret: TEST_SECRET });
  };
  const depositFor = async (
    store: ReturnType<typeof testStore>,
    workspaceId: string,
    inventoryVersion: string,
  ): Promise<string> => {
    const proof = signAgentEmptyProof(
      {
        workspaceId,
        inventoryVersion,
        counts: { sessions: 0, messages: 0, memories: 0, attachments: 0 },
      },
      TEST_SECRET,
    );
    return (await store.depositEmptyAttestation({ proof })).attestationId;
  };
  beforeAll(() => {
    // Segredo HMAC só-teste também no env (cobertura dos caminhos que
    // resolvem via process.env): sem ele, a emissão fail-closed recusa
    // tudo. Nunca segredo real — SOMENTE DATABASE_URL_TEST.
    process.env.WORKSPACE_DELETION_HMAC_SECRET ??= TEST_SECRET;
    if (DB_URL) pool = createPool({ connectionString: DB_URL, max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  const seedUser = async (client: Pool, authUserId: string, email: string) => {
    await client.query(
      `INSERT INTO "user" (id, name, email, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [authUserId, "Integration User", email],
    );
    const result = await client.query<{ id: string }>(
      `INSERT INTO users (auth_user_id, email, name, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [authUserId, email, "Integration User"],
    );
    return result.rows[0]!.id;
  };

  itIfDatabase("V063 aplicada: tabelas de fechamento e depósito existem e CHECK aceita deleted", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const tomb = await pool.query(`SELECT to_regclass('public.workspace_tombstones') AS r`);
    const log = await pool.query(`SELECT to_regclass('public.workspace_closure_log') AS r`);
    const deposits = await pool.query(`SELECT to_regclass('public.workspace_empty_attestations') AS r`);
    // FIX-WS-D2-R5: sem skip — o PG descartável aplica V061+V062+V063
    // via job/migrate antes da suite; ausência aqui é falha fechada.
    expect(tomb.rows[0]?.['r']).toBe('workspace_tombstones');
    expect(log.rows[0]?.['r']).toBe('workspace_closure_log');
    expect(deposits.rows[0]?.['r']).toBe('workspace_empty_attestations');
  });

  itIfDatabase("vazio deleta de verdade; com-dados recusa; purge bloqueado", async () => {
    if (!pool) throw new Error("database pool not initialized");
    // FIX-WS-D2-R2 item 6: sem skip — V062 é pré-requisito aplicado.
    const tomb = await pool.query(`SELECT to_regclass('public.workspace_tombstones') AS r`);
    expect(tomb.rows[0]?.['r']).toBe('workspace_tombstones');
    const store = testStore();

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2-${randomUUID()}@example.com`);

    // Workspace vazio: inventário vazio → delete OK com o handle opaco
    // do depósito server-side (white-box: mesmo segredo compartilhado);
    // sem handle, `unverified` bloqueia fail-closed.
    const empty = await store.create({ authUserId: authUser, name: "Vazio", kind: "shared" });
    const inventory = await store.deletionInventory({ authUserId: authUser, householdId: empty.id });
    expect(inventory.empty).toBe(true);
    expect(inventory.agentAttestation).toBe('unverified');
    // Barreira cross-store sob PG real: sem handle, nunca conclui.
    await expect(
      store.deleteEmpty({
        authUserId: authUser,
        householdId: empty.id,
        confirmation: buildDeleteConfirmation({
          workspaceId: empty.id,
          actor: authUser,
          inventoryVersion: inventory.inventoryVersion,
          expiresAt: inventory.expiresAt,
          agentAttestation: 'unverified',
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified' });
    const attestationId = await depositFor(store, empty.id, inventory.inventoryVersion);
    // O handle é opaco: só UUID, sem conteúdo/HMAC no valor.
    expect(attestationId).toMatch(/^[0-9a-f-]{36}$/i);
    const receipt = await store.deleteEmpty({
      authUserId: authUser,
      householdId: empty.id,
      confirmation: buildDeleteConfirmation({
        workspaceId: empty.id,
        actor: authUser,
        inventoryVersion: inventory.inventoryVersion,
        expiresAt: inventory.expiresAt,
        agentAttestation: 'unverified',
        attestationId,
      }),
    });
    expect(receipt.id).toBe(empty.id);
    // Tombstone gravado; linha preservada como marcador.
    const tombRow = await pool.query(`SELECT * FROM workspace_tombstones WHERE household_id = $1`, [empty.id]);
    expect(tombRow.rowCount).toBe(1);
    const statusRow = await pool.query(`SELECT status FROM households WHERE id = $1`, [empty.id]);
    expect(statusRow.rows[0]?.['status']).toBe('deleted');
    // Fora da lista; segundo delete recusa.
    expect((await store.list(authUser)).some((w) => w.id === empty.id)).toBe(false);
    await expect(
      store.deleteEmpty({
        authUserId: authUser,
        householdId: empty.id,
        confirmation: buildDeleteConfirmation({
          workspaceId: empty.id,
          actor: authUser,
          inventoryVersion: receipt.inventoryVersion,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          agentAttestation: 'verified-empty',
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });

    // Workspace com dado: cria conta via SQL direto (setup de teste, não
    // caminho de produto) → inventário não-vazio → delete recusa.
    const full = await store.create({ authUserId: authUser, name: "Cheio", kind: "shared" });
    await pool.query(
      `INSERT INTO accounts (household_id, name, kind, balance_cents, status)
       VALUES ($1, 'Conta', 'cash', 0, 'active')`,
      [full.id],
    );
    try {
      const fullInventory = await store.deletionInventory({ authUserId: authUser, householdId: full.id });
      expect(fullInventory.empty).toBe(false);
      await expect(
        store.deleteEmpty({
          authUserId: authUser,
          householdId: full.id,
          confirmation: buildDeleteConfirmation({
            workspaceId: full.id,
            actor: authUser,
            inventoryVersion: fullInventory.inventoryVersion,
            expiresAt: fullInventory.expiresAt,
            agentAttestation: 'verified-empty',
          }),
        }),
      ).rejects.toMatchObject({ code: 'workspace.not_empty' });
      // Purge com-dados bloqueado mesmo com confirmação válida.
      await expect(
        store.deleteEmpty({
          authUserId: authUser,
          householdId: full.id,
          confirmation: buildDeleteConfirmation({
            workspaceId: full.id,
            actor: authUser,
            inventoryVersion: fullInventory.inventoryVersion,
            expiresAt: fullInventory.expiresAt,
            agentAttestation: 'verified-empty',
          }),
          purge: true,
        }),
      ).rejects.toMatchObject({ code: 'workspace.purge_blocked' });
      // Nada foi apagado pelo caminho de recusa.
      const stillThere = await pool.query(`SELECT COUNT(*)::int AS c FROM accounts WHERE household_id = $1`, [full.id]);
      expect(stillThere.rows[0]?.['c']).toBe(1);
    } finally {
      await pool.query(`DELETE FROM accounts WHERE household_id = $1`, [full.id]);
    }
  });

  itIfDatabase("concorrência real: dois deletes simultâneos, um vence", async () => {
    if (!pool) throw new Error("database pool not initialized");
    // FIX-WS-D2-R2 item 6: sem skip — V062 é pré-requisito aplicado.
    const tomb = await pool.query(`SELECT to_regclass('public.workspace_tombstones') AS r`);
    expect(tomb.rows[0]?.['r']).toBe('workspace_tombstones');
    const store = testStore();

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2c-${randomUUID()}@example.com`);
    const ws = await store.create({ authUserId: authUser, name: "Corrida", kind: "shared" });
    const inventory = await store.deletionInventory({ authUserId: authUser, householdId: ws.id });
    // Cada concorrente tem seu próprio depósito (handles distintos).
    const attestationA = await depositFor(store, ws.id, inventory.inventoryVersion);
    const attestationB = await depositFor(store, ws.id, inventory.inventoryVersion);
    const confirmation = (attestationId: string) =>
      buildDeleteConfirmation({
        workspaceId: ws.id,
        actor: authUser,
        inventoryVersion: inventory.inventoryVersion,
        expiresAt: inventory.expiresAt,
        agentAttestation: 'unverified',
        attestationId,
      });
    const results = await Promise.allSettled([
      store.deleteEmpty({ authUserId: authUser, householdId: ws.id, confirmation: confirmation(attestationA) }),
      store.deleteEmpty({ authUserId: authUser, householdId: ws.id, confirmation: confirmation(attestationB) }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exatamente um vence: o FOR UPDATE serializa e o segundo encontra
    // o tombstone (recusa workspace.deleted) sem reescrever nada.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(['workspace.deleted', 'workspace.confirmation_invalid', 'workspace.not_empty']).toContain(reason.code);
  });

  itIfDatabase("FIX-WS-D2-R5: mesmo handle em dois deletes — single-use (um conclui, outro recusa)", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const store = testStore();

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2s-${randomUUID()}@example.com`);
    const ws = await store.create({ authUserId: authUser, name: "SingleUse", kind: "shared" });
    const inventory = await store.deletionInventory({ authUserId: authUser, householdId: ws.id });
    const attestationId = await depositFor(store, ws.id, inventory.inventoryVersion);
    const confirmation = () =>
      buildDeleteConfirmation({
        workspaceId: ws.id,
        actor: authUser,
        inventoryVersion: inventory.inventoryVersion,
        expiresAt: inventory.expiresAt,
        agentAttestation: 'unverified',
        attestationId,
      });
    const results = await Promise.allSettled([
      store.deleteEmpty({ authUserId: authUser, householdId: ws.id, confirmation: confirmation() }),
      store.deleteEmpty({ authUserId: authUser, householdId: ws.id, confirmation: confirmation() }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // O handle nunca conclui dois deletes: o segundo encontra o depósito
    // já consumido (agent_unverified) ou o tombstone (deleted).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(['workspace.deleted', 'workspace.agent_unverified']).toContain(reason.code);
    // Consumo registrado exatamente uma vez.
    const consumed = await pool.query(
      `SELECT COUNT(*)::int AS c FROM workspace_empty_attestations WHERE id = $1 AND consumed_at IS NOT NULL`,
      [attestationId],
    );
    expect(consumed.rows[0]?.['c']).toBe(1);
  });

  itIfDatabase("FIX-WS-D2-R5: depósito expirado recusa sem efeito (nada tocado)", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const store = testStore();

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2e-${randomUUID()}@example.com`);
    const ws = await store.create({ authUserId: authUser, name: "Expirado", kind: "shared" });
    const inventory = await store.deletionInventory({ authUserId: authUser, householdId: ws.id });
    // Depósito expirado inserido direto (setup de teste, não caminho de
    // produto — o depósito real sempre expira no futuro e a verificação
    // HMAC cobre a expiração): o consumo deve recusar pelo predicado
    // `expires_at > NOW()`.
    const expiredId = randomUUID();
    await pool.query(
      `INSERT INTO workspace_empty_attestations (id, household_id, inventory_version, counts, expires_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW() - INTERVAL '1 minute')`,
      [expiredId, ws.id, inventory.inventoryVersion, JSON.stringify({ sessions: 0, messages: 0, memories: 0, attachments: 0 })],
    );
    await expect(
      store.deleteEmpty({
        authUserId: authUser,
        householdId: ws.id,
        confirmation: buildDeleteConfirmation({
          workspaceId: ws.id,
          actor: authUser,
          inventoryVersion: inventory.inventoryVersion,
          expiresAt: inventory.expiresAt,
          agentAttestation: 'unverified',
          attestationId: expiredId,
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified' });
    // Nada foi tocado: workspace segue ativo e sem tombstone.
    const status = await pool.query(`SELECT status FROM households WHERE id = $1`, [ws.id]);
    expect(status.rows[0]?.['status']).toBe('active');
    const tombRow = await pool.query(`SELECT * FROM workspace_tombstones WHERE household_id = $1`, [ws.id]);
    expect(tombRow.rowCount).toBe(0);
  });

  itIfDatabase("FIX-WS-D2-R5: depósito de outro workspace recusa sem consumir", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const store = testStore();

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2d-${randomUUID()}@example.com`);
    const wsA = await store.create({ authUserId: authUser, name: "Alvo", kind: "shared" });
    const wsB = await store.create({ authUserId: authUser, name: "Outro", kind: "shared" });
    const invA = await store.deletionInventory({ authUserId: authUser, householdId: wsA.id });
    const invB = await store.deletionInventory({ authUserId: authUser, householdId: wsB.id });
    const attestationId = await depositFor(store, wsA.id, invA.inventoryVersion);
    // Handle de A no delete de B: recusa, sem consumir.
    await expect(
      store.deleteEmpty({
        authUserId: authUser,
        householdId: wsB.id,
        confirmation: buildDeleteConfirmation({
          workspaceId: wsB.id,
          actor: authUser,
          inventoryVersion: invB.inventoryVersion,
          expiresAt: invB.expiresAt,
          agentAttestation: 'unverified',
          attestationId,
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.agent_unverified' });
    const consumed = await pool.query(
      `SELECT consumed_at FROM workspace_empty_attestations WHERE id = $1`,
      [attestationId],
    );
    expect(consumed.rows[0]?.['consumed_at']).toBeNull();
    // O depósito legítimo segue válido: delete de A conclui.
    const receipt = await store.deleteEmpty({
      authUserId: authUser,
      householdId: wsA.id,
      confirmation: buildDeleteConfirmation({
        workspaceId: wsA.id,
        actor: authUser,
        inventoryVersion: invA.inventoryVersion,
        expiresAt: invA.expiresAt,
        agentAttestation: 'unverified',
        attestationId,
      }),
    });
    expect(receipt.id).toBe(wsA.id);
  });

  itIfDatabase("FIX-WS-D2-R2 item 5: replay com expiresAt adulterado recusa em PG real", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const store = testStore();

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2r-${randomUUID()}@example.com`);
    const ws = await store.create({ authUserId: authUser, name: "Replay", kind: "shared" });
    const inventory = await store.deletionInventory({ authUserId: authUser, householdId: ws.id });
    expect(inventory.empty).toBe(true);
    // Replay com `expiresAt` re-carimbado ainda válido na janela.
    const tamperedExpiresAt = new Date(Date.parse(inventory.expiresAt) - 5 * 60 * 1000).toISOString();
    expect(Date.parse(tamperedExpiresAt)).toBeGreaterThan(Date.now());
    await expect(
      store.deleteEmpty({
        authUserId: authUser,
        householdId: ws.id,
        confirmation: buildDeleteConfirmation({
          workspaceId: ws.id,
          actor: authUser,
          inventoryVersion: inventory.inventoryVersion,
          expiresAt: tamperedExpiresAt,
          agentAttestation: 'verified-empty',
        }),
      }),
    ).rejects.toMatchObject({ code: 'workspace.confirmation_invalid' });
    // Nada foi tocado: workspace segue ativo e sem tombstone.
    const status = await pool.query(`SELECT status FROM households WHERE id = $1`, [ws.id]);
    expect(status.rows[0]?.['status']).toBe('active');
    const tombRow = await pool.query(`SELECT * FROM workspace_tombstones WHERE household_id = $1`, [ws.id]);
    expect(tombRow.rowCount).toBe(0);
  });

  itIfDatabase("FIX-WS-D2-R2 item 2: delete-vs-create e archive-vs-create reais", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const { createPostgresWriteStore } = await import("../../src/writes/postgres.js");
    const store = testStore();
    const writes = createPostgresWriteStore({ pool });

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2w-${randomUUID()}@example.com`);

    // Delete venceu: create posterior recusa 410, sem efeito.
    const doomed = await store.create({ authUserId: authUser, name: "Morto", kind: "shared" });
    const doomedInventory = await store.deletionInventory({ authUserId: authUser, householdId: doomed.id });
    await store.deleteEmpty({
      authUserId: authUser,
      householdId: doomed.id,
      confirmation: buildDeleteConfirmation({
        workspaceId: doomed.id,
        actor: authUser,
        inventoryVersion: doomedInventory.inventoryVersion,
        expiresAt: doomedInventory.expiresAt,
        agentAttestation: 'unverified',
        attestationId: await depositFor(store, doomed.id, doomedInventory.inventoryVersion),
      }),
    });
    await expect(
      writes.createAccount(doomed.id, { name: 'Tardia', kind: 'bank', initialBalanceCents: 0 }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });

    // Archive: create recusa 403, sem efeito; restore libera de novo.
    const frozen = await store.create({ authUserId: authUser, name: "Congelado", kind: "shared" });
    await store.setStatus({ authUserId: authUser, householdId: frozen.id, status: 'archived' });
    await expect(
      writes.createAccount(frozen.id, { name: 'Congelada', kind: 'bank', initialBalanceCents: 0 }),
    ).rejects.toMatchObject({ code: 'workspace.archived' });
    await store.setStatus({ authUserId: authUser, householdId: frozen.id, status: 'active' });
    const revived = await writes.createAccount(frozen.id, { name: 'Viva', kind: 'bank', initialBalanceCents: 0 });
    expect(revived.householdId).toBe(frozen.id);
  });

  itIfDatabase("FIX-WS-D2-R2 item 2: delete-vs-create concorrente — sem escrita em workspace morto", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const { createPostgresWriteStore } = await import("../../src/writes/postgres.js");
    const store = testStore();
    const writes = createPostgresWriteStore({ pool });

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2cc-${randomUUID()}@example.com`);
    const ws = await store.create({ authUserId: authUser, name: "Disputa", kind: "shared" });
    const inventory = await store.deletionInventory({ authUserId: authUser, householdId: ws.id });
    const confirmation = buildDeleteConfirmation({
      workspaceId: ws.id,
      actor: authUser,
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
      agentAttestation: 'unverified',
      attestationId: await depositFor(store, ws.id, inventory.inventoryVersion),
    });
    const results = await Promise.allSettled([
      store.deleteEmpty({ authUserId: authUser, householdId: ws.id, confirmation }),
      writes.createAccount(ws.id, { name: 'Corrida', kind: 'bank', initialBalanceCents: 0 }),
    ]);
    const deleteResult = results[0]!;
    const createResult = results[1]!;
    if (deleteResult.status === 'fulfilled') {
      // Delete venceu (lock primeiro): o create precisa ver o tombstone.
      expect(createResult.status).toBe('rejected');
      const reason = (createResult as PromiseRejectedResult).reason as { code?: string };
      expect(reason.code).toBe('workspace.deleted');
    } else {
      // Create venceu: a confirmação do delete ficou obsoleta (as
      // contagens vivas sob o lock divergem da versão vinculada) e o
      // delete recusa SEMPRE — nunca apaga a conta recém-criada.
      expect(createResult.status).toBe('fulfilled');
      const reason = (deleteResult as PromiseRejectedResult).reason as { code?: string };
      expect(['workspace.confirmation_invalid', 'workspace.not_empty']).toContain(reason.code);
      const accounts = await pool.query(`SELECT COUNT(*)::int AS c FROM accounts WHERE household_id = $1`, [ws.id]);
      expect(accounts.rows[0]?.['c']).toBeGreaterThan(0);
      const tombRow = await pool.query(`SELECT * FROM workspace_tombstones WHERE household_id = $1`, [ws.id]);
      expect(tombRow.rowCount).toBe(0);
    }
  });

  itIfDatabase("FIX-WS-D2-R2 item 3: restore-vs-delete concorrente em PG real", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const store = testStore();

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2rd-${randomUUID()}@example.com`);
    const ws = await store.create({ authUserId: authUser, name: "Ressuscitável", kind: "shared" });
    await store.setStatus({ authUserId: authUser, householdId: ws.id, status: 'archived' });
    const inventory = await store.deletionInventory({ authUserId: authUser, householdId: ws.id });
    const confirmation = buildDeleteConfirmation({
      workspaceId: ws.id,
      actor: authUser,
      inventoryVersion: inventory.inventoryVersion,
      expiresAt: inventory.expiresAt,
      agentAttestation: 'unverified',
      attestationId: await depositFor(store, ws.id, inventory.inventoryVersion),
    });
    const results = await Promise.allSettled([
      store.setStatus({ authUserId: authUser, householdId: ws.id, status: 'active' }),
      store.deleteEmpty({ authUserId: authUser, householdId: ws.id, confirmation }),
    ]);
    const restoreResult = results[0]!;
    const deleteResult = results[1]!;
    // O workspace estava vazio e a confirmação é válida: o delete sempre
    // conclui (serializado sob FOR UPDATE). O restore perde a corrida
    // (410 tombstone) ou vence antes e o delete sobrescreve depois —
    // o estado final é SEMPRE deleted com tombstone (nunca ressuscita).
    expect(deleteResult.status).toBe('fulfilled');
    if (restoreResult.status === 'rejected') {
      const reason = (restoreResult as PromiseRejectedResult).reason as { code?: string };
      expect(reason.code).toBe('workspace.deleted');
    }
    const final = await pool.query(`SELECT status FROM households WHERE id = $1`, [ws.id]);
    expect(final.rows[0]?.['status']).toBe('deleted');
    const tombRow = await pool.query(`SELECT * FROM workspace_tombstones WHERE household_id = $1`, [ws.id]);
    expect(tombRow.rowCount).toBe(1);
    // Tombstone é proibição autoritativa: restore posterior recusa.
    await expect(
      store.setStatus({ authUserId: authUser, householdId: ws.id, status: 'active' }),
    ).rejects.toMatchObject({ code: 'workspace.deleted' });
  });

  itIfDatabase("R4: sem segredo HMAC = indisponível (409 agent_unverified, sem efeito)", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const saved = process.env.WORKSPACE_DELETION_HMAC_SECRET;
    delete process.env.WORKSPACE_DELETION_HMAC_SECRET;
    try {
      const secretless = createPostgresWorkspaceStore(pool);
      const authUser = `auth-${randomUUID()}`;
      await seedUser(pool, authUser, `wsd2s-${randomUUID()}@example.com`);
      const ws = await secretless.create({ authUserId: authUser, name: "SemSegredo", kind: "shared" });
      // Inventário indisponível sem segredo (não emite versão forjável).
      await expect(
        secretless.deletionInventory({ authUserId: authUser, householdId: ws.id }),
      ).rejects.toMatchObject({ code: 'workspace.agent_unverified' });
      // Delete indisponível sem segredo (nunca conclui sem prova verificável).
      await expect(
        secretless.deleteEmpty({
          authUserId: authUser,
          householdId: ws.id,
          confirmation: buildDeleteConfirmation({
            workspaceId: ws.id,
            actor: authUser,
            inventoryVersion: 'f'.repeat(64),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            agentAttestation: 'unverified',
          }),
        }),
      ).rejects.toMatchObject({ code: 'workspace.agent_unverified' });
      // Sem efeito: workspace segue ativo e sem tombstone.
      const status = await pool.query(`SELECT status FROM households WHERE id = $1`, [ws.id]);
      expect(status.rows[0]?.['status']).toBe('active');
      const tombRow = await pool.query(`SELECT * FROM workspace_tombstones WHERE household_id = $1`, [ws.id]);
      expect(tombRow.rowCount).toBe(0);
    } finally {
      if (saved !== undefined) process.env.WORKSPACE_DELETION_HMAC_SECRET = saved;
    }
  });
});
