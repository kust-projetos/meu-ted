// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectJournal } from "./harness";

describe("E2E journal assertions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("matches a RegExp against the journal path", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify([
          { method: "POST", path: "/cards/purchases/pur-1", status: 200 },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expectJournal("journal-regex", "POST", /\/cards\/purchases\/pur-[^/]+/, 200, 300);
  });

  it("keeps string journal paths exact", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify([
          { method: "POST", path: "/accounts", status: 200 },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expectJournal("journal-string", "POST", "/accounts", 200, 300);
  });
});

// ── FIX-E2E-DEVICE-ME-ALLOWANCE: baseline must not mask device verification ──

const HERE = dirname(fileURLToPath(import.meta.url));

describe("baseline failure allowances", () => {
  it("does not tolerate /auth/devices/me in the shared baseline", () => {
    const src = readFileSync(join(HERE, "harness.ts"), "utf8");
    const baseline = src.slice(src.indexOf("BASELINE_ALLOWED"), src.indexOf("] as const"));
    expect(baseline).not.toContain("/auth/devices/me");
  });

  it("keeps the exact anonymous /auth/session 401 probe allowance", () => {
    const src = readFileSync(join(HERE, "harness.ts"), "utf8");
    expect(src).toContain('url: "/auth/session"');
    expect(src).toContain("expected anonymous cookie-session probe before login");
  });
});

// ── Remote PWA-03/PWA-05: fill-before-hydration resets the login form ──────

describe("authenticate hydration gate", () => {
  it("waits out the boot placeholder before filling the login form", () => {
    // Filling server-rendered inputs before React hydrates lets hydration
    // reset the DOM values to empty state, so Entrar never enables. The
    // gate must precede the first fill inside authenticate().
    const src = readFileSync(join(HERE, "harness.ts"), "utf8");
    const auth = src.slice(src.indexOf("export async function authenticate"));
    expect(auth).toContain('getByTestId("root-boot-placeholder")');
    expect(auth).toContain("toHaveCount(0");
    const gateAt = auth.indexOf('getByTestId("root-boot-placeholder")');
    const fillAt = auth.indexOf('fill("test@example.com")');
    expect(gateAt).toBeGreaterThan(-1);
    expect(fillAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(fillAt);
  });
});
