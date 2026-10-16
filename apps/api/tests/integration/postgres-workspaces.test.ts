import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/pool.js";
import { createPostgresWorkspaceStore } from "../../src/auth/workspaces-postgres.js";
import { WorkspaceError } from "../../src/auth/workspaces-http.js";

const DB_URL = process.env.DATABASE_URL_TEST;
const ENABLED = Boolean(DB_URL && process.env.DB_TEST_MARKER);
const itIfDatabase = ENABLED ? it : it.skip;
let pool: Pool | undefined;

describe("Postgres workspace store integration", () => {
  beforeAll(() => {
    if (DB_URL) pool = createPool({ connectionString: DB_URL, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  const seedUser = async (client: Pool, authUserId: string, email: string, name = "Integration User") => {
    // users.auth_user_id REFERENCES "user"(id): the Better Auth native row
    // must exist first (postgres-access-revocation.test.ts pattern).
    await client.query(
      `INSERT INTO "user" (id, name, email, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [authUserId, name, email],
    );
    const result = await client.query<{ id: string }>(
      `INSERT INTO users (auth_user_id, email, name, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [authUserId, email, name],
    );
    return result.rows[0]!.id;
  };

  itIfDatabase(
    "lists, creates shared and personal workspaces, manages members and leave",
    async () => {
      if (!pool) throw new Error("database pool not initialized");
      const store = createPostgresWorkspaceStore(pool);

      const authUser = `auth-${randomUUID()}`;
      const userEmail = `ws-${randomUUID()}@example.com`;
      const userId = await seedUser(pool, authUser, userEmail);

      // Empty list
      const empty = await store.list(authUser);
      expect(empty).toEqual([]);

      // Create shared workspace
      const shared = await store.create({ authUserId: authUser, name: "Casa", kind: "shared" });
      expect(shared.kind).toBe("shared");
      expect(shared.role).toBe("owner");

      // Create personal workspace (owner membership via V021 trigger)
      const personal = await store.create({ authUserId: authUser, name: "Só eu", kind: "personal" });
      expect(personal.kind).toBe("personal");

      // D1 (ADR-027): a second personal workspace for the same user is allowed.
      const personal2 = await store.create({ authUserId: authUser, name: "Só eu 2", kind: "personal" });
      expect(personal2.kind).toBe("personal");
      expect(personal2.id).not.toBe(personal.id);

      // List returns all three (D1 order: active personals oldest-first, then shared)
      const list = await store.list(authUser);
      expect(list.map((w) => w.id).sort()).toEqual([shared.id, personal.id, personal2.id].sort());
      expect(list.find((w) => w.id === personal.id)!.role).toBe("owner");
      expect(list.findIndex((w) => w.id === personal.id)).toBeLessThan(
        list.findIndex((w) => w.id === shared.id),
      );

      // Members includes owner (listMembers.userId is the Better Auth id —
      // removeMember accepts both forms, see workspaces-postgres.ts).
      const members = await store.listMembers({ authUserId: authUser, householdId: shared.id });
      expect(members.some((m) => m.userId === authUser && m.role === "owner")).toBe(true);

      // Add a second member via SQL, then owner can remove
      const member2Auth = `auth-${randomUUID()}`;
      const member2Id = await seedUser(pool, member2Auth, `ws-${randomUUID()}@example.com`);
      await pool.query(
        `INSERT INTO memberships (household_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active')`,
        [shared.id, member2Id],
      );

      await store.removeMember({ authUserId: authUser, householdId: shared.id, memberUserId: member2Id });
      const afterRemove = await store.listMembers({ authUserId: authUser, householdId: shared.id });
      expect(afterRemove.some((m) => m.userId === member2Id)).toBe(false);

      // Member cannot remove others (removeMember soft-removes with
      // status='removed', so reactivate via upsert instead of INSERT).
      await pool.query(
        `INSERT INTO memberships (household_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active')
         ON CONFLICT (user_id, household_id) DO UPDATE SET role = 'member', status = 'active'`,
        [shared.id, member2Id],
      );
      await expect(
        store.removeMember({ authUserId: member2Auth, householdId: shared.id, memberUserId: userId }),
      ).rejects.toThrow(WorkspaceError);

      // Owner cannot leave last-owner shared workspace
      await pool.query(
        `DELETE FROM memberships WHERE household_id = $1 AND user_id = $2`,
        [shared.id, member2Id],
      );
      await expect(
        store.leave({ authUserId: authUser, householdId: shared.id }),
      ).rejects.toThrow(WorkspaceError);

      // Personal owner cannot leave personal workspace
      await expect(
        store.leave({ authUserId: authUser, householdId: personal.id }),
      ).rejects.toThrow(WorkspaceError);

      // Cleanup
      await pool.query(`DELETE FROM households WHERE id = ANY($1::uuid[])`, [[shared.id, personal.id, personal2.id]]);
      await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userId, member2Id]]);
      await pool.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[authUser, member2Auth]]);
    },
  );
});