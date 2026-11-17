type EnvLike = Record<string, string | undefined>;

function readEnv(env: EnvLike | undefined, key: string): string | undefined {
  if (!env) return undefined;
  try { return env[key]; } catch { return undefined; }
}

/**
 * Offline session policy (V4 T2.6, SPEC §10 D1-D3, ADR-015): maximum age of
 * the last online authentication before the offline snapshot locks
 * (`offline session locked`, revalidation online unlocks).
 *
 * Call-time read (same NEXT_PUBLIC_* gotcha pattern as the mic flag) so
 * tests toggle via `vi.stubEnv` without re-imports. Unit is HOURS in the
 * env name; milliseconds internally. Defensive parse: non-finite,
 * non-positive or missing values fall back to the 72h default.
 */
export const DEFAULT_MAX_OFFLINE_AUTH_AGE_HOURS = 72;

export function getMaxOfflineAuthAgeHours(env?: EnvLike): number {
  const raw =
    env !== undefined
      ? readEnv(env, "NEXT_PUBLIC_MAX_OFFLINE_AUTH_AGE_HOURS")
      : typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_MAX_OFFLINE_AUTH_AGE_HOURS
        : undefined;
  if (raw === undefined) return DEFAULT_MAX_OFFLINE_AUTH_AGE_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_OFFLINE_AUTH_AGE_HOURS;
  return parsed;
}

/** Max offline auth age in milliseconds (derived from the hours env). */
export function getMaxOfflineAuthAgeMs(env?: EnvLike): number {
  return getMaxOfflineAuthAgeHours(env) * 3_600_000;
}

/**
 * Offline snapshot kill-switch (V4.1 Phase 5, Task 5.9 + D10): optional
 * disable via `NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT=1|true`. Default is
 * ENABLED — absence or any other value keeps the snapshot path. Static
 * literal read (SPEC §12.3); the injected-`env` parameter is tests-only.
 */
export function isOfflineSnapshotEnabled(env?: EnvLike): boolean {
  const value =
    env !== undefined
      ? readEnv(env, "NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT")
      : typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT
        : undefined;
  return value !== "1" && value !== "true";
}

