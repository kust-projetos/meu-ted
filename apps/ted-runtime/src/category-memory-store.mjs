import { DatabaseSync } from 'node:sqlite';
import { categoryMemoryFingerprint, normalizeMemoryValue, shouldReplaceMemory, isForgetTombstoneActive } from './category-memory-core.mjs';

export const CATEGORY_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROWS_PER_SCOPE = 200;
const identifier = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;

export function openCategoryMemoryStore({ dbPath, ttlMs = CATEGORY_MEMORY_TTL_MS } = {}) {
  if (!identifier(dbPath)) throw new TypeError('dbPath is required');
  const ttl = Math.min(CATEGORY_MEMORY_TTL_MS, Math.max(1000, Number(ttlMs) || CATEGORY_MEMORY_TTL_MS));
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS category_memory (
    workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    target TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, tombstone_at INTEGER,
    PRIMARY KEY (workspace_id, actor_id, fingerprint)
  ); CREATE INDEX IF NOT EXISTS category_memory_expiry_idx ON category_memory(expires_at);`);
  const select = db.prepare('SELECT * FROM category_memory WHERE workspace_id=? AND actor_id=? AND fingerprint=?');
  const validScope = ({ workspaceId, actorId, target, field }) => {
    if (![workspaceId, actorId, target, field].every(identifier)) throw new TypeError('workspace, actor, target and field are required');
    return categoryMemoryFingerprint({ workspaceId, actorId, target, field });
  };
  return {
    remember(input) {
      const fingerprint = validScope(input);
      const value = normalizeMemoryValue(input.value);
      if (!value) return false;
      const now = Date.now();
      const existing = select.get(input.workspaceId, input.actorId, fingerprint);
      if (isForgetTombstoneActive(existing, now)) return false;
      const incoming = { value, updatedAt: now, confidence: 1 };
      if (!shouldReplaceMemory(existing && { value: existing.value, updatedAt: existing.created_at, tombstoneAt: existing.tombstone_at, expiresAt: existing.expires_at }, incoming, now)) return false;
      db.prepare(`INSERT INTO category_memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(workspace_id,actor_id,fingerprint) DO UPDATE SET
        value=excluded.value, created_at=excluded.created_at, expires_at=excluded.expires_at, tombstone_at=NULL`)
        .run(input.workspaceId, input.actorId, fingerprint, input.target.trim(), input.field.trim(), value, now, now + ttl);
      const count = db.prepare('SELECT COUNT(*) AS n FROM category_memory WHERE workspace_id=? AND actor_id=?').get(input.workspaceId, input.actorId).n;
      if (count > MAX_ROWS_PER_SCOPE) db.prepare(`DELETE FROM category_memory WHERE rowid IN
        (SELECT rowid FROM category_memory WHERE workspace_id=? AND actor_id=? AND tombstone_at IS NULL ORDER BY created_at ASC LIMIT ?)`)
        .run(input.workspaceId, input.actorId, count - MAX_ROWS_PER_SCOPE);
      return true;
    },
    recall(input) {
      const fingerprint = validScope(input);
      const row = select.get(input.workspaceId, input.actorId, fingerprint) ??
        db.prepare(`SELECT * FROM category_memory
          WHERE workspace_id=? AND actor_id=? AND field=?`)
          .all(input.workspaceId, input.actorId, input.field.trim())
          .find((candidate) =>
            candidate.target.normalize('NFC').trim().toLocaleLowerCase() ===
            input.target.normalize('NFC').trim().toLocaleLowerCase());
      if (!row || row.tombstone_at != null || row.expires_at <= Date.now()) return null;
      return { field: row.field, value: row.value, updatedAt: row.created_at };
    },
    forget(input) {
      const fingerprint = validScope(input);
      const now = Date.now();
      db.prepare(`INSERT INTO category_memory VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)
        ON CONFLICT(workspace_id,actor_id,fingerprint) DO UPDATE SET tombstone_at=excluded.tombstone_at, expires_at=excluded.expires_at`)
        .run(input.workspaceId, input.actorId, fingerprint, input.target.trim(), input.field.trim(), now, now + ttl, now);
      return true;
    },
    sweepExpired(nowMs = Date.now()) {
      return Number(db.prepare('DELETE FROM category_memory WHERE expires_at <= ?').run(nowMs).changes);
    },
    countByWorkspace(workspaceId) {
      if (!identifier(workspaceId)) throw new TypeError('workspaceId is required');
      return Number(db.prepare('SELECT COUNT(*) AS n FROM category_memory WHERE workspace_id=? AND tombstone_at IS NULL AND expires_at>?')
        .get(workspaceId, Date.now()).n);
    },
    close() { db.close(); },
  };
}
