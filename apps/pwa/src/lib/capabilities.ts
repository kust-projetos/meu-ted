/**
 * Chat attachment + microphone capability gates (SPEC §18, H-09; V4 §7 A1/A2; INV-08).
 *
 * A13/P3: attachments are now gated PER TYPE. Each kind has its own
 * default-off flag (`NEXT_PUBLIC_TED_ATTACHMENT_IMAGE|_PDF|_AUDIO`), so the UI
 * announces exactly the kinds whose backend pipeline is actually available —
 * a kind whose backend ingestion is off is never offered.
 *
 * The pre-A13 flag `NEXT_PUBLIC_TED_ATTACHMENT_INGESTION=1` is kept as a
 * LEGACY MASTER: when it is on it enables the three types at once (backwards
 * compatibility for a deploy that has not yet split them). The per-type flags
 * UNION with the master — turning one type on never requires the master.
 *
 * Everything defaults to FALSE: an absent flag, or any value other than "1",
 * keeps that capability disabled (fail-closed). The backend enforces the
 * same contract server-side; these flags only decide what the UI advertises.
 *
 * The microphone gate (V4 T1.1) follows the same call-time pattern: default
 * false, enabled by `NEXT_PUBLIC_TED_MICROPHONE=1` or `=true`. The deploy
 * sets it to `true` (Phase 1); code default stays false. Both the
 * Permissions-Policy header (proxy-utils) and the record button (TedChat)
 * read this same flag, so header and UI can never diverge.
 */

export interface ChatAttachmentCapabilities {
  image: boolean;
  pdf: boolean;
  audio: boolean;
  /** Live voice capture (record button + Permissions-Policy). Default false. */
  microphone: boolean;
}

type EnvLike = Record<string, string | undefined>;

function readEnv(env: EnvLike | undefined, key: string): string | undefined {
  if (!env) return undefined;
  try {
    return env[key];
  } catch {
    return undefined;
  }
}

/**
 * V4.1 Phase 5 (SPEC §12.3): NEXT_PUBLIC_* values consumed by the browser
 * bundle MUST be read through static literal member references so Next
 * inlines them at build time. Computed-key or destructured reads would
 * defeat inlining. The injected-`env` parameter stays as a tests-only
 * override (vi.stubEnv without re-imports); production paths always pass
 * undefined and hit the literal reads below.
 */

/** Live read so tests can toggle via `vi.stubEnv` without re-imports. */
export function isMicrophoneEnabled(env?: EnvLike): boolean {
  const value =
    env !== undefined
      ? readEnv(env, "NEXT_PUBLIC_TED_MICROPHONE")
      : typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_TED_MICROPHONE
        : undefined;
  return value === "1" || value === "true";
}

/**
 * A13/P3 — legacy master flag. Kept as a compatibility switch: when it is
 * exactly "1" it enables image, pdf and audio together, so a deploy that has
 * not split the types yet behaves exactly as before.
 */
function isLegacyAttachmentIngestionEnabled(env?: EnvLike): boolean {
  const value =
    env !== undefined
      ? readEnv(env, "NEXT_PUBLIC_TED_ATTACHMENT_INGESTION")
      : typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_TED_ATTACHMENT_INGESTION
        : undefined;
  return value === "1";
}

/**
 * A13/P3 — per-kind attachment gate. A kind is advertised when its OWN flag
 * is exactly "1" OR the legacy master is on. Anything else (absent, "0",
 * "true", "yes", "") stays disabled — default-off and fail-closed.
 */
function isAttachmentKindEnabled(env: EnvLike | undefined, kindFlag: string): boolean {
  if (isLegacyAttachmentIngestionEnabled(env)) return true;
  const value =
    env !== undefined
      ? readEnv(env, kindFlag)
      : typeof process !== "undefined"
        ? kindFlag === "NEXT_PUBLIC_TED_ATTACHMENT_IMAGE"
          ? process.env.NEXT_PUBLIC_TED_ATTACHMENT_IMAGE
          : kindFlag === "NEXT_PUBLIC_TED_ATTACHMENT_PDF"
            ? process.env.NEXT_PUBLIC_TED_ATTACHMENT_PDF
            : process.env.NEXT_PUBLIC_TED_ATTACHMENT_AUDIO
        : undefined;
  return value === "1";
}

/** Live read so tests can toggle via `vi.stubEnv` without re-imports. */
export function getChatAttachmentCapabilities(env?: EnvLike): ChatAttachmentCapabilities {
  return {
    image: isAttachmentKindEnabled(env, "NEXT_PUBLIC_TED_ATTACHMENT_IMAGE"),
    pdf: isAttachmentKindEnabled(env, "NEXT_PUBLIC_TED_ATTACHMENT_PDF"),
    audio: isAttachmentKindEnabled(env, "NEXT_PUBLIC_TED_ATTACHMENT_AUDIO"),
    microphone: isMicrophoneEnabled(env),
  };
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

/** Build-time snapshot for non-reactive consumers. Prefer the function above in components. */
export const chatAttachmentCapabilities: ChatAttachmentCapabilities =
  getChatAttachmentCapabilities();
