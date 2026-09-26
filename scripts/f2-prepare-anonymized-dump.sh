#!/usr/bin/env bash
# f2-prepare-anonymized-dump.sh — F2 rehearsal: anonymized prod dump, built ON THE VPS.
#
# Privacy rule: real PII must NEVER leave the VPS. This pipeline restores a
# production dump into a DISPOSABLE container (no host ports published),
# scrubs it with scripts/anonymize-pg-copy.sql, and only the ANONYMIZED dump
# is transferred to the workstation afterwards.
#
# The production container is touched READ-ONLY (a single pg_dump). Nothing is
# written to it, no container is restarted, no credentials are needed (peer
# socket trust inside containers as user postgres — no PGPASSWORD anywhere).
#
# Usage: bash scripts/f2-prepare-anonymized-dump.sh [OUT_DIR] [TAG]
#   OUT_DIR  default: $HOME/backups/pi-financeiro
#   TAG      optional label sanitized to [A-Za-z0-9_-], appended to the filename
# Env:
#   ANONIMIZE_SQL  override path to the anonymization SQL file
#                  (default: <script-dir>/anonymize-pg-copy.sql)
set -euo pipefail

PROD_CONTAINER="evolution-postgres"
PROD_DB="pi_financeiro"
PROD_USER="postgres"
IMAGE="postgres:15-alpine"

OUT_DIR="${1:-$HOME/backups/pi-financeiro}"
TAG_RAW="${2:-}"
TAG="$(printf '%s' "$TAG_RAW" | tr -cd 'A-Za-z0-9_-')"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
CNAME="pi-finance-anonymize-${TS}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${ANONIMIZE_SQL:-$SCRIPT_DIR/anonymize-pg-copy.sql}"

if [ ! -f "$SQL_FILE" ]; then
  echo "error: anonymization SQL not found: $SQL_FILE (set ANONIMIZE_SQL to override)" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is not available in PATH" >&2
  exit 1
fi
# Refuse to run unless the production container exists AND is running.
if [ "$(docker inspect -f '{{.State.Running}}' "$PROD_CONTAINER" 2>/dev/null || echo missing)" != "true" ]; then
  echo "error: refusing to run: container '$PROD_CONTAINER' is missing or not running" >&2
  exit 1
fi
mkdir -p "$OUT_DIR"

if [ -n "$TAG" ]; then
  DUMP_FILE="$OUT_DIR/pi-financeiro-f2-anonymized-${TS}-${TAG}.sql.gz"
  COUNTS_FILE="$OUT_DIR/pi-financeiro-f2-anonymized-${TS}-${TAG}.counts.txt"
else
  DUMP_FILE="$OUT_DIR/pi-financeiro-f2-anonymized-${TS}.sql.gz"
  COUNTS_FILE="$OUT_DIR/pi-financeiro-f2-anonymized-${TS}.counts.txt"
fi

cleanup() {
  docker rm -f "$CNAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== [1/7] Start disposable container $CNAME ($IMAGE, no published ports) ==="
docker run -d --name "$CNAME" -e POSTGRES_PASSWORD=anonymize "$IMAGE" >/dev/null

echo "=== [2/7] Wait for readiness (pg_isready via docker exec) ==="
READY=""
for _ in $(seq 1 60); do
  if docker exec "$CNAME" pg_isready -U "$PROD_USER" >/dev/null 2>&1; then
    READY="yes"
    break
  fi
  sleep 1
done
if [ -z "$READY" ]; then
  echo "error: disposable postgres did not become ready in 60s" >&2
  exit 1
fi

echo "=== [3/7] Create scratch database + reset public schema ==="
docker exec "$CNAME" createdb -U "$PROD_USER" "$PROD_DB" >/dev/null
docker exec "$CNAME" psql -U "$PROD_USER" -d "$PROD_DB" -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA public CASCADE;" -c "CREATE SCHEMA public;" >/dev/null

echo "=== [4/7] Dump production (READ-ONLY pg_dump) into the scratch database ==="
# The only contact with the production container: a plain read-only pg_dump.
docker exec "$PROD_CONTAINER" pg_dump -U "$PROD_USER" -d "$PROD_DB" \
  --format=plain --no-owner --no-privileges \
  | docker exec -i "$CNAME" psql -U "$PROD_USER" -d "$PROD_DB" \
    -v ON_ERROR_STOP=1 -q -f - >/dev/null
echo "restore complete"

echo "=== [5/7] Apply anonymization SQL ==="
docker cp "$SQL_FILE" "$CNAME:/tmp/anonymize-pg-copy.sql"
# Full psql output (NOTICEs + count verification block) is captured for the report.
docker exec "$CNAME" psql -U "$PROD_USER" -d "$PROD_DB" \
  -v ON_ERROR_STOP=1 -f /tmp/anonymize-pg-copy.sql | tee "$COUNTS_FILE"

echo "=== [6/7] Verify counts match production (read-only COUNT queries) ==="
COUNT_SQL="SELECT 'users:' || COUNT(*) FROM public.users UNION ALL SELECT 'households:' || COUNT(*) FROM public.households UNION ALL SELECT 'memberships:' || COUNT(*) FROM public.memberships UNION ALL SELECT 'invites:' || COUNT(*) FROM public.invites UNION ALL SELECT 'accounts:' || COUNT(*) FROM public.accounts UNION ALL SELECT 'categories:' || COUNT(*) FROM public.categories UNION ALL SELECT 'statements:' || COUNT(*) FROM public.statements UNION ALL SELECT 'transactions:' || COUNT(*) FROM public.transactions UNION ALL SELECT 'card_purchases:' || COUNT(*) FROM public.card_purchases UNION ALL SELECT 'accounts_payable:' || COUNT(*) FROM public.accounts_payable UNION ALL SELECT 'budgets:' || COUNT(*) FROM public.budgets UNION ALL SELECT 'goals:' || COUNT(*) FROM public.goals UNION ALL SELECT 'goal_contributions:' || COUNT(*) FROM public.goal_contributions UNION ALL SELECT 'payable_templates:' || COUNT(*) FROM public.payable_templates UNION ALL SELECT 'notification_configs:' || COUNT(*) FROM public.notification_configs UNION ALL SELECT 'subscriptions:' || COUNT(*) FROM public.subscriptions UNION ALL SELECT 'idempotency_keys:' || COUNT(*) FROM public.idempotency_keys UNION ALL SELECT 'device_tokens:' || COUNT(*) FROM public.device_tokens UNION ALL SELECT 'operation_records:' || COUNT(*) FROM public.operation_records ORDER BY 1;"
PROD_COUNTS="$(docker exec "$PROD_CONTAINER" psql -U "$PROD_USER" -d "$PROD_DB" -tAc "$COUNT_SQL")"
ANON_COUNTS="$(docker exec "$CNAME" psql -U "$PROD_USER" -d "$PROD_DB" -tAc "$COUNT_SQL")"
if [ "$PROD_COUNTS" != "$ANON_COUNTS" ]; then
  echo "error: count mismatch between production and anonymized copy:" >&2
  diff <(printf '%s\n' "$PROD_COUNTS") <(printf '%s\n' "$ANON_COUNTS") >&2 || true
  exit 1
fi
echo "counts match production for all 19 imported tables"

echo "=== [7/7] Dump the anonymized database ==="
docker exec "$CNAME" pg_dump -U "$PROD_USER" -d "$PROD_DB" \
  --format=plain --no-owner --no-privileges \
  | gzip > "$DUMP_FILE"
if [ ! -s "$DUMP_FILE" ]; then
  echo "error: anonymized dump is empty: $DUMP_FILE" >&2
  exit 1
fi

SIZE_BYTES="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
SHA256="$(sha256sum "$DUMP_FILE" | awk '{print $1}')"
echo "---"
echo "anonymized dump : $DUMP_FILE"
echo "size (bytes)    : $SIZE_BYTES"
echo "sha256          : $SHA256"
echo "counts file     : $COUNTS_FILE"
echo "--- count verification block (also saved above) ---"
cat "$COUNTS_FILE"
echo "---"
echo "done. Only $DUMP_FILE (+ counts) may leave the VPS."
