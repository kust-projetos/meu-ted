import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REHEARSE = readFileSync(resolve(HERE, 'rehearse-canonical-conversion.mjs'), 'utf8');
const ANON = readFileSync(resolve(HERE, 'anonymize-pg-copy.sql'), 'utf8');

test('F2-1 rehearsal exposes the host port on loopback only (no broad trust)', () => {
  // Host port must bind to loopback explicitly.
  assert.match(REHEARSE, /127\.0\.0\.1:\$\{PORT\}:5432/, 'docker run must publish -p 127.0.0.1:${PORT}:5432');
  // Broad network trust must be gone.
  assert.doesNotMatch(REHEARSE, /0\.0\.0\.0\/0\s+trust/, 'must not set trust for 0.0.0.0/0');
  assert.doesNotMatch(REHEARSE, /0\.0\.0\.0\/0/, 'must not reference a broad 0.0.0.0/0 host line at all');
});

test('F2-1 rehearsal uses password auth via PGPASSWORD env with passwordless URL (no secret in URL/logs)', () => {
  // Host URLs must be passwordless (public-safety url-embedded-credentials):
  // node-postgres resolves the SCRAM password from PGPASSWORD when the
  // connection string carries none, so auth stays password-based.
  assert.match(REHEARSE, /DATABASE_URL.*postgresql:\/\/postgres@127\.0\.0\.1/, 'host DATABASE_URL must be passwordless');
  assert.doesNotMatch(
    REHEARSE,
    /DATABASE_URL[\s\S]{0,200}encodeURIComponent\(DB_PASSWORD\)/,
    'DATABASE_URL must not embed DB_PASSWORD',
  );
  // The secret reaches the child only via PGPASSWORD in the env block.
  assert.match(REHEARSE, /PGPASSWORD\s*:\s*DB_PASSWORD/, 'child env must carry PGPASSWORD from DB_PASSWORD');
  // The secret value must never flow through the logging shell helper.
  assert.doesNotMatch(
    REHEARSE,
    /sh\(`docker run[^`]*POSTGRES_PASSWORD=\$\{/,
    'docker run carrying POSTGRES_PASSWORD must not go through logging sh()',
  );
});

test('F2-2 anonymization scrubs client-controlled idempotency keys deterministically', () => {
  // Both converter-imported tables must be remapped (equality/uniqueness preserving hash, not NULL/clear).
  assert.match(ANON, /UPDATE\s+public\.idempotency_keys\s+SET\s+["']?key["']?\s*=/i, 'must remap idempotency_keys.key');
  assert.match(
    ANON,
    /UPDATE\s+public\.operation_records\s+SET\s+idempotency_key\s*=/i,
    'must remap operation_records.idempotency_key',
  );
  // Related occurrence: pending_operations.idempotency_key shares the same client-controlled domain.
  assert.match(ANON, /pending_operations[\s\S]{0,800}idempotency_key/i, 'must also cover pending_operations.idempotency_key');
  // Deterministic equality-preserving mapping: same hash function + same anon prefix on both tables.
  const idemUpdates = [...ANON.matchAll(/UPDATE\s+public\.(idempotency_keys|operation_records|pending_operations)[\s\S]{0,400}?anon-idem-/gi)];
  assert.ok(idemUpdates.length >= 3, `expected anon-idem- mapping on 3 tables, found ${idemUpdates.length}`);
  assert.match(ANON, /digest\(|sha256\(|encode\(/i, 'mapping must use a deterministic hash (digest/sha256), preserving equality+uniqueness');
});

test('F2-4 idempotency mapping uses a per-scrub random session-local salt (not reversible unkeyed hash)', () => {
  // Keyed HMAC-SHA256 with a fresh random salt held only in TEMP/transaction-local state.
  assert.match(ANON, /hmac\s*\(/i, 'must use keyed hmac() for idempotency keys');
  assert.match(ANON, /gen_random_bytes\s*\(|gen_random_uuid\s*\(/i, 'must generate a fresh random salt per scrub');
  assert.match(ANON, /TEMP(?:ORARY)?\s+TABLE|SET\s+LOCAL|pg_temp/i, 'salt must live only in TEMP/session-local state');
  assert.match(ANON, /ON\s+COMMIT\s+DROP/i, 'TEMP salt must not survive COMMIT into the dump');
  // Unkeyed SHA256 of the raw key must be gone (dictionary-reversible for low-entropy keys).
  assert.doesNotMatch(
    ANON,
    /digest\s*\(\s*("key"|idempotency_key)\s*,\s*['"]sha256['"]/i,
    'must not use unkeyed digest() on raw idempotency keys',
  );
});

test('F2-5 idempotency mapping shares one salt across all three tables and cannot be bypassed by prefixed raw keys', () => {
  // Single per-scrub mapping: the shared salt object must feed every table's remap.
  const saltRefs = ANON.match(/_anon_idem_salt/g) || [];
  assert.ok(saltRefs.length >= 3, `expected shared salt referenced for 3 tables, found ${saltRefs.length}`);
  // Rerun logic must NOT hide already-prefixed malicious raw keys: every UPDATE remaps every row.
  const idemUpdates = [
    ...ANON.matchAll(/UPDATE\s+public\.(idempotency_keys|operation_records|pending_operations)[\s\S]{0,600}?;/gi),
  ];
  assert.ok(idemUpdates.length >= 3, `expected 3 idempotency UPDATEs, found ${idemUpdates.length}`);
  for (const m of idemUpdates) {
    assert.doesNotMatch(
      m[0],
      /NOT\s+LIKE\s*['"]anon-idem-/i,
      `UPDATE must not skip already-prefixed raw keys (attacker bypass): ${m[0].slice(0, 80)}...`,
    );
  }
  // The per-export secret must never be logged or persisted into a permanent table.
  assert.doesNotMatch(ANON, /RAISE\s+NOTICE[^;]*salt/i, 'salt must never be logged');
  assert.doesNotMatch(ANON, /INSERT\s+INTO\s+public\.[^;]*salt/i, 'salt must never be persisted into a permanent table');
});

test('F2-3 residual-PII checks fail closed BEFORE commit/export', () => {
  const commitIdx = ANON.indexOf('COMMIT;');
  assert.ok(commitIdx > 0, 'SQL must contain COMMIT;');
  const preCommit = ANON.slice(0, commitIdx);
  // A pre-commit gate must raise (abort the txn) on residual violations — NOTICE/SELECT-only is not enough.
  assert.match(preCommit, /residual/i, 'pre-commit section must contain the residual gate');
  assert.match(preCommit, /RAISE EXCEPTION[\s\S]{0,400}residual|residual[\s\S]{0,800}RAISE EXCEPTION/i, 'residual gate must RAISE EXCEPTION before COMMIT');
  // The gate must cover the anonymized idempotency keys (fail closed on unscrubbed keys).
  assert.match(preCommit, /anon-idem-/i, 'pre-commit residual gate must verify idempotency keys were scrubbed');
});
