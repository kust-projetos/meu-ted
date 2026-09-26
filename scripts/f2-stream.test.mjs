import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

// RED: these helpers do not exist yet on the current implementation.
import {
  isGzipMagic,
  detectDumpEncodingSync,
  createDumpInputStream,
  hashStreamToDigest,
  pipeDumpToWritable,
  evaluateIdentityGate,
} from './rehearse-canonical-conversion.mjs';

const PII_SENTINEL = 'SENTINEL_PII_f2stream_9f8e7d6c_STREAM';

test('F2-stream gzip magic detection does not load the whole file', () => {
  assert.equal(isGzipMagic(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), true);
  assert.equal(isGzipMagic(Buffer.from('SELECT 1')), false);
  assert.equal(isGzipMagic(Buffer.alloc(0)), false);
});

test('F2-stream dump input streams plain and gzip without buffering whole dump', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f2-stream-'));
  try {
    const plainPath = join(dir, 'a.sql');
    const gzPath = join(dir, 'b.sql.gz');
    writeFileSync(plainPath, 'SELECT 1;\n');
    writeFileSync(gzPath, gzipSync(Buffer.from('SELECT 2;\n')));
    assert.equal(detectDumpEncodingSync(plainPath), 'plain');
    assert.equal(detectDumpEncodingSync(gzPath), 'gzip');
    const readAll = async (s) => {
      let out = '';
      for await (const chunk of s) out += chunk.toString('utf8');
      return out;
    };
    assert.equal(await readAll(createDumpInputStream(plainPath)), 'SELECT 1;\n');
    assert.equal(await readAll(createDumpInputStream(gzPath)), 'SELECT 2;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2-stream hash helper computes streaming sha256 with backpressure', async () => {
  const { createHash } = await import('node:crypto');
  const input = Readable.from(['hello ', 'world']);
  const got = await hashStreamToDigest(input);
  const want = createHash('sha256').update('hello world', 'utf8').digest('hex');
  assert.equal(got.sha256, want);
  assert.equal(got.bytes, Buffer.byteLength('hello world'));
});

test('F2-stream pipe failures propagate (source error rejects)', async () => {
  const boom = new Readable({
    read() {
      this.destroy(new Error('boom-source'));
    },
  });
  const sink = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  await assert.rejects(() => pipeDumpToWritable('n/a', sink, { inputStreamForTest: boom }), /boom-source/);
  await assert.rejects(() => hashStreamToDigest(boom), /boom-source/);
});

test('F2-stream pipe failures propagate (sink error rejects, no silent swallow)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f2-stream-'));
  try {
    const p = join(dir, 'c.sql');
    writeFileSync(p, 'SELECT 1;\n');
    const badSink = new Writable({
      write(_c, _e, cb) {
        cb(new Error('boom-sink'));
      },
    });
    await assert.rejects(() => pipeDumpToWritable(p, badSink), /boom-sink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F2-stream PII sentinel never reaches digest output or evidence', async () => {
  const input = Readable.from([`secret ${PII_SENTINEL} payload`]);
  const got = await hashStreamToDigest(input);
  assert.ok(!JSON.stringify(got).includes(PII_SENTINEL), 'digest output must not carry raw dump text');
  assert.match(got.sha256, /^[0-9a-f]{64}$/);
});

test('F2 identity gate carries no unkeyed hash or raw values (fields only)', () => {
  const l = [
    {
      check: 'card_purchase',
      kind: 'purchase_amount_mismatch',
      entity: 'card_purchases',
      entityId: 'aaaaaaaa-0000-4000-8000-000000000001',
      expected: `legacy-${PII_SENTINEL}`,
      actual: 1,
      detail: `d-${PII_SENTINEL}`,
    },
  ];
  const c = [
    {
      check: 'card_purchase',
      kind: 'purchase_amount_mismatch',
      entity: 'card_purchases',
      entityId: 'aaaaaaaa-0000-4000-8000-000000000001',
      expected: `canonical-${PII_SENTINEL}`,
      actual: 1,
      detail: `d2-${PII_SENTINEL}`,
    },
  ];
  const gate = evaluateIdentityGate(l, c);
  assert.equal(gate.pass, false);
  assert.equal(gate.changed.length, 1);
  const serialized = JSON.stringify(gate);
  assert.ok(!serialized.includes(PII_SENTINEL), 'no raw PII in gate');
  assert.ok(!serialized.includes('valueHash'), 'no valueHash in gate');
  assert.ok(!serialized.includes('Digest'), 'no digest in gate');
  assert.deepEqual(Object.keys(gate.changed[0]).sort(), ['fields', 'key']);
});

test('F2-stream source hygiene: no whole-dump buffering, no temp dump files, no unkeyed digest', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./rehearse-canonical-conversion.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /gunzipSync/, 'must stream gunzip, not gunzipSync whole dump');
  assert.doesNotMatch(src, /maxBuffer:\s*256/, 'must not buffer pg_dump with 256MB maxBuffer');
  assert.doesNotMatch(src, /loadRealDumpSql/, 'whole-dump string loader must be gone');
  assert.doesNotMatch(src, /valueDigestOf/, 'unkeyed valueDigestOf must be gone');
  assert.doesNotMatch(src, /valueHash/, 'valueHash diagnostics must be gone');
  assert.doesNotMatch(src, /writeFileSync\(dump/, 'must not persist dump bytes to a temp file');
});

test('F2-ownership validators reject injection and invalid port', async () => {
  const mod = await import('./rehearse-canonical-conversion.mjs');
  assert.equal(typeof mod.validateContainerName, 'function', 'validateContainerName must exist');
  assert.equal(typeof mod.validatePort, 'function', 'validatePort must exist');
  assert.equal(mod.validateContainerName('pi-finance-canonical-rehearsal'), 'pi-finance-canonical-rehearsal');
  for (const bad of ['', 'a; rm -rf /', 'x$(whoami)', 'x`id`', 'a b', 'a/b', ';docker rm', 'a&&b', 'a|b']) {
    assert.throws(() => mod.validateContainerName(bad), /container name/, `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(mod.validatePort('5436'), '5436');
  for (const bad of ['', 'abc', '5436; rm', '-1', '0', '99999', '12.5', '  ']) {
    assert.throws(() => mod.validatePort(bad), /port/i, `must reject port ${JSON.stringify(bad)}`);
  }
});

test('F2 docker-run failure is sanitized: fixed string + status only, sentinel never leaks', async () => {
  const mod = await import('./rehearse-canonical-conversion.mjs');
  assert.equal(typeof mod.dockerRunFailureMessage, 'function', 'dockerRunFailureMessage helper must exist');
  assert.equal(typeof mod.sanitizeErrorForLog, 'function', 'sanitizeErrorForLog helper must exist');
  const SENTINEL = 'SENTINEL_PW_f2stream_9f8e7d6c_SECRET';
  const msg = mod.dockerRunFailureMessage(125, 'pi-finance-canonical-rehearsal');
  const serialized = JSON.stringify(msg);
  assert.ok(!serialized.includes(SENTINEL), 'failure message must not carry the password sentinel');
  assert.match(msg, /status 125/, 'failure message must carry the numeric status only');
  assert.match(msg, /inspect/i, 'failure message must guide inspection of the possibly-created container');
  assert.match(msg, /verif.*ownership|ownership.*verif/i, 'failure message must require ownership verification');
  assert.doesNotMatch(msg, new RegExp(SENTINEL), 'no password value in the message');
  // Unexpected errors can echo arbitrary argv, including quoted or spaced secrets.
  for (const password of [SENTINEL, `${SENTINEL} with spaces`, `"${SENTINEL}"`]) {
    const redacted = mod.sanitizeErrorForLog(`docker run -e POSTGRES_PASSWORD=${password} failed`);
    assert.ok(!redacted.includes(password), 'sanitized log must not contain any portion of the password');
    assert.ok(!redacted.includes(SENTINEL), 'sanitized log must not contain the password sentinel');
    assert.match(redacted, /details withheld/, 'unexpected subprocess details must be withheld entirely');
  }
});

test('F2 docker-run failure never auto-removes by name and points at manual recovery', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./rehearse-canonical-conversion.mjs', import.meta.url), 'utf8');
  const mod = await import('./rehearse-canonical-conversion.mjs');
  const msg = mod.dockerRunFailureMessage(1, 'pi-finance-canonical-rehearsal');
  assert.doesNotMatch(msg, /rm\s+-f/, 'recovery guidance must not auto-remove by name');
  assert.match(msg, /nothing.*auto-removed|no.*auto-?remove|manual/i, 'guidance must state nothing was auto-removed');
  // The docker-run catch block must not interpolate the raw error text (which may carry the password argv).
  const runCatch = src.slice(src.indexOf('ownedContainerId = execFileSync('), src.indexOf('ownedContainerId = execFileSync(') + 1200);
  assert.doesNotMatch(runCatch, /\$\{err\.message/, 'docker-run catch must not interpolate err.message');
  assert.doesNotMatch(runCatch, /err\.message \?\?/, 'docker-run catch must not fall back to err.message');
  // Outer catch must sanitize instead of printing the raw message.
  assert.match(src, /sanitizeErrorForLog/, 'outer catch must sanitize the error text');
});

test('F2-ownership source hygiene: no shell-interpolated docker, no unconditional delete, cleanup only owned ID', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./rehearse-canonical-conversion.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /execSync\(`docker rm -f/, 'must not shell-interpolate docker rm -f');
  assert.doesNotMatch(src, /execSync\(`docker exec/, 'must not shell-interpolate docker exec');
  assert.match(src, /validateContainerName/, 'must validate the container name before any docker call');
  assert.match(src, /validatePort/, 'must validate the port before any docker call');
  assert.match(src, /ownedContainerId/, 'must track the self-created container ID for owned cleanup');
  assert.match(src, /docker.*inspect/, 'must check for a preexisting name before creating');
  assert.match(src, /already exists.*refus|refus.*preexisting|fail.*already exists/i, 'name conflict must fail closed without deleting');
});
