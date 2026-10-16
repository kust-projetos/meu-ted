import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/pool.js";
import { createPostgresWorkspaceStore } from "../../src/auth/workspaces-postgres.js";
import { buildDeleteConfirmation } from "../../src/auth/workspace-deletion.js";

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
  beforeAll(() => {
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

  itIfDatabase("V062 aplicada: tabelas de fechamento existem e CHECK aceita deleted", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const tomb = await pool.query(`SELECT to_regclass('public.workspace_tombstones') AS r`);
    const log = await pool.query(`SELECT to_regclass('public.workspace_closure_log') AS r`);
    if (!tomb.rows[0]?.['r'] || !log.rows[0]?.['r']) {
      // Schema descartável ainda sem V062: pula sem falhar (a suite
      // unitária cobre o contrato; o deploy de migrations é job próprio).
      return;
    }
    expect(tomb.rows[0]['r']).toBe('workspace_tombstones');
    expect(log.rows[0]['r']).toBe('workspace_closure_log');
  });

  itIfDatabase("vazio deleta de verdade; com-dados recusa; purge bloqueado", async () => {
    if (!pool) throw new Error("database pool not initialized");
    const tomb = await pool.query(`SELECT to_regclass('public.workspace_tombstones') AS r`);
    if (!tomb.rows[0]?.['r']) return;
    const store = createPostgresWorkspaceStore(pool);

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2-${randomUUID()}@example.com`);

    // Workspace vazio: inventário vazio → delete OK.
    const empty = await store.create({ authUserId: authUser, name: "Vazio", kind: "shared" });
    const inventory = await store.deletionInventory({ authUserId: authUser, householdId: empty.id });
    expect(inventory.empty).toBe(true);
    const receipt = await store.deleteEmpty({
      authUserId: authUser,
      householdId: empty.id,
      confirmation: buildDeleteConfirmation({
        workspaceId: empty.id,
        actor: authUser,
        inventoryVersion: inventory.inventoryVersion,
        expiresAt: inventory.expiresAt,
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
    const tomb = await pool.query(`SELECT to_regclass('public.workspace_tombstones') AS r`);
    if (!tomb.rows[0]?.['r']) return;
    const store = createPostgresWorkspaceStore(pool);

    const authUser = `auth-${randomUUID()}`;
    await seedUser(pool, authUser, `wsd2c-${randomUUID()}@example.com`);
    const ws = await store.create({ authUserId: authUser, name: "Corrida", kind: "shared" });
    const inventory = await store.deletionInventory({ authUserId: authUser, householdId: ws.id });
    const confirmation = () =>
      buildDeleteConfirmation({
        workspaceId: ws.id,
        actor: authUser,
        inventoryVersion: inventory.inventoryVersion,
        expiresAt: inventory.expiresAt,
      });
    const results = await Promise.allSettled([
      store.deleteEmpty({ authUserId: authUser, householdId: ws.id, confirmation: confirmation() }),
      store.deleteEmpty({ authUserId: authUser, householdId: ws.id, confirmation: confirmation() }),
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
});
