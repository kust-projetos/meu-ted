#!/usr/bin/env bash
# api-release-20260930.sh — versionable API release wrapper (Hostinger VPS).
# CANONICAL-ONLY release for pi-finance-api. NEVER touches the database
# (migrations stay disabled by image+compose contract), other VPS apps, legacy
# DB, .env, networks, or compose content. Secrets are never printed: state
# capture uses selective inspect fields (image id, health status) and env
# NAMES are never even listed (no `docker inspect` full-env anywhere).
#
# Runs ON the VPS as user `deploy` from /home/deploy/infra/pi-finance-api/.
# DEFAULT IS DRY-RUN (prints the plan). Mutations require --execute plus all
# evidence flags. New SHA arrives next dispatch AFTER CI is green; the Planner
# attests CI green + provenance digest (this script never deploys by itself).
#
# Usage:
#   ./api-release-20260930.sh --sha <40hex> --ci-run <id> \
#       --backup-id <id> --backup-sha <64hex> \
#       { --digest <sha256:hex> | --source-dir <pristine-checkout> } \
#       [--execute]
#
# Lanes: (a) GHCR digest (preferred): docker pull by the immutable digest
# recorded in the CI api-image-provenance artifact; (b) source fallback:
# docker build from a pristine checkout at the exact SHA with the same
# Dockerfile + build args as CI (permitted when GHCR pull is unavailable).
#
# Exit codes: 0 ok / idempotent no-op; 2 usage; 3 refused (pre-mutation);
# 4 post-failure with VERIFIED rollback; 5 post-failure with FAILED rollback.
#
# Test hooks (env overrides; production defaults apply when unset):
#   API_RELEASE_COMPOSE_FILE, API_RELEASE_MANIFEST_DIR, API_RELEASE_BACKUP_DIR.
set -euo pipefail

COMPOSE_FILE="${API_RELEASE_COMPOSE_FILE:-/home/deploy/infra/pi-finance-api/docker-compose.yml}"
MANIFEST_DIR="${API_RELEASE_MANIFEST_DIR:-/home/deploy/infra/pi-finance-api}"
BACKUP_DIR="${API_RELEASE_BACKUP_DIR:-/home/deploy/infra/backup}"
SERVICE="pi-finance-api"
IMAGE="pi-finance-api:main"
API_ORIGIN="https://api.synkroo.com.br"
GHCR_IMAGE="ghcr.io/kust-projetos/meu-ted-api"
CURL_MAX="--max-time 15"

SHA=""; CI_RUN=""; BACKUP_ID=""; BACKUP_SHA=""; DIGEST=""; SOURCE_DIR=""; EXECUTE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA="$2"; shift 2 ;;
    --ci-run) CI_RUN="$2"; shift 2 ;;
    --backup-id) BACKUP_ID="$2"; shift 2 ;;
    --backup-sha) BACKUP_SHA="$2"; shift 2 ;;
    --digest) DIGEST="$2"; shift 2 ;;
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "REFUSED: $*" >&2; exit 3; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "--sha must be 40 hex (new SHA pending next dispatch)"
[[ "$CI_RUN" =~ ^[0-9]+$ ]] || fail "--ci-run (green CI run id, Planner-attested) required"
[[ "$BACKUP_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || fail "--backup-sha must be 64 hex"
[ -n "$BACKUP_ID" ] || fail "--backup-id required"
if [ -z "$DIGEST" ] && [ -z "$SOURCE_DIR" ]; then fail "one lane required: --digest or --source-dir"; fi
if [ -n "$DIGEST" ] && [ -n "$SOURCE_DIR" ]; then fail "lanes are exclusive: --digest XOR --source-dir"; fi
if [ -n "$DIGEST" ]; then [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "--digest must be sha256:<64hex>"; fi

SHORT="${SHA:0:7}"
MANIFEST="$MANIFEST_DIR/release-manifest-${SHA}.json"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== api-release plan (dry-run=$([ $EXECUTE -eq 1 ] && echo no || echo yes)) =="
echo "sha=$SHA ci_run=$CI_RUN backup=$BACKUP_ID lane=$([ -n "$DIGEST" ] && echo "ghcr-digest $DIGEST" || echo "source-build $SOURCE_DIR")"
[ $EXECUTE -eq 0 ] && { echo "DRY-RUN: no mutations performed."; exit 0; }

# 0. Duplicate guard (read-only; before ANY mutation). A manifest for this SHA
#    with outcome=released + live CONTAINER image match => idempotent no-op.
#    NOTE: liveness comes from the container's .Image (what is RUNNING), never
#    from the :main tag (an alias anyone can repoint). Docker image IDs are
#    full sha256:64 digests (never 40-hex); the manifest match is exact.
#    Any other existing manifest => refuse (fresh attempts need human cleanup).
if [ -f "$MANIFEST" ]; then
  OUTCOME="$(grep -o '"outcome":"[a-z-]*"' "$MANIFEST" 2>/dev/null | cut -d'"' -f4 || true)"
  REC_ID="$(grep -o '"new_image_id":"sha256:[0-9a-f]\{64\}"' "$MANIFEST" 2>/dev/null | cut -d'"' -f4 || true)"
  LIVE_ID="$(docker inspect "$SERVICE" --format '{{.Image}}' 2>/dev/null || true)"
  if [ "$OUTCOME" = "released" ] && [ -n "$REC_ID" ] && [ "$LIVE_ID" = "$REC_ID" ]; then
    echo "ALREADY-DEPLOYED sha=$SHA (manifest + running container agree, no change)."
    exit 0
  fi
  fail "duplicate execute: manifest $MANIFEST exists (outcome=${OUTCOME:-unknown}); human cleanup required before any retry"
fi

# Bounded HTTP fetch with explicit failure (never aborts silently under pipefail).
curl_get() { curl -fsS $CURL_MAX "$1" 2>/dev/null; }
extract_sha() { printf '%s' "$1" | grep -o '"gitSha":"[0-9a-f]*"' | cut -d'"' -f4; }

# 1. Fresh backup evidence (sha256 of the server-side dump must match).
if ! echo "$BACKUP_SHA  $BACKUP_DIR/$BACKUP_ID.dump" | sha256sum -c -; then
  fail "backup $BACKUP_ID sha mismatch (take a fresh backup first)"
fi

# 2. Pre-state capture (sanitized: ids/status only) + known-good pre-gates.
PRE_IMAGE="$(docker inspect "$SERVICE" --format '{{.Image}}')" || fail "cannot inspect $SERVICE image"
if ! PRE_HEALTH_JSON="$(curl_get "$API_ORIGIN/health")"; then
  fail "pre-flight /health unreachable (deploying onto unknown state refused)"
fi
if ! PRE_SHA="$(extract_sha "$PRE_HEALTH_JSON")" || [ -z "$PRE_SHA" ]; then
  fail "pre-flight /health has no gitSha (deploying onto unknown state refused)"
fi
if ! curl_get "$API_ORIGIN/ready" >/dev/null; then
  fail "pre-flight /ready failed (deploying onto unknown state refused)"
fi
if [ "$(docker inspect "$SERVICE" --format '{{.State.Health.Status}}')" != "healthy" ]; then
  fail "container not healthy pre-release (manual decision required)"
fi
grep -q 'MIGRATIONS_MODE=disabled' "$COMPOSE_FILE" \
  || fail "compose does not pin MIGRATIONS_MODE=disabled (schema must stay V058)"

# 3. Rollback tag FROM the live image id (never from the :main alias).
RTAG="pi-finance-api:rollback-pre-${SHORT}"
if EXIST_ID="$(docker inspect "$RTAG" --format '{{.Id}}' 2>/dev/null)"; then
  [ "$EXIST_ID" = "$PRE_IMAGE" ] \
    || fail "divergent rollback tag $RTAG ($EXIST_ID != live $PRE_IMAGE): never overwrite"
  echo "rollback tag already points at live image (kept, not rewritten)"
else
  docker tag "$PRE_IMAGE" "$RTAG" || fail "cannot create rollback tag"
  echo "rollback tag ready: $RTAG (live image $PRE_IMAGE)"
fi

# Rollback with VERIFICATION: running old PRE_IMAGE id + health + ready.
# Sets ROLLBACK_STATUS=verified|failed. Never claims success blindly.
do_rollback() {
  ROLLBACK_STATUS="failed"
  docker tag "$RTAG" "$IMAGE" || return 0
  docker compose -f "$COMPOSE_FILE" up -d --no-deps --no-build "$SERVICE" || return 0
  for _ in $(seq 1 12); do
    ST="$(docker inspect "$SERVICE" --format '{{.State.Health.Status}}' 2>/dev/null || true)"
    [ "$ST" = "healthy" ] && break
    sleep 10
  done
  RUN_ID="$(docker inspect "$SERVICE" --format '{{.Image}}' 2>/dev/null || true)"
  [ "$RUN_ID" = "$PRE_IMAGE" ] || return 0
  [ "$ST" = "healthy" ] || return 0
  if ! RB_JSON="$(curl_get "$API_ORIGIN/health")"; then return 0; fi
  if ! RB_SHA="$(extract_sha "$RB_JSON")" || [ "$RB_SHA" != "$PRE_SHA" ]; then return 0; fi
  if ! curl_get "$API_ORIGIN/ready" >/dev/null; then return 0; fi
  ROLLBACK_STATUS="verified"
  return 0
}
write_manifest() { # $1 = outcome
  cat > "$MANIFEST" <<EOF
{"release":"api","sha":"$SHA","short":"$SHORT","ci_run":"$CI_RUN",
"lane":"$([ -n "$DIGEST" ] && echo "ghcr-digest" || echo "source-build")",
"digest":"$DIGEST","backup_id":"$BACKUP_ID","backup_sha":"$BACKUP_SHA",
"pre_image":"$PRE_IMAGE","pre_health_sha":"$PRE_SHA","new_image_id":"${NEW_ID:-}",
"rollback_tag":"$RTAG","health_sha":"${GOT_SHA:-}","outcome":"$1",
"migrations":"disabled-intentional-V058-untouched","stamp":"$STAMP"}
EOF
}

# 4. Acquire the new image (exact SHA provenance).
if [ -n "$DIGEST" ]; then
  if ! docker pull "${GHCR_IMAGE}@${DIGEST}"; then
    fail "GHCR pull failed (login missing? use --source-dir fallback lane)"
  fi
  NEW_REF="${GHCR_IMAGE}@${DIGEST}"
  docker tag "$NEW_REF" "pi-finance-api:release-${SHORT}" || fail "cannot tag release image"
else
  [ -d "$SOURCE_DIR/.git" ] || fail "--source-dir is not a git checkout"
  [ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$SHA" ] \
    || fail "--source-dir HEAD is not the exact SHA $SHA"
  [ -z "$(git -C "$SOURCE_DIR" status --short)" ] \
    || fail "--source-dir is dirty (must be pristine at $SHA)"
  # Subshell cd: build context is the source dir regardless of caller cwd;
  # Dockerfile path is absolute under the verified pristine source.
  ( cd "$SOURCE_DIR" && docker build -f "$SOURCE_DIR/apps/api/Dockerfile" \
      --build-arg "BUILD_SHA=$SHA" --build-arg "BUILD_ID=$CI_RUN" \
      --build-arg "BUILD_TIME=$STAMP" \
      -t "pi-finance-api:release-${SHORT}" . ) || fail "source build failed"
  NEW_REF="pi-finance-api:release-${SHORT}"
fi
NEW_ID="$(docker inspect "pi-finance-api:release-${SHORT}" --format '{{.Id}}')" \
  || fail "cannot inspect release image"

# 5. Swap + recreate (env/network/compose untouched; no prune, ever).
docker tag "$NEW_REF" "$IMAGE" || fail "cannot retag :main (pre-swap; rollback tag preserved)"
if ! docker compose -f "$COMPOSE_FILE" up -d --no-deps --no-build "$SERVICE"; then
  # Swap happened but recreate failed: old container still runs old image.
  # Re-point :main at the rollback tag and recreate to a verified state.
  do_rollback
  if [ "$ROLLBACK_STATUS" = "verified" ]; then
    GOT_SHA=""; write_manifest "rolled-back-verified"
    echo "ROLLED-BACK-VERIFIED (compose up failed)" >&2; exit 4
  fi
  GOT_SHA=""; write_manifest "rollback-failed"
  echo "ROLLBACK-FAILED (compose up failed; rollback unverified)" >&2; exit 5
fi

# 5b. Configured-image check (selective inspect, no env dump).
RUN_ID="$(docker inspect "$SERVICE" --format '{{.Image}}' 2>/dev/null || true)"
if [ "$RUN_ID" != "$NEW_ID" ]; then
  do_rollback
  if [ "$ROLLBACK_STATUS" = "verified" ]; then
    GOT_SHA=""; write_manifest "rolled-back-verified"
    echo "ROLLED-BACK-VERIFIED (wrong running image after swap)" >&2; exit 4
  fi
  GOT_SHA=""; write_manifest "rollback-failed"
  echo "ROLLBACK-FAILED (wrong running image + rollback unverified)" >&2; exit 5
fi

# 6. Gates (bounded curl; every failure path rolls back first).
for _ in $(seq 1 18); do
  ST="$(docker inspect "$SERVICE" --format '{{.State.Health.Status}}' 2>/dev/null || true)"
  [ "$ST" = "healthy" ] && break
  sleep 10
done
GATE_FAIL=""
[ "$ST" = "healthy" ] || GATE_FAIL="container not healthy after 180s"
if [ -z "$GATE_FAIL" ]; then
  if ! HEALTH_JSON="$(curl_get "$API_ORIGIN/health")"; then
    GATE_FAIL="/health unreachable"
  elif ! GOT_SHA="$(extract_sha "$HEALTH_JSON")" || [ -z "$GOT_SHA" ]; then
    GATE_FAIL="/health has no gitSha"
  elif [ "$GOT_SHA" != "$SHA" ]; then
    GATE_FAIL="/health gitSha $GOT_SHA != $SHA"
  elif ! curl_get "$API_ORIGIN/ready" >/dev/null; then
    GATE_FAIL="/ready failed"
  fi
fi
if [ -n "$GATE_FAIL" ]; then
  do_rollback
  if [ "$ROLLBACK_STATUS" = "verified" ]; then
    write_manifest "rolled-back-verified"
    echo "ROLLED-BACK-VERIFIED ($GATE_FAIL)" >&2; exit 4
  fi
  write_manifest "rollback-failed"
  echo "ROLLBACK-FAILED ($GATE_FAIL; rollback unverified)" >&2; exit 5
fi

# 7. Success manifest (no secrets).
: "${GOT_SHA:?internal: health sha unset on success path}"
write_manifest "released"
echo "RELEASE OK sha=$SHA health=$GOT_SHA manifest=$MANIFEST"
