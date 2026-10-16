/**
 * Snapshot store — v2 canonical offline snapshot.
 *
 * v2 (IndexedDB) is the single source of truth for offline reads/writes:
 * - SHA-256 token fingerprint (the raw token is NEVER stored in IndexedDB)
 * - Schema version 2
 *
 * v1 (localStorage) is ONLY a migration input consumed inside snapshot-db
 * during `migrateV1toV2` before bootstrap; it is deleted after a successful
 * v2 write+reread. No production code reads or writes v1 at runtime — the
 * legacy `saveDomain`/`loadDomain` helpers were removed so there is no
 * runtime v1 fallback path.
 */
import type {
  Account, Category, Transaction, Payable,
  Budget, Goal, Subscription, CardStatement,
} from "./types";
import {
  writeV2Snapshot, readV2Snapshot, migrateV1toV2 as migrateV1toV2Impl,
  writeV3Snapshot, readV3Snapshot,
  migrateV2toV3 as migrateV2toV3Impl, type V2ToV3MigrationOptions,
  type WriteV2SnapshotOptions,
} from "./snapshot-db";

export type DomainKey =
  | "accounts" | "categories" | "transactions" | "payables"
  | "budgets" | "goals" | "subscriptions" | "cardStatements";

export interface SnapshotDomains {
  accounts: Account[]; categories: Category[]; transactions: Transaction[];
  payables: Payable[]; budgets: Budget[]; goals: Goal[];
  subscriptions: Subscription[]; cardStatements: CardStatement[];
}

// ── v2 canonical API ───────────────────────────────────────────────

/** Save one domain to the v2 (IndexedDB) snapshot. Only a SHA-256 fingerprint of the token is stored. */
export async function saveSnapshotDomain<K extends DomainKey>(
  token: string, domain: K, data: SnapshotDomains[K], opts?: WriteV2SnapshotOptions,
): Promise<void> {
  await writeV2Snapshot(token, domain, data, opts);
}

/** Read one domain from the v2 snapshot. Returns null on owner mismatch, corrupt, or missing. */
export async function loadSnapshotDomain<K extends DomainKey>(
  token: string, domain: K,
): Promise<{ data: SnapshotDomains[K]; syncedAt: string } | null> {
  return readV2Snapshot(token, domain);
}

/** Migrate v1 localStorage → v2 IndexedDB before bootstrap. Idempotent; v1 deleted only after v2 write+reread. */
export async function migrateV1toV2(token: string): Promise<void> {
  await migrateV1toV2Impl(token);
}

// ── v3 identity-keyed API (V4.1 Closure Phase 3, AUTH-02/AUTH-03) ────
// Owner args are the validated offline identity (principal + workspace),
// never a bearer/token. Cookie-only boots write here freely: ownership is
// provable without any storage credential.

/** Save one domain to the v3 (IndexedDB) snapshot. Throws on invalid owner. */
export async function saveV3SnapshotDomain<K extends DomainKey>(
  principalId: string, workspaceId: string, domain: K, data: SnapshotDomains[K],
): Promise<void> {
  await writeV3Snapshot(principalId, workspaceId, domain, data);
}

/** Read one domain from the v3 snapshot. Null on owner mismatch, untrusted, expired, or missing. */
export async function loadV3SnapshotDomain<K extends DomainKey>(
  principalId: string, workspaceId: string, domain: K,
): Promise<{ data: SnapshotDomains[K]; syncedAt: string } | null> {
  return readV3Snapshot(principalId, workspaceId, domain);
}

/**
 * Migrate a V2 envelope into V3. Call ONLY after the session was validated
 * online with a known current owner; otherwise the V2 is left for its
 * rightful owner or invalidated (legacy) — never heuristically assigned.
 */
export async function migrateV2toV3Snapshot(options: V2ToV3MigrationOptions) {
  return migrateV2toV3Impl(options);
}
