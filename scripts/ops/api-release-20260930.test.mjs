// api-release-20260930.test.mjs
// Behavioral tests for scripts/ops/api-release-20260930.sh using fake `docker`
// and fake `curl` shims inside a disposable bash container (no production
// contact, no real docker daemon state). Covers: dry-run purity, flag refusal,
// happy digest lane, curl-gate failure -> verified rollback, divergent
// rollback-tag refusal (no swap), same-SHA idempotent no-op, source-lane cwd
// + absolute Dockerfile. The release script itself is NEVER executed against
// production here. Requires docker (explicit skip otherwise — a skip is not
// proof). Run: node --test scripts/ops/api-release-20260930.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, 'api-release-20260930.sh');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHORT = SHA.slice(0, 7);
const CI_RUN = '19999999999';
const BACKUP_ID = 'test-backup-0930';
const BACKUP_CONTENT = 'fake-backup-bytes-for-release-test';
const BACKUP_SHA = createHash('sha256').update(BACKUP_CONTENT).digest('hex');
const PRE_ID = 'sha256:' + '1'.repeat(64);
const NEW_ID = 'sha256:' + '2'.repeat(64);
const OTHER_ID = 'sha256:' + '3'.repeat(64);
const DIGEST = `sha256:${'b'.repeat(64)}`;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_STATE/calls.log"
map_get() { grep -F -e "$1=" "$FAKE_STATE/images.map" 2>/dev/null | cut -d= -f2 | tail -1; }
op="$1"; shift
case "$op" in
  inspect)
    fmt=""; ref=""
    while [ $# -gt 0 ]; do case "$1" in --format) fmt="$2"; shift 2;; *) ref="$1"; shift;; esac; done
    case "$fmt" in
      *'.Image'*)
        if [ "$ref" = "pi-finance-api" ]; then cat "$FAKE_STATE/container.image"
        else id="$(map_get "$ref")"; [ -n "$id" ] && printf '%s' "$id" || exit 1; fi ;;
      *'.Id'*)
        id="$(map_get "$ref")"
        if [ -n "$id" ]; then printf '%s' "$id"
        elif [ "$ref" = "$(cat "$FAKE_STATE/container.image")" ]; then printf '%s' "$ref"
        else exit 1; fi ;;
      *'Health.Status'*) printf '%s' "\${FAKE_HEALTH:-healthy}" ;;
      *) printf 'fake' ;;
    esac ;;
  tag)
    src="$1"; dst="$2"; id="$(map_get "$src")"; [ -z "$id" ] && id="$src"
    printf '%s=%s\\n' "$dst" "$id" >> "$FAKE_STATE/images.map" ;;
  pull)
    if [ "\${FAKE_PULL_FAIL:-0}" = "1" ]; then echo "pull failed" >&2; exit 1; fi
    printf '%s=%s\\n' "$1" "\${FAKE_PULL_ID:-sha256:2222222222222222222222222222222222222222222222222222222222222222}" >> "$FAKE_STATE/images.map" ;;
  compose)
    has_up=0; for a in "$@"; do [ "$a" = "up" ] && has_up=1; done
    if [ "$has_up" != "1" ]; then echo "unexpected compose: $*" >&2; exit 1; fi
    cur="$(map_get pi-finance-api:main)"; printf '%s' "$cur" > "$FAKE_STATE/container.image" ;;
  build)
    pwd > "$FAKE_STATE/build.pwd"; printf '%s\\n' "$@" > "$FAKE_STATE/build.args"
    tg=""; prev=""
    for a in "$@"; do if [ "$prev" = "-t" ]; then tg="$a"; fi; prev="$a"; done
    [ -n "$tg" ] && printf '%s=%s\\n' "$tg" "\${FAKE_BUILD_ID:-sha256:2222222222222222222222222222222222222222222222222222222222222222}" >> "$FAKE_STATE/images.map" ;;
  *) echo "unexpected docker op: $op" >&2; exit 1 ;;
esac
`;

const FAKE_GIT = `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    HEAD) printf '%s' "\${FAKE_GIT_SHA:-}"; exit 0 ;;
  esac
done
if printf '%s\\n' "$@" | grep -q -F 'status'; then
  if [ "\${FAKE_GIT_DIRTY:-0}" = "1" ]; then echo " M dirty-fixture"; fi
  exit 0
fi
exit 99
`;

const FAKE_CURL = `#!/usr/bin/env bash
url="\${@: -1}"
case "$url" in
  */health)
    if [ "\${FAKE_CURL_FAIL:-0}" = "1" ]; then exit 22; fi
    printf '{"status":"ok","gitSha":"%s"}' "\${FAKE_HEALTH_SHA:-}" ;;
  */ready) exit "\${FAKE_READY_CODE:-0}" ;;
  *) exit 99 ;;
esac
`;

const ctx = {};
const dockerAvailable = () => {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
function winOnly() { return true; } // runs inside linux container; docker gate below.

test.before(() => {
  ctx.dir = mkdtempSync(join(tmpdir(), 'api-release-'));
  ctx.state = join(ctx.dir, 'w'); mkdirSync(ctx.state);
  ctx.bin = join(ctx.state, 'fakebin'); mkdirSync(ctx.bin);
  writeFileSync(join(ctx.bin, 'docker'), FAKE_DOCKER);
  writeFileSync(join(ctx.bin, 'curl'), FAKE_CURL);
  writeFileSync(join(ctx.bin, 'git'), FAKE_GIT);
  writeFileSync(join(ctx.state, `${BACKUP_ID}.dump`), BACKUP_CONTENT);
  writeFileSync(join(ctx.state, 'docker-compose.yml'),
    'services:\n  pi-finance-api:\n    image: pi-finance-api:main\n    environment:\n      - MIGRATIONS_MODE=disabled\n');
});
test.after(() => { rmSync(ctx.dir, { recursive: true, force: true }); });

function resetState(extraImages = '') {
  writeFileSync(join(ctx.state, 'images.map'), `pi-finance-api:main=${PRE_ID}\n${extraImages}`);
  writeFileSync(join(ctx.state, 'container.image'), PRE_ID);
  writeFileSync(join(ctx.state, 'calls.log'), '');
  for (const f of ['build.pwd', 'build.args']) rmSync(join(ctx.state, f), { force: true });
  for (const f of ['manifests']) rmSync(join(ctx.state, f), { recursive: true, force: true });
  mkdirSync(join(ctx.state, 'manifests'));
}
function runRelease(args, extraEnv = {}) {
  // Runs the release script inside a disposable bash container. `bash -c`
  // export line is NOT used: env passes via docker -e (no quoting risk).
  const envArgs = [];
  const baseEnv = {
    // Fixed linux PATH (never inherit the host PATH: on Windows hosts it
    // would inject C:\... entries and break tool lookup in the container).
    PATH: '/w/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    FAKE_STATE: '/w',
    FAKE_HEALTH_SHA: SHA,
    API_RELEASE_COMPOSE_FILE: '/w/docker-compose.yml',
    API_RELEASE_MANIFEST_DIR: '/w/manifests',
    API_RELEASE_BACKUP_DIR: '/w',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(baseEnv)) envArgs.push('-e', `${k}=${v}`);
  const dArgs = ['run', '--rm', '--entrypoint', '/usr/local/bin/bash',
    '-v', `${HERE}:/s:ro`, '-v', `${ctx.state}:/w`,
    ...envArgs, 'bash:5', '/s/api-release-20260930.sh',
    '--sha', SHA, '--ci-run', CI_RUN,
    '--backup-id', BACKUP_ID, '--backup-sha', BACKUP_SHA,
    ...args];
  try {
    const out = execFileSync('docker', dArgs, { encoding: 'utf8', timeout: 120000 });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}
const calls = () => readFileSync(join(ctx.state, 'calls.log'), 'utf8');
const gate = (t) => {
  if (!dockerAvailable()) { t.skip('requires docker (fake-daemon behavioral tests); skip is not proof'); return false; }
  return true;
};

test('dry-run prints plan and performs zero docker calls', (t) => {
  if (!gate(t)) return;
  resetState();
  const r = runRelease(['--digest', DIGEST]);
  assert.equal(r.exit, 0, r.out);
  assert.match(r.out, /dry-run=yes/);
  assert.equal(calls(), '', 'dry-run must not invoke docker at all');
});

test('bad flags are refused before anything', (t) => {
  if (!gate(t)) return;
  resetState();
  const r = runRelease(['--sha', 'xyz', '--digest', DIGEST]);
  assert.equal(r.exit, 3, r.out);
  assert.match(r.out, /REFUSED/);
});

test('happy digest lane releases with verified gates + manifest', (t) => {
  if (!gate(t)) return;
  resetState();
  const r = runRelease(['--digest', DIGEST, '--execute']);
  assert.equal(r.exit, 0, r.out);
  assert.match(r.out, /RELEASE OK/);
  const log = calls();
  assert.match(log, /compose .*up -d --no-deps --no-build pi-finance-api/);
  assert.ok(!log.includes('prune'), 'must never prune');
  const mf = JSON.parse(readFileSync(join(ctx.state, 'manifests', `release-manifest-${SHA}.json`), 'utf8'));
  assert.equal(mf.outcome, 'released');
  assert.equal(mf.sha, SHA);
  assert.equal(mf.new_image_id, NEW_ID);
});

test('curl gate failure rolls back to verified PRE_IMAGE (exit 4)', (t) => {
  if (!gate(t)) return;
  resetState();
  const r = runRelease(['--digest', DIGEST, '--execute'], { FAKE_HEALTH_SHA: 'f'.repeat(40) });
  assert.equal(r.exit, 4, r.out);
  assert.match(r.out, /ROLLED-BACK-VERIFIED/);
  const mf = JSON.parse(readFileSync(join(ctx.state, 'manifests', `release-manifest-${SHA}.json`), 'utf8'));
  assert.equal(mf.outcome, 'rolled-back-verified');
  assert.equal(readFileSync(join(ctx.state, 'container.image'), 'utf8'), PRE_ID);
});

test('divergent pre-existing rollback tag refuses with no swap', (t) => {
  if (!gate(t)) return;
  resetState(`pi-finance-api:rollback-pre-${SHORT}=${OTHER_ID}\n`);
  const r = runRelease(['--digest', DIGEST, '--execute']);
  assert.equal(r.exit, 3, r.out);
  assert.match(r.out, /divergent rollback tag/);
  const log = calls();
  assert.ok(!log.includes('compose up'), 'must not swap on refusal');
  assert.equal(readFileSync(join(ctx.state, 'container.image'), 'utf8'), PRE_ID);
});

test('same-SHA already deployed is an idempotent no-op', (t) => {
  if (!gate(t)) return;
  resetState(`pi-finance-api:main=${NEW_ID}\npi-finance-api:release-${SHORT}=${NEW_ID}\n`);
  writeFileSync(join(ctx.state, 'container.image'), NEW_ID);
  writeFileSync(join(ctx.state, 'manifests', `release-manifest-${SHA}.json`),
    JSON.stringify({ outcome: 'released', sha: SHA, new_image_id: NEW_ID }));
  const r = runRelease(['--digest', DIGEST, '--execute']);
  assert.equal(r.exit, 0, r.out);
  assert.match(r.out, /ALREADY-DEPLOYED/);
  const mutating = calls().split('\n').filter((l) => /^(tag|pull|compose|build) /.test(l));
  assert.deepEqual(mutating, [], 'no-op must not mutate (reads only)');
});

test('tag-main divergent but container matches manifest is still a no-op (alias-proof)', (t) => {
  if (!gate(t)) return;
  // Real shape: liveness comes from the CONTAINER image, never the :main
  // alias. Here someone repointed :main elsewhere AFTER a good release; the
  // running container still matches the manifest => no-op, no mutations.
  resetState(`pi-finance-api:main=${OTHER_ID}\npi-finance-api:release-${SHORT}=${NEW_ID}\n`);
  writeFileSync(join(ctx.state, 'container.image'), NEW_ID);
  writeFileSync(join(ctx.state, 'manifests', `release-manifest-${SHA}.json`),
    JSON.stringify({ outcome: 'released', sha: SHA, new_image_id: NEW_ID }));
  const r = runRelease(['--digest', DIGEST, '--execute']);
  assert.equal(r.exit, 0, r.out);
  assert.match(r.out, /ALREADY-DEPLOYED/);
  const mutating = calls().split('\n').filter((l) => /^(tag|pull|compose|build) /.test(l));
  assert.deepEqual(mutating, [], 'alias games must not cause mutations');
  assert.equal(readFileSync(join(ctx.state, 'container.image'), 'utf8'), NEW_ID);
});

test('source lane builds in the source dir with absolute Dockerfile', (t) => {
  if (!gate(t)) return;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
  catch { t.skip('requires host git for pristine checkout fixture'); return; }
  resetState();
  const src = join(ctx.state, 'src');
  mkdirSync(join(src, 'apps', 'api'), { recursive: true });
  writeFileSync(join(src, 'apps', 'api', 'Dockerfile'), 'FROM scratch\n');
  execFileSync('git', ['init', '-q', src]);
  execFileSync('git', ['-C', src, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', src, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', src, 'add', '.']);
  execFileSync('git', ['-C', src, 'commit', '-qm', 'x']);
  const head = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // NOTE: this scenario uses its own SHA (= fixture HEAD), not the file-level SHA.
  const dArgs = ['run', '--rm', '--entrypoint', '/usr/local/bin/bash',
    '-v', `${HERE}:/s:ro`, '-v', `${ctx.state}:/w`,
    '-e', 'PATH=/w/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '-e', 'FAKE_STATE=/w', '-e', `FAKE_HEALTH_SHA=${head}`, '-e', `FAKE_GIT_SHA=${head}`,
    '-e', 'API_RELEASE_COMPOSE_FILE=/w/docker-compose.yml',
    '-e', 'API_RELEASE_MANIFEST_DIR=/w/manifests',
    '-e', 'API_RELEASE_BACKUP_DIR=/w',
    'bash:5', '/s/api-release-20260930.sh',
    '--sha', head, '--ci-run', CI_RUN,
    '--backup-id', BACKUP_ID, '--backup-sha', BACKUP_SHA,
    '--source-dir', '/w/src', '--execute'];
  let out, exit;
  try {
    out = execFileSync('docker', dArgs, { encoding: 'utf8', timeout: 120000 });
    exit = 0;
  } catch (e) { exit = e.status ?? 1; out = String(e.stdout ?? '') + String(e.stderr ?? ''); }
  assert.equal(exit, 0, out);
  // Build ran with cwd == source dir (subshell cd) and absolute -f path.
  assert.equal(readFileSync(join(ctx.state, 'build.pwd'), 'utf8').trim(), '/w/src');
  const bargs = readFileSync(join(ctx.state, 'build.args'), 'utf8').split('\n');
  assert.equal(bargs[bargs.indexOf('-f') + 1], '/w/src/apps/api/Dockerfile');
});
