import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getChatAttachmentCapabilities,
  getMaxOfflineAuthAgeHours,
  isMicrophoneEnabled,
  isOfflineSnapshotEnabled,
} from "./capabilities";

/**
 * V4.1 Phase 5 (Tasks 5.4–5.6, SPEC §12.3–§12.4): NEXT_PUBLIC_* must be read
 * through static literal references so Next inlines them at build time.
 * Injected-env overrides stay for tests only.
 */
describe("capabilities static NEXT_PUBLIC reads (SPEC §12.3)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the documented config shape from the real static env", () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "1");
    vi.stubEnv("NEXT_PUBLIC_TED_MICROPHONE", "true");
    vi.stubEnv("NEXT_PUBLIC_MAX_OFFLINE_AUTH_AGE_HOURS", "48");
    expect(getChatAttachmentCapabilities()).toEqual({
      image: true,
      pdf: true,
      audio: true,
      microphone: true,
    });
    expect(isMicrophoneEnabled()).toBe(true);
    expect(getMaxOfflineAuthAgeHours()).toBe(48);
  });

  /**
   * A13/P3: the per-type flags are read through literal references too, so a
   * deploy can announce exactly the types whose backend pipeline is ready.
   */
  it("resolve as flags por tipo a partir do env estático real", () => {
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_INGESTION", "");
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_IMAGE", "1");
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_PDF", "");
    vi.stubEnv("NEXT_PUBLIC_TED_ATTACHMENT_AUDIO", "1");
    expect(getChatAttachmentCapabilities()).toMatchObject({
      image: true,
      pdf: false,
      audio: true,
    });
  });

  it("falls back to the 72h default when the static env is absent", () => {
    vi.stubEnv("NEXT_PUBLIC_MAX_OFFLINE_AUTH_AGE_HOURS", undefined as unknown as string);
    expect(getMaxOfflineAuthAgeHours()).toBe(72);
  });

  it("contains no dynamic process.env access (build-time inlining guard)", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.resolve(dir, "capabilities.ts"), "utf8");
    // Computed access (process.env[key]) cannot be inlined by Next.
    expect(source).not.toMatch(/process\.env\[/);
    // Destructuring process.env breaks static analysis the same way.
    expect(source).not.toMatch(/(const|let|var)\s*\{[^}]*\}\s*=\s*process\.env/);
    expect(source).not.toMatch(/\.\.\.\s*process\.env/);
    // Every public flag still resolves through a literal NEXT_PUBLIC_* read.
    for (const key of [
      "NEXT_PUBLIC_TED_MICROPHONE",
      "NEXT_PUBLIC_TED_ATTACHMENT_INGESTION",
      "NEXT_PUBLIC_TED_ATTACHMENT_IMAGE",
      "NEXT_PUBLIC_TED_ATTACHMENT_PDF",
      "NEXT_PUBLIC_TED_ATTACHMENT_AUDIO",
      "NEXT_PUBLIC_MAX_OFFLINE_AUTH_AGE_HOURS",
      "NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT",
    ]) {
      expect(source).toContain(`process.env.${key}`);
    }
  });
});

describe("isOfflineSnapshotEnabled (D10 optional disable)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to enabled when the flag is absent", () => {
    expect(isOfflineSnapshotEnabled({})).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT", undefined as unknown as string);
    expect(isOfflineSnapshotEnabled()).toBe(true);
  });

  it("disables only on explicit 1/true", () => {
    expect(isOfflineSnapshotEnabled({ NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT: "1" })).toBe(false);
    expect(isOfflineSnapshotEnabled({ NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT: "true" })).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT", "1");
    expect(isOfflineSnapshotEnabled()).toBe(false);
  });

  it("stays enabled for any other value", () => {
    for (const value of ["0", "false", "no", "off", ""]) {
      expect(isOfflineSnapshotEnabled({ NEXT_PUBLIC_DISABLE_OFFLINE_SNAPSHOT: value })).toBe(true);
    }
  });
});
