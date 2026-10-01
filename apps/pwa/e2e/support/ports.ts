/**
 * E2E local port resolution (single source of truth).
 *
 * Defaults preserve the historical harness topology:
 *   fixture API 4010 · Next 3001 · SW harness 3000.
 *
 * Opt-in overrides (local only, never production):
 *   E2E_FIXTURE_PORT / E2E_NEXT_PORT / E2E_HARNESS_PORT
 *
 * Fail-closed: Playwright owns the full server lifecycle
 * (reuseExistingServer: false, unconditionally). It starts its own fixture,
 * Next, and harness processes per run and cleans them up afterwards, so an
 * alien squatter on any of the ports fails the run fast instead of being
 * silently reused. There is no ownership flag and no reuse pathway — the
 * runner (e2e/run-ci.sh) only builds and then invokes Playwright.
 */

export const DEFAULT_FIXTURE_PORT = 4010;
export const DEFAULT_NEXT_PORT = 3001;
export const DEFAULT_HARNESS_PORT = 3000;

export type E2ePorts = {
  fixturePort: number;
  nextPort: number;
  harnessPort: number;
};

type EnvLike = Record<string, string | undefined>;

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`[e2e-ports] invalid ${name}=${JSON.stringify(raw)} (want 1..65535)`);
  }
  return n;
}

export function resolveE2ePorts(env: EnvLike = process.env): E2ePorts {
  return {
    fixturePort: parsePort(env.E2E_FIXTURE_PORT, DEFAULT_FIXTURE_PORT, "E2E_FIXTURE_PORT"),
    nextPort: parsePort(env.E2E_NEXT_PORT, DEFAULT_NEXT_PORT, "E2E_NEXT_PORT"),
    harnessPort: parsePort(env.E2E_HARNESS_PORT, DEFAULT_HARNESS_PORT, "E2E_HARNESS_PORT"),
  };
}

/** Page origin of the SW harness (browser-facing URL specs navigate to). */
export function harnessOrigin(env: EnvLike = process.env): string {
  return harnessUrlFor(
    parsePort(env.E2E_HARNESS_PORT, DEFAULT_HARNESS_PORT, "E2E_HARNESS_PORT"),
  );
}

export function fixtureUrlFor(fixturePort: number): string {
  return `http://127.0.0.1:${fixturePort}`;
}

export function harnessUrlFor(harnessPort: number): string {
  return `http://127.0.0.1:${harnessPort}`;
}
