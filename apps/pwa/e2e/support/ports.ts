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

// P2D synthetic-conversation browser stack (test-only, loopback only).
// Dedicated ports so the P2D run never touches the historical topology
// above: its own Fastify API + gateway probe + Next dev + control server. Same fail-closed ownership as the main topology.
export const DEFAULT_P2D_API_PORT = 4110;
export const DEFAULT_P2D_NEXT_PORT = 3201;
export const DEFAULT_P2D_GATEWAY_PORT = 3221;
export const DEFAULT_P2D_CTL_PORT = 3200;
export const DEFAULT_P2D_AGENT_PORT = 3222;

export type P2dPorts = {
  apiPort: number;
  nextPort: number;
  gatewayPort: number;
  ctlPort: number;
  agentPort: number;
};

export function resolveP2dPorts(env: EnvLike = process.env): P2dPorts {
  return {
    apiPort: parsePort(env.P2D_API_PORT, DEFAULT_P2D_API_PORT, "P2D_API_PORT"),
    nextPort: parsePort(env.P2D_NEXT_PORT, DEFAULT_P2D_NEXT_PORT, "P2D_NEXT_PORT"),
    gatewayPort: parsePort(env.P2D_GATEWAY_PORT, DEFAULT_P2D_GATEWAY_PORT, "P2D_GATEWAY_PORT"),
    ctlPort: parsePort(env.P2D_CTL_PORT, DEFAULT_P2D_CTL_PORT, "P2D_CTL_PORT"),
    agentPort: parsePort(env.P2D_AGENT_PORT, DEFAULT_P2D_AGENT_PORT, "P2D_AGENT_PORT"),
  };
}

export function p2dNextUrlFor(nextPort: number): string {
  return `http://127.0.0.1:${nextPort}`;
}
