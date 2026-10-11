/**
 * A19 — typed capability-state inventory (unit, pure, no env, no network).
 *
 * Pins the CONTRACT of the inventory, not any live configuration:
 *
 * - the derived status is exactly one of UNCONFIGURED / CONFIGURED_DISABLED /
 *   CANARY / ACTIVE / BLOCKED — never a sixth state, never `undefined`;
 * - the seven evidence dimensions stay SEPARATE: code implemented,
 *   configuration present, server flag, provider available (boolean only),
 *   cohort authorization (boolean/unknown), canary evidence (boolean/unknown)
 *   and operational block (boolean/unknown) are never collapsed into one
 *   another;
 * - ACTIVE is never inferred from a single dimension (a credential/binding
 *   presence alone never reaches it — the inventory receives booleans only,
 *   never env values, binding names or secrets);
 * - every unknown/unavailable input FAILS CLOSED (never ACTIVE, never CANARY
 *   when the cohort is undecidable);
 * - an operational block outranks every other signal, including a fully
 *   enabled configuration — but only an EXPLICIT `true` is a block: an exact
 *   `false` proves there is none, and a missing/`'unknown'`/malformed value is
 *   an unanswered question that fails closed and never derives ACTIVE;
 *
 * The module is a PURE derivation model over caller-supplied evidence — not a
 * live/operational inventory: nothing here reads env, runtime state or I/O, and
 * it is not wired into any runtime path. The entry/evidence shapes are closed,
 * so the same closed-key assertion below also pins what the module SERIALIZES:
 * only the closed `capability` union, the closed `status` union and the seven
 * dimensions — no free text, no private field, nothing the caller attached.
 */

import { describe, expect, it } from "vitest";
import {
  buildCapabilityInventory,
  deriveCapabilityStatus,
  type A19Capability,
  type CapabilityEvidence,
  type CapabilityInventoryEntry,
  type CapabilityStatus,
} from "../../src/attachments/capability-state.js";

/** All seven dimensions on and proven: the only shape that derives ACTIVE. */
const ALL_ON: CapabilityEvidence = {
  codeImplemented: true,
  configurationPresent: true,
  serverFlagEnabled: true,
  providerAvailable: true,
  cohortAuthorized: true,
  canaryEvidence: true,
  operationalBlock: false,
};

const withEvidence = (patch: Partial<CapabilityEvidence>): CapabilityEvidence => ({
  ...ALL_ON,
  ...patch,
});

describe("A19 capability inventory — baseline", () => {
  it("all dimensions on and proven derives ACTIVE", () => {
    expect(deriveCapabilityStatus(ALL_ON)).toBe("ACTIVE");
  });

  it("nothing on derives UNCONFIGURED", () => {
    expect(
      deriveCapabilityStatus({
        codeImplemented: false,
        configurationPresent: false,
        serverFlagEnabled: false,
        providerAvailable: false,
        cohortAuthorized: "unknown",
        canaryEvidence: "unknown",
        operationalBlock: false,
      }),
    ).toBe("UNCONFIGURED");
  });

  it("every dimension off with no block derives UNCONFIGURED, not CANARY/ACTIVE", () => {
    expect(
      deriveCapabilityStatus(
        withEvidence({
          codeImplemented: false,
          configurationPresent: false,
          serverFlagEnabled: false,
          providerAvailable: false,
          cohortAuthorized: false,
          canaryEvidence: false,
        }),
      ),
    ).toBe("UNCONFIGURED");
  });
});

describe("A19 capability inventory — one dimension at a time", () => {
  it("code NOT implemented ⇒ UNCONFIGURED (even with flag, provider and cohort on)", () => {
    expect(deriveCapabilityStatus(withEvidence({ codeImplemented: false }))).toBe("UNCONFIGURED");
  });

  it("configuration absent ⇒ UNCONFIGURED (a flag without config is not a configured-off capability)", () => {
    expect(deriveCapabilityStatus(withEvidence({ configurationPresent: false }))).toBe("UNCONFIGURED");
  });

  it("server flag off ⇒ CONFIGURED_DISABLED", () => {
    expect(deriveCapabilityStatus(withEvidence({ serverFlagEnabled: false }))).toBe("CONFIGURED_DISABLED");
  });

  it("provider unavailable ⇒ CONFIGURED_DISABLED (credential/binding presence never substitutes)", () => {
    expect(deriveCapabilityStatus(withEvidence({ providerAvailable: false }))).toBe("CONFIGURED_DISABLED");
  });

  it("cohort authorization false (nobody) ⇒ CONFIGURED_DISABLED", () => {
    expect(deriveCapabilityStatus(withEvidence({ cohortAuthorized: false }))).toBe("CONFIGURED_DISABLED");
  });

  it("cohort authorization unknown ⇒ CONFIGURED_DISABLED (fail-closed, never CANARY)", () => {
    expect(deriveCapabilityStatus(withEvidence({ cohortAuthorized: "unknown" }))).toBe("CONFIGURED_DISABLED");
  });

  it("canary evidence unknown ⇒ CANARY (restricted rollout, unproven)", () => {
    expect(deriveCapabilityStatus(withEvidence({ canaryEvidence: "unknown" }))).toBe("CANARY");
  });

  it("canary evidence explicitly false ⇒ CANARY (unproven, not ACTIVE)", () => {
    expect(deriveCapabilityStatus(withEvidence({ canaryEvidence: false }))).toBe("CANARY");
  });

  it("operational block ⇒ BLOCKED (everything else on)", () => {
    expect(deriveCapabilityStatus(withEvidence({ operationalBlock: true }))).toBe("BLOCKED");
  });
});

describe("A19 capability inventory — contradictions and precedence", () => {
  it("operational block outranks a fully enabled configuration", () => {
    expect(deriveCapabilityStatus(withEvidence({ operationalBlock: true }))).toBe("BLOCKED");
  });

  it("operational block outranks an unconfigured capability (block is still reported)", () => {
    expect(
      deriveCapabilityStatus(
        withEvidence({ codeImplemented: false, configurationPresent: false, operationalBlock: true }),
      ),
    ).toBe("BLOCKED");
  });

  it("flag ON but no implementation/config ⇒ UNCONFIGURED, never CONFIGURED_DISABLED", () => {
    expect(
      deriveCapabilityStatus(
        withEvidence({ codeImplemented: false, configurationPresent: false }),
      ),
    ).toBe("UNCONFIGURED");
  });

  it("general cohort ('*') with unknown canary evidence is still CANARY — never ACTIVE on cohort alone", () => {
    expect(deriveCapabilityStatus(withEvidence({ canaryEvidence: "unknown" }))).toBe("CANARY");
  });

  it("provider + flag on, cohort unknown, canary proven ⇒ CONFIGURED_DISABLED (cohort fails closed first)", () => {
    expect(deriveCapabilityStatus(withEvidence({ cohortAuthorized: "unknown" }))).toBe("CONFIGURED_DISABLED");
  });

  it("block ON with flag OFF ⇒ BLOCKED (never CONFIGURED_DISABLED)", () => {
    expect(
      deriveCapabilityStatus(withEvidence({ serverFlagEnabled: false, operationalBlock: true })),
    ).toBe("BLOCKED");
  });

  it("ACTIVE requires ALL of: code, config, flag, provider, cohort AND canary evidence", () => {
    const required: Partial<CapabilityEvidence>[] = [
      { codeImplemented: false },
      { configurationPresent: false },
      { serverFlagEnabled: false },
      { providerAvailable: false },
      { cohortAuthorized: false },
      { cohortAuthorized: "unknown" },
      { canaryEvidence: false },
      { canaryEvidence: "unknown" },
      { operationalBlock: true },
      { operationalBlock: "unknown" },
    ];
    for (const patch of required) {
      expect(deriveCapabilityStatus(withEvidence(patch))).not.toBe("ACTIVE");
    }
  });
});

describe("A19 capability inventory — operational block tri-state (unknown is not an unblock)", () => {
  it("block unknown ⇒ CONFIGURED_DISABLED — undecidable is not 'no block'", () => {
    expect(deriveCapabilityStatus(withEvidence({ operationalBlock: "unknown" }))).toBe(
      "CONFIGURED_DISABLED",
    );
  });

  it("block unknown never derives ACTIVE, CANARY or BLOCKED", () => {
    // The bug: an invalid/missing block used to normalize to `false` and,
    // with everything else on, derive ACTIVE. 'unknown' must stay non-active.
    const status = deriveCapabilityStatus(withEvidence({ operationalBlock: "unknown" }));
    expect(status).not.toBe("ACTIVE");
    expect(status).not.toBe("BLOCKED");
    expect(status).toBe("CONFIGURED_DISABLED");
  });

  it("block unknown fails closed BEFORE canary evidence (never CANARY on an unanswered block)", () => {
    expect(
      deriveCapabilityStatus(withEvidence({ operationalBlock: "unknown", canaryEvidence: "unknown" })),
    ).toBe("CONFIGURED_DISABLED");
  });

  it("BLOCKED requires an EXPLICIT true — unknown with nothing configured is UNCONFIGURED, not BLOCKED", () => {
    expect(
      deriveCapabilityStatus(
        withEvidence({
          codeImplemented: false,
          configurationPresent: false,
          serverFlagEnabled: false,
          providerAvailable: false,
          operationalBlock: "unknown",
        }),
      ),
    ).toBe("UNCONFIGURED");
  });

  it("only an EXACT false keeps the ACTIVE path reachable; exact true is the only BLOCKED", () => {
    expect(deriveCapabilityStatus(withEvidence({ operationalBlock: false }))).toBe("ACTIVE");
    expect(deriveCapabilityStatus(withEvidence({ operationalBlock: true }))).toBe("BLOCKED");
  });
});

describe("A19 capability inventory — defensive derivation", () => {
  it("truthy-but-not-true booleans fail closed (never ACTIVE/CANARY)", () => {
    const hostile = {
      ...ALL_ON,
      providerAvailable: "yes",
      cohortAuthorized: "yes",
      canaryEvidence: "yes",
    } as unknown as CapabilityEvidence;
    expect(deriveCapabilityStatus(hostile)).toBe("CONFIGURED_DISABLED");
  });

  it("an unusable operationalBlock value fails closed (never ACTIVE, never BLOCKED)", () => {
    // A block value that is not exactly `true`/`false` is unanswered: it must
    // neither fabricate a block nor act as proof the path is unblocked.
    const hostileValues: readonly unknown[] = [
      "unknown",
      "yes",
      "true",
      "false",
      1,
      0,
      null,
      undefined,
      {},
      [],
      new Boolean(false),
      new String("false"),
    ];
    for (const operationalBlock of hostileValues) {
      const hostile = {
        ...ALL_ON,
        operationalBlock,
      } as unknown as CapabilityEvidence;
      expect(deriveCapabilityStatus(hostile)).toBe("CONFIGURED_DISABLED");
    }
  });

  it("never throws and always returns one of the five statuses", () => {
    const STATUSES: readonly CapabilityStatus[] = [
      "UNCONFIGURED",
      "CONFIGURED_DISABLED",
      "CANARY",
      "ACTIVE",
      "BLOCKED",
    ];
    for (const codeImplemented of [true, false]) {
      for (const configurationPresent of [true, false]) {
        for (const serverFlagEnabled of [true, false]) {
          for (const providerAvailable of [true, false]) {
            for (const cohortAuthorized of [true, false, "unknown"] as const) {
              for (const canaryEvidence of [true, false, "unknown"] as const) {
                for (const operationalBlock of [true, false, "unknown"] as const) {
                  const status = deriveCapabilityStatus({
                    codeImplemented,
                    configurationPresent,
                    serverFlagEnabled,
                    providerAvailable,
                    cohortAuthorized,
                    canaryEvidence,
                    operationalBlock,
                  });
                  expect(STATUSES).toContain(status);
                }
              }
            }
          }
        }
      }
    }
  });
});

describe("A19 capability inventory — entries and leak-proofing", () => {
  it("buildCapabilityInventory derives one entry per capability and preserves the evidence", () => {
    const entries = buildCapabilityInventory([
      { capability: "attachments-upload", evidence: ALL_ON },
      { capability: "stt", evidence: withEvidence({ canaryEvidence: "unknown" }) },
      { capability: "vision", evidence: withEvidence({ serverFlagEnabled: false }) },
      { capability: "pdf-text", evidence: withEvidence({ operationalBlock: true }) },
    ]);

    expect(entries.map((entry) => entry.status)).toEqual([
      "ACTIVE",
      "CANARY",
      "CONFIGURED_DISABLED",
      "BLOCKED",
    ]);
    expect(entries[0]?.evidence).toEqual(ALL_ON);
    expect(entries[1]?.evidence.canaryEvidence).toBe("unknown");
    expect(entries[2]?.capability).toBe("vision");
  });

  it("empty input yields an empty inventory", () => {
    expect(buildCapabilityInventory([])).toEqual([]);
  });

  it("an entry carries ONLY the closed keys — no free text can travel through it", () => {
    const entries: readonly CapabilityInventoryEntry[] = buildCapabilityInventory([
      { capability: "stt", evidence: ALL_ON },
    ]);
    const serialized = JSON.stringify(entries);
    // Only the closed unions and booleans appear; any free-text field (a secret
    // value, credential, binding name, workspace/actor id or private config)
    // would add an unknown string here.
    expect(serialized).toBe(
      JSON.stringify([
        {
          capability: "stt",
          status: "ACTIVE",
          evidence: {
            codeImplemented: true,
            configurationPresent: true,
            serverFlagEnabled: true,
            providerAvailable: true,
            cohortAuthorized: true,
            canaryEvidence: true,
            operationalBlock: false,
          },
        },
      ]),
    );
  });

  it("capability ids are the closed A19 set (no external vocabulary)", () => {
    const capabilities: readonly A19Capability[] = [
      "attachments-upload",
      "stt",
      "vision",
      "pdf-text",
    ];
    const entries = buildCapabilityInventory(
      capabilities.map((capability) => ({ capability, evidence: ALL_ON })),
    );
    expect(entries.map((entry) => entry.capability)).toEqual(capabilities);
  });
});

describe("A19 capability derivation — snapshot hardening (leak/mutation-proof)", () => {
  /** The ONLY shape an entry may serialize to, whatever the caller attached. */
  const CANONICAL_ENTRY_JSON = JSON.stringify([
    {
      capability: "stt",
      status: "ACTIVE",
      evidence: {
        codeImplemented: true,
        configurationPresent: true,
        serverFlagEnabled: true,
        providerAvailable: true,
        cohortAuthorized: true,
        canaryEvidence: true,
        operationalBlock: false,
      },
    },
  ]);

  it("an evidence object carrying extra own properties leaks nothing into the entry", () => {
    const poisoned = {
      ...ALL_ON,
      secretCredential: "sk-live-DO-NOT-LEAK",
      bindingName: "TED_ATTACHMENTS_BUCKET",
      workspaceId: "d36cb649-4462-486d-940a-47128ad329f2",
    } as unknown as CapabilityEvidence;

    const entries = buildCapabilityInventory([{ capability: "stt", evidence: poisoned }]);

    expect(entries[0]?.evidence).toEqual(ALL_ON);
    expect(Object.keys(entries[0]?.evidence ?? {})).toEqual([
      "codeImplemented",
      "configurationPresent",
      "serverFlagEnabled",
      "providerAvailable",
      "cohortAuthorized",
      "canaryEvidence",
      "operationalBlock",
    ]);
    const serialized = JSON.stringify(entries);
    expect(serialized).toBe(CANONICAL_ENTRY_JSON);
    expect(serialized).not.toContain("sk-live-DO-NOT-LEAK");
    expect(serialized).not.toContain("TED_ATTACHMENTS_BUCKET");
  });

  it("an evidence object with a toJSON cannot redirect entry serialization", () => {
    const withToJson = {
      ...ALL_ON,
      toJSON: () => ({ leak: "secret-via-tojson", status: "ACTIVE" }),
    } as unknown as CapabilityEvidence;

    const entries = buildCapabilityInventory([{ capability: "stt", evidence: withToJson }]);

    expect(JSON.stringify(entries)).toBe(CANONICAL_ENTRY_JSON);
    expect(JSON.stringify(entries)).not.toContain("secret-via-tojson");
    expect((entries[0]?.evidence as unknown as { toJSON?: unknown }).toJSON).toBeUndefined();
  });

  it("mutating the source evidence after building cannot change the returned snapshot", () => {
    const source: CapabilityEvidence = { ...ALL_ON };
    const entries = buildCapabilityInventory([{ capability: "stt", evidence: source }]);

    // Hostile/loose caller mutates the ORIGINAL object after the build.
    (source as { serverFlagEnabled?: unknown }).serverFlagEnabled = false;
    (source as { operationalBlock?: unknown }).operationalBlock = true;
    (source as { extra?: unknown }).extra = "late-secret";

    expect(entries[0]?.evidence).toEqual(ALL_ON);
    expect(entries[0]?.status).toBe("ACTIVE");
    expect(JSON.stringify(entries)).toBe(CANONICAL_ENTRY_JSON);
  });

  it("malformed dimension values are conservatively normalized, never trusted as ON", () => {
    const hostile = {
      ...ALL_ON,
      serverFlagEnabled: "yes",
      providerAvailable: 1,
      cohortAuthorized: "yes",
      canaryEvidence: {},
      operationalBlock: "true",
    } as unknown as CapabilityEvidence;

    const entries = buildCapabilityInventory([{ capability: "stt", evidence: hostile }]);

    expect(entries[0]?.evidence.serverFlagEnabled).toBe(false);
    expect(entries[0]?.evidence.providerAvailable).toBe(false);
    // The block is a tri-state now: the STRING "true" is neither exactly `true`
    // nor exactly `false`, so it is unusable evidence — normalized to the honest
    // "unknown" (never read as a block, never read as proof of an unblock).
    expect(entries[0]?.evidence.operationalBlock).toBe("unknown");
    // Tri-states that are neither exactly `true` nor `false` fail closed honest:
    // "unknown", never a guessed boolean.
    expect(entries[0]?.evidence.cohortAuthorized).toBe("unknown");
    expect(entries[0]?.evidence.canaryEvidence).toBe("unknown");
    expect(entries[0]?.status).toBe("CONFIGURED_DISABLED");
    expect(JSON.stringify(entries[0]?.evidence)).not.toContain("yes");
    // The unusable block string never travels: the entry carries "unknown".
    expect(JSON.stringify(entries[0]?.evidence)).toContain('"operationalBlock":"unknown"');
  });

  it("a MISSING operationalBlock normalizes to 'unknown' and never derives ACTIVE", () => {
    const missing = { ...ALL_ON } as Record<string, unknown>;
    delete missing.operationalBlock;

    const entries = buildCapabilityInventory([
      { capability: "stt", evidence: missing as unknown as CapabilityEvidence },
    ]);

    expect(entries[0]?.evidence.operationalBlock).toBe("unknown");
    // Everything else is proven on: only the unanswered block keeps it non-active.
    expect(entries[0]?.status).toBe("CONFIGURED_DISABLED");
    expect(entries[0]?.status).not.toBe("ACTIVE");
    expect(JSON.stringify(entries[0]?.evidence)).toContain('"operationalBlock":"unknown"');
    // The closed whitelist still holds: the projected snapshot has no new key.
    expect(Object.keys(entries[0]?.evidence ?? {})).toEqual([
      "codeImplemented",
      "configurationPresent",
      "serverFlagEnabled",
      "providerAvailable",
      "cohortAuthorized",
      "canaryEvidence",
      "operationalBlock",
    ]);
  });

  it("an OBJECT operationalBlock normalizes to 'unknown' — never BLOCKED, never unblocked", () => {
    const entries = buildCapabilityInventory([
      { capability: "stt", evidence: { ...ALL_ON, operationalBlock: {} } as unknown as CapabilityEvidence },
    ]);

    expect(entries[0]?.evidence).toEqual({ ...ALL_ON, operationalBlock: "unknown" });
    expect(entries[0]?.evidence.operationalBlock).toBe("unknown");
    expect(entries[0]?.status).toBe("CONFIGURED_DISABLED");
  });

  it("a hostile operationalBlock toJSON is never invoked and the value normalizes to 'unknown'", () => {
    let toJSONCalls = 0;
    const valueOfCalls = { count: 0 };
    const entries = buildCapabilityInventory([
      {
        capability: "stt",
        evidence: {
          ...ALL_ON,
          operationalBlock: {
            toJSON: () => {
              toJSONCalls += 1;
              return true;
            },
            valueOf: () => {
              valueOfCalls.count += 1;
              return true;
            },
          },
        } as unknown as CapabilityEvidence,
      },
    ]);

    // Neither hook is called: the projection only compares the raw value with
    // `===` against `true`/`false`, it never coerces and never serializes it.
    expect(toJSONCalls).toBe(0);
    expect(valueOfCalls.count).toBe(0);
    expect(entries[0]?.evidence.operationalBlock).toBe("unknown");
    expect(entries[0]?.status).toBe("CONFIGURED_DISABLED");
    // Nothing the object carried reaches the serialized entry.
    expect(JSON.stringify(entries[0]?.evidence)).not.toContain("toJSON");
  });
});

describe("A19 capability inventory — closed capability union enforced at runtime", () => {
  it("accepts every member of the closed A19 set (valid rows still build unchanged)", () => {
    const entries = buildCapabilityInventory([
      { capability: "attachments-upload", evidence: ALL_ON },
      { capability: "stt", evidence: ALL_ON },
      { capability: "vision", evidence: ALL_ON },
      { capability: "pdf-text", evidence: ALL_ON },
    ]);
    expect(entries.map((entry) => entry.capability)).toEqual([
      "attachments-upload",
      "stt",
      "vision",
      "pdf-text",
    ]);
    expect(entries.every((entry) => entry.status === "ACTIVE")).toBe(true);
  });

  it("rejects an unknown capability string BEFORE any entry is returned", () => {
    expect(() =>
      buildCapabilityInventory([
        { capability: "stt", evidence: ALL_ON },
        { capability: "stt-canary" as unknown as A19Capability, evidence: ALL_ON },
      ]),
    ).toThrow(/capability-state\.unknown_capability/);
  });

  it("rejects close-but-wrong capability strings — never a permissive fallback", () => {
    const hostile: readonly unknown[] = ["STT", "stt ", "pdf_text", "attachments", "", "*", "attachments_upload"];
    for (const capability of hostile) {
      expect(() =>
        buildCapabilityInventory([{ capability: capability as A19Capability, evidence: ALL_ON }]),
      ).toThrow(/capability-state\.unknown_capability/);
    }
  });

  it("rejects an OBJECT capability and never invokes its hostile toJSON", () => {
    let toJSONCalls = 0;
    const hostile = {
      capability: "stt",
      status: "ACTIVE",
      toJSON: () => {
        toJSONCalls += 1;
        return { capability: "stt", status: "ACTIVE", evidence: { leaked: "via-tojson" } };
      },
    } as unknown as A19Capability;

    expect(() => buildCapabilityInventory([{ capability: hostile, evidence: ALL_ON }])).toThrow(
      /capability-state\.unknown_capability/,
    );
    // The hostile hook is never invoked — not while rejecting, not while reporting.
    expect(toJSONCalls).toBe(0);
  });

  it("rejects a non-string capability without coercing it or calling any hook", () => {
    const hostile: readonly unknown[] = [{}, [], 42, true, null, undefined, new String("stt"), Symbol("stt")];
    for (const capability of hostile) {
      expect(() =>
        buildCapabilityInventory([{ capability: capability as A19Capability, evidence: ALL_ON }]),
      ).toThrow(/capability-state\.unknown_capability/);
    }
  });

  it("does not invoke a hostile toString while reporting the rejection", () => {
    let toStringCalls = 0;
    const hostile = {
      toString: () => {
        toStringCalls += 1;
        throw new Error("capability-state.hostile_to_string_invoked");
      },
    } as unknown as A19Capability;

    expect(() => buildCapabilityInventory([{ capability: hostile, evidence: ALL_ON }])).toThrow(
      /capability-state\.unknown_capability/,
    );
    expect(toStringCalls).toBe(0);
  });

  it("a hostile capability never reaches a returned entry or its serialization", () => {
    const poisoned = { toJSON: () => "poisoned" } as unknown as A19Capability;
    let entries: readonly CapabilityInventoryEntry[] = [];

    expect(() => {
      entries = buildCapabilityInventory([
        { capability: "pdf-text", evidence: withEvidence({ operationalBlock: true }) },
        { capability: poisoned, evidence: ALL_ON },
      ]);
    }).toThrow(/capability-state\.unknown_capability/);

    // Nothing is returned, so there is nothing to serialize.
    expect(entries).toEqual([]);
    expect(JSON.stringify(entries)).toBe("[]");
  });
});
