#!/usr/bin/env bash
# PWA E2E CI runner
# Builds Next.js, then each project gate below launches its own servers
# sequentially via the Playwright config (fail-closed: reuseExistingServer
# is false, so an alien squatter fails the run fast instead of being reused).
# This runner never starts, probes, or kills any server process.
# Each gate writes to its own --output=test-results/<project> dir (plus its
# own PLAYWRIGHT_HTML_OUTPUT_DIR=test-results/report-<project>), so a later
# gate never overwrites an earlier gate's traces; the workflow uploads
# apps/pwa/test-results/ whole, carrying every per-gate subtree.
# Usage: bash apps/pwa/e2e/run-ci.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PWA="$ROOT/apps/pwa"
RESULT=0

# This runner is fixture-only. Pin every API path before the Next build and
# clear opt-in live/deployed targets inherited from the caller or dotenv files.
# The backend proxy otherwise defaults to the production API.
#
# src/lib/api/client.ts:baseUrl() returns undefined when this is unset and the
# host is not the production PWA — which puts the app in mock mode, so the
# registration screen never renders and every spec fails on
# getByRole("button", { name: "Registrar" }).
#
# NEXT_PUBLIC_* is inlined at build time, so this must be exported before
# `pnpm build:next:cloudflare`, not only before starting the runtime.
# Opt-in local port overrides (defaults preserve fixture 4010 · Next 3001 · harness 3000).
# The Playwright config reads the same vars, so config + runner never drift.
export E2E_FIXTURE_PORT="${E2E_FIXTURE_PORT:-4010}"
export E2E_NEXT_PORT="${E2E_NEXT_PORT:-3001}"
export E2E_HARNESS_PORT="${E2E_HARNESS_PORT:-3000}"
export NEXT_PUBLIC_PI_FINANCE_API_BASE_URL="http://127.0.0.1:${E2E_FIXTURE_PORT}"
export NEXT_PUBLIC_LEGACY_BEARER_COMPAT="off"
export PWA_BACKEND_PROXY_ORIGIN="http://127.0.0.1:${E2E_FIXTURE_PORT}"
export NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL=""
export PWA_AGENT_PROXY_ORIGIN=""
export AGENT_ORIGIN=""
export ALLOW_LOCAL_ORIGIN="0"
export PWA_LIVE_E2E="0"
export PWA_LIVE_BASE_URL="http://127.0.0.1:${E2E_HARNESS_PORT}"
export E2E_PRODUCTION_SMOKE="0"
export E2E_PRODUCTION_URL=""
echo "[run-ci] API base URL: $NEXT_PUBLIC_PI_FINANCE_API_BASE_URL"

# ── Build Next.js (servers are Playwright-managed per gate below) ───────────
echo "[run-ci] building Next.js..."
pushd "$PWA" >/dev/null
pnpm build:next:cloudflare
popd >/dev/null

# ── Run functional E2E ──────────────────────────────────────────────────────
echo "[run-ci] functional E2E..."
pushd "$PWA" >/dev/null
PLAYWRIGHT_HTML_OUTPUT_DIR=test-results/report-functional-mobile pnpm exec playwright test \
  --config=e2e/playwright.config.ts \
  --project=functional-mobile \
  --output=test-results/functional-mobile \
  --workers=1 --retries=1 || RESULT=1
popd >/dev/null

# ── Run PWA runtime E2E ────────────────────────────────────────────────────
echo "[run-ci] PWA runtime E2E..."
pushd "$PWA" >/dev/null
PLAYWRIGHT_HTML_OUTPUT_DIR=test-results/report-pwa-runtime pnpm exec playwright test \
  --config=e2e/playwright.config.ts \
  --project=pwa-runtime \
  --output=test-results/pwa-runtime \
  --workers=1 --retries=0 || RESULT=1
popd >/dev/null
# ── Run push runtime E2E with real Service Worker + browser Permission API ─────
echo "[run-ci] push runtime E2E..."
pushd "$PWA" >/dev/null
PLAYWRIGHT_HTML_OUTPUT_DIR=test-results/report-push-runtime pnpm exec playwright test \
  --config=e2e/playwright.config.ts \
  --project=push-runtime \
  --output=test-results/push-runtime \
  --workers=1 --retries=0 || RESULT=1
popd >/dev/null
# ── Run desktop E2E (representative only) ───────────────────────────────────
echo "[run-ci] desktop E2E..."
pushd "$PWA" >/dev/null
PLAYWRIGHT_HTML_OUTPUT_DIR=test-results/report-functional-desktop pnpm exec playwright test \
  --config=e2e/playwright.config.ts \
  --project=functional-desktop \
  e2e/specs/home.spec.ts e2e/specs/navigation.spec.ts \
  --output=test-results/functional-desktop \
  --workers=1 --retries=1 || RESULT=1
popd >/dev/null

# ── Run matrix gate ─────────────────────────────────────────────────────────
echo "[run-ci] matrix gate..."
pushd "$PWA" >/dev/null
pnpm exec tsx --test e2e/support/matrix.test.ts || RESULT=1
popd >/dev/null

# ── Report ──────────────────────────────────────────────────────────────────
if [ "$RESULT" -eq 0 ]; then
  echo "[run-ci] ALL PASS"
else
  echo "[run-ci] FAILURES DETECTED"
fi

exit "$RESULT"
