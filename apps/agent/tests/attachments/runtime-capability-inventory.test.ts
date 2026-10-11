/**
 * A19 — runtime capability inventory (issue #107 wiring, TDD).
 *
 * RED against the pre-correction composer: this suite pins the CORRECTED
 * wiring contract, composed from the ACTUAL gate functions of this build
 * (`isUploadFlagEnabled`/`isAttachmentUploadCohortMember`/`getAttachmentStorage`,
 * `isGroqSttAvailable`, `isGroqVisionAvailable`/`isGeminiVisionAvailable` over
 * the SELECTED vision provider, `isPdfTextEnabled`/`pdfTextProcessorOverride`):
 *
 * - the SINK NEVER PROMOTES: the durable observability table carries no
 *   build/deployment provenance, so a `succeeded` row proves at most that SOME
 *   deployment ingested for this (workspace, actor) — never that the CURRENT
 *   generation works. Upload `providerAvailable`/`canaryEvidence` therefore
 *   stay `'unknown'` for ANY sink content: fresh, FUTURE-dated, stale
 *   (previous-deployment, 90d-retained) or scoped to another identity — and
 *   `'unknown'` never derives ACTIVE;
 * - `configurationPresent` is NEVER fabricated: upload = the R2 binding
 *   (`getAttachmentStorage`), stt/vision/pdf-text = the capability's flag
 *   variable being DECLARED in the env (presence of the key, never a parsed
 *   value). Nothing configured ⇒ UNCONFIGURED, not "configured off";
 * - `serverFlagEnabled` is the FLAG, read from a canonical exported FLAG-ONLY
 *   parser, never from the triple lock: `isUploadFlagEnabled` (strict
 *   `=== '1'`), `isPdfTextEnabled` and the exported `isAudioSttFlagEnabled` /
 *   `isVisionFlagEnabled` (trim `=== '1'`; the vision one is SHARED by groq
 *   and gemini). Flag `'1'` ⇒ `true` and flag `'0'` ⇒ `false` REGARDLESS of
 *   credential or cohort — the credential/cohort are never read as the flag;
 *   flag variable ABSENT ⇒ `false` (the gates are default-off);
 *   `configurationPresent` stays an INDEPENDENT key-presence observation, so a
 *   declared-but-off flag still reads CONFIGURED_DISABLED, never UNCONFIGURED;
 * - a SECRET OR BINDING PRESENCE NEVER MEANS A PROVIDER IS FUNCTIONING:
 *   stt/vision have no provider-health sink and upload's sink carries no
 *   generation provenance, so `providerAvailable` is `'unknown'` for all three
 *   even with flag + key + cohort + binding + a fresh scoped success;
 * - PDF stays BLOCKED consistent with the UNCONDITIONAL
 *   `pdfTextProcessorOverride() === undefined` — even with the flag on;
 * - the report carries ONLY closed capability ids, the closed status union
 *   and boolean/`unknown` dimensions — no env name, binding name, secret,
 *   workspace/actor id or free text;
 * - the existing GET keeps its auth/scope/zero-write contract and merely
 *   GAINS a `capabilities` field (no new endpoint, no write path).
 *
 * SQLite REAL (`node:sqlite`) for every sink row: the permissive mock
 * ignores WHERE bindings, so scoping/identity are only provable here.
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntimeCapabilityInventory } from '../../src/attachments/runtime-capability-inventory.js';
import {
  ATTACHMENT_OBSERVABILITY_TABLE,
  emitAttachmentObservabilityEvent,
  initializeAttachmentObservabilitySchema,
} from '../../src/attachments/observability.js';
import type {
  A19Capability,
  CapabilityInventoryEntry,
  CapabilityStatus,
} from '../../src/attachments/capability-state.js';
import { bytesOf, createAttachmentTestAgent, uploadRequest } from './helpers.js';
import { pngBytes } from './fixtures.js';

type SqlShim = {
  exec<T>(query: string, ...bindings: unknown[]): Iterable<T>;
};

const createRealSql = (): { db: DatabaseSync; sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  const sql: SqlShim = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query)) return statement.all(...(bindings as never[])) as T[];
      statement.run(...(bindings as never[]));
      return [] as T[];
    },
  };
  return { db, sql };
};

/** Same shape the observability suite uses: real SQLite on the prototype agent. */
const installRealSql = (agent: object): { db: DatabaseSync; sql: SqlShim } => {
  const { db, sql } = createRealSql();
  Object.defineProperty(agent, 'ctx', {
    value: { storage: { sql, transactionSync: <T>(fn: () => T): T => fn() } },
    configurable: true,
    writable: true,
  });
  return { db, sql };
};

const GATE_ON = {
  extraEnv: { TED_ATTACHMENTS_ENABLED: '1', TED_ATTACHMENTS_COHORT: 'ws-1,actor-1' },
};

const STT_ON = {
  extraEnv: {
    TED_AUDIO_STT_ENABLED: '1',
    GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
    TED_AUDIO_STT_COHORT: 'ws-1,actor-1',
  },
};

const IDENTITY = { workspaceId: 'ws-1', actorId: 'actor-1' } as const;
const BASE_NOW = 1_800_000_000_000;

const entryOf = (
  inventory: readonly CapabilityInventoryEntry[],
  capability: A19Capability,
): CapabilityInventoryEntry => {
  const entry = inventory.find((row) => row.capability === capability);
  if (!entry) throw new Error(`missing capability row: ${capability}`);
  return entry;
};

const uploadEntry = (input: Parameters<typeof buildRuntimeCapabilityInventory>[0]): CapabilityInventoryEntry =>
  entryOf(buildRuntimeCapabilityInventory(input), 'attachments-upload');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A19 runtime wiring — the sink NEVER promotes upload (no generation provenance)', () => {
  it('a FRESH scoped `succeeded` does NOT promote: the row carries no build/deployment identity', () => {
    // RED against the pre-correction composer: it read this exact row as
    // "the current canary is proven" and derived ACTIVE.
    const { agent } = createAttachmentTestAgent(GATE_ON);
    const { sql } = installRealSql(agent);
    initializeAttachmentObservabilitySchema(sql);
    emitAttachmentObservabilityEvent(sql, {
      ...IDENTITY,
      cohort: 'member',
      event: 'succeeded',
      capability: 'image',
      success: true,
      now: BASE_NOW,
    });
    const entry = uploadEntry({ env: agent.env, ...IDENTITY, canarySql: sql, now: BASE_NOW });
    // Both provider dimensions stay the honest 'unknown' ...
    expect(entry.evidence.providerAvailable).toBe('unknown');
    expect(entry.evidence.canaryEvidence).toBe('unknown');
    // ... and an unknown never derives ACTIVE (nor CANARY).
    expect(entry.status).not.toBe('ACTIVE');
    expect(entry.status).not.toBe('CANARY');
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it('a FUTURE-dated success is not fresh (and not provenance either) ⇒ stays unknown', () => {
    // A row written with a clock ahead of the runtime must never read as a
    // current-generation proof — rejected as fresh on both bounds.
    const { agent } = createAttachmentTestAgent(GATE_ON);
    const { sql } = installRealSql(agent);
    initializeAttachmentObservabilitySchema(sql);
    emitAttachmentObservabilityEvent(sql, {
      ...IDENTITY,
      cohort: 'member',
      event: 'succeeded',
      capability: 'image',
      success: true,
      now: BASE_NOW + 2 * 60 * 60 * 1000,
    });
    const entry = uploadEntry({ env: agent.env, ...IDENTITY, canarySql: sql, now: BASE_NOW });
    expect(entry.evidence.canaryEvidence).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
  });

  it('PREVIOUS-deployment evidence never proves the current build: stale + fresh rows alike stay unknown', () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    const { sql } = installRealSql(agent);
    initializeAttachmentObservabilitySchema(sql);
    // A 90d-retained row (survivor of the sink TTL) — a previous deployment.
    emitAttachmentObservabilityEvent(sql, {
      ...IDENTITY,
      cohort: 'member',
      event: 'succeeded',
      capability: 'image',
      success: true,
      now: BASE_NOW - 90 * 24 * 60 * 60 * 1000,
    });
    // Plus an indistinguishable fresh row — still no generation identity.
    emitAttachmentObservabilityEvent(sql, {
      ...IDENTITY,
      cohort: 'member',
      event: 'succeeded',
      capability: 'image',
      success: true,
      now: BASE_NOW,
    });
    const entry = uploadEntry({ env: agent.env, ...IDENTITY, canarySql: sql, now: BASE_NOW });
    expect(entry.evidence.providerAvailable).toBe('unknown');
    expect(entry.evidence.canaryEvidence).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
  });

  it("another workspace/actor's success never counts (scoped, and never promoting)", () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    const { sql } = installRealSql(agent);
    initializeAttachmentObservabilitySchema(sql);
    emitAttachmentObservabilityEvent(sql, { workspaceId: 'ws-2', actorId: 'actor-1', cohort: 'member', event: 'succeeded', capability: 'image', success: true, now: BASE_NOW });
    emitAttachmentObservabilityEvent(sql, { workspaceId: 'ws-1', actorId: 'actor-2', cohort: 'member', event: 'succeeded', capability: 'image', success: true, now: BASE_NOW });
    const entry = uploadEntry({ env: agent.env, ...IDENTITY, canarySql: sql, now: BASE_NOW });
    expect(entry.evidence.canaryEvidence).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
  });

  it('non-terminal events (requested/blocked/cleanup) are not success signals', () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    const { sql } = installRealSql(agent);
    initializeAttachmentObservabilitySchema(sql);
    emitAttachmentObservabilityEvent(sql, { ...IDENTITY, cohort: 'member', event: 'requested', capability: 'image', now: BASE_NOW });
    emitAttachmentObservabilityEvent(sql, { ...IDENTITY, cohort: 'member', event: 'blocked', capability: 'image', success: false, now: BASE_NOW });
    emitAttachmentObservabilityEvent(sql, { ...IDENTITY, cohort: 'member', event: 'cleanup.succeeded', capability: 'cleanup', now: BASE_NOW });
    const entry = uploadEntry({ env: agent.env, ...IDENTITY, canarySql: sql, now: BASE_NOW });
    expect(entry.evidence.canaryEvidence).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
  });

  it('a broken sink never throws and never promotes', () => {
    const broken: SqlShim = {
      exec: () => {
        throw new Error('sqlite down');
      },
    };
    expect(() =>
      uploadEntry({ env: createAttachmentTestAgent(GATE_ON).agent.env, ...IDENTITY, canarySql: broken, now: BASE_NOW }),
    ).not.toThrow();
    const entry = uploadEntry({ env: createAttachmentTestAgent(GATE_ON).agent.env, ...IDENTITY, canarySql: broken, now: BASE_NOW });
    expect(entry.evidence.canaryEvidence).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
  });

  it('a null/undefined sink handle is accepted (call-site contract) and never promotes', () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    for (const canarySql of [null, undefined]) {
      const entry = uploadEntry({ env: agent.env, ...IDENTITY, canarySql, now: BASE_NOW });
      expect(entry.evidence.providerAvailable).toBe('unknown');
      expect(entry.evidence.canaryEvidence).toBe('unknown');
      expect(entry.status).not.toBe('ACTIVE');
    }
  });
});

describe('A19 runtime wiring — attachments-upload', () => {
  it('binding absent ⇒ UNCONFIGURED even with flag on and cohort member', () => {
    const { agent } = createAttachmentTestAgent({ withBucket: false, ...GATE_ON });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'attachments-upload',
    );
    expect(entry.status).toBe('UNCONFIGURED');
    expect(entry.evidence.configurationPresent).toBe(false);
  });

  it('binding present + flag OFF (config divergence) ⇒ CONFIGURED_DISABLED, never ACTIVE', () => {
    const { agent } = createAttachmentTestAgent({
      extraEnv: { TED_ATTACHMENTS_ENABLED: '0', TED_ATTACHMENTS_COHORT: 'ws-1,actor-1' },
    });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'attachments-upload',
    );
    expect(entry.evidence.configurationPresent).toBe(true);
    expect(entry.evidence.serverFlagEnabled).toBe(false);
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it('the canonical strict flag parser decides the flag: whitespace ` 1 ` is OFF', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_ATTACHMENTS_ENABLED: ' 1 ' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'attachments-upload',
    );
    // Exactly `isUploadFlagEnabled` (=== '1', no trim) — never a re-parse.
    expect(entry.evidence.serverFlagEnabled).toBe(false);
  });

  it('flag ON + cohort + binding, WITHOUT any sink promotion ⇒ provider/canary UNKNOWN ⇒ never ACTIVE', () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'attachments-upload',
    );
    expect(entry.evidence.serverFlagEnabled).toBe(true);
    expect(entry.evidence.cohortAuthorized).toBe(true);
    expect(entry.evidence.providerAvailable).toBe('unknown');
    expect(entry.evidence.canaryEvidence).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it('cohort empty (nobody) with flag ON ⇒ CONFIGURED_DISABLED', () => {
    const { agent } = createAttachmentTestAgent({
      extraEnv: { TED_ATTACHMENTS_ENABLED: '1', TED_ATTACHMENTS_COHORT: 'other-ws,other-actor' },
    });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'attachments-upload',
    );
    expect(entry.evidence.cohortAuthorized).toBe(false);
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it('a binding present with the flag variable absent ⇒ CONFIGURED_DISABLED (binding is the config surface, flag is off)', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_ATTACHMENTS_COHORT: 'ws-1,actor-1' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'attachments-upload',
    );
    expect(entry.evidence.configurationPresent).toBe(true);
    expect(entry.evidence.serverFlagEnabled).toBe(false);
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });
});

describe('A19 runtime wiring — configurationPresent is never fabricated', () => {
  it('STT with NOTHING configured ⇒ UNCONFIGURED (not a fabricated "configured off")', () => {
    // RED against the pre-correction composer: it hardcoded the dimension to
    // `true`, so an empty env read as CONFIGURED_DISABLED.
    const { agent } = createAttachmentTestAgent();
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'stt',
    );
    expect(entry.evidence.configurationPresent).toBe(false);
    expect(entry.status).toBe('UNCONFIGURED');
  });

  it('Vision with NOTHING configured ⇒ UNCONFIGURED (same rule, no fabrication)', () => {
    const { agent } = createAttachmentTestAgent();
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'vision',
    );
    expect(entry.evidence.configurationPresent).toBe(false);
    expect(entry.status).toBe('UNCONFIGURED');
  });

  it('STT with the flag variable DECLARED (even OFF) ⇒ configurationPresent true, never fabricated', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_AUDIO_STT_ENABLED: '0' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'stt',
    );
    expect(entry.evidence.configurationPresent).toBe(true);
    expect(entry.status).not.toBe('UNCONFIGURED');
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it('Vision with the flag variable DECLARED ⇒ configurationPresent true', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_VISION_ENABLED: '0' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'vision',
    );
    expect(entry.evidence.configurationPresent).toBe(true);
  });

  it('PDF with the flag variable DECLARED ⇒ configurationPresent true (the block still outranks)', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_PDF_TEXT_ENABLED: '1' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'pdf-text',
    );
    expect(entry.evidence.configurationPresent).toBe(true);
    expect(entry.status).toBe('BLOCKED');
  });
});

describe('A19 runtime wiring — serverFlagEnabled is the FLAG, never the lock', () => {
  it('STT flag on + NO provider credential/cohort ⇒ flag TRUE (the parser answers the flag), cohort false, never ACTIVE', () => {
    // RED against the pre-correction composer: it reported the full triple
    // lock as the flag, so "flag on, no cohort" read as an UNDECIDABLE flag
    // (and a `0` flag with the lock off read the same way). The flag is its
    // own observable fact, read from the canonical flag-only parser.
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_AUDIO_STT_ENABLED: '1' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'stt',
    );
    expect(entry.evidence.configurationPresent).toBe(true);
    expect(entry.evidence.serverFlagEnabled).toBe(true);
    expect(entry.evidence.cohortAuthorized).toBe(false);
    expect(entry.evidence.providerAvailable).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
    expect(entry.status).not.toBe('CANARY');
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it('Vision flag on + NO provider credential/cohort ⇒ flag TRUE, never ACTIVE', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_VISION_ENABLED: '1' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'vision',
    );
    expect(entry.evidence.serverFlagEnabled).toBe(true);
    expect(entry.evidence.cohortAuthorized).toBe(false);
    expect(entry.status).not.toBe('ACTIVE');
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it('STT flag variable absent ⇒ flag proven OFF (default-off gate), not unknown', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { GROQ_API_KEY: 'gsk-live-SECRET-VALUE' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'stt',
    );
    expect(entry.evidence.serverFlagEnabled).toBe(false);
    expect(entry.status).toBe('UNCONFIGURED');
  });

  it('STT: lock ON ⇒ flag proven ON (a sound necessary condition, not the lock read as the flag)', () => {
    const { agent } = createAttachmentTestAgent(STT_ON);
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'stt',
    );
    expect(entry.evidence.serverFlagEnabled).toBe(true);
    expect(entry.evidence.cohortAuthorized).toBe(true);
    // No provider-health sink: the present key never proves functioning.
    expect(entry.evidence.providerAvailable).toBe('unknown');
    expect(entry.evidence.canaryEvidence).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
  });

  it('STT flag + key with EMPTY cohort ⇒ flag TRUE, cohort false (the flag is not the cohort)', () => {
    const { agent } = createAttachmentTestAgent({
      extraEnv: { TED_AUDIO_STT_ENABLED: '1', GROQ_API_KEY: 'gsk-live-SECRET-VALUE', TED_AUDIO_STT_COHORT: '' },
    });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'stt',
    );
    expect(entry.evidence.serverFlagEnabled).toBe(true);
    expect(entry.evidence.cohortAuthorized).toBe(false);
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it('Vision (groq default): flag + key + cohort ⇒ provider/canary UNKNOWN, never ACTIVE', () => {
    const { agent } = createAttachmentTestAgent({
      extraEnv: {
        TED_VISION_ENABLED: '1',
        GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
        TED_VISION_COHORT: 'ws-1,actor-1',
      },
    });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'vision',
    );
    expect(entry.evidence.providerAvailable).toBe('unknown');
    expect(entry.evidence.canaryEvidence).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
  });

  it('Vision (gemini opt-in): the SELECTED provider gate is the one composed', () => {
    const { agent } = createAttachmentTestAgent({
      extraEnv: {
        TED_VISION_PROVIDER: 'gemini',
        TED_VISION_ENABLED: '1',
        GOOGLE_AI_STUDIO_KEY: 'AIza-SECRET-VALUE',
        TED_VISION_COHORT: 'ws-1,actor-1',
      },
    });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'vision',
    );
    expect(entry.evidence.serverFlagEnabled).toBe(true);
    expect(entry.evidence.cohortAuthorized).toBe(true);
    // Gemini key present, no provider-health sink ⇒ still UNKNOWN.
    expect(entry.evidence.providerAvailable).toBe('unknown');
    expect(entry.status).not.toBe('ACTIVE');
  });

  it('STT/Vision cohort empty ⇒ cohortAuthorized false (nobody)', () => {
    const { agent } = createAttachmentTestAgent({
      extraEnv: {
        TED_AUDIO_STT_ENABLED: '1',
        TED_VISION_ENABLED: '1',
        GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
        TED_AUDIO_STT_COHORT: '',
        TED_VISION_COHORT: '',
      },
    });
    const inventory = buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY });
    expect(entryOf(inventory, 'stt').evidence.cohortAuthorized).toBe(false);
    expect(entryOf(inventory, 'vision').evidence.cohortAuthorized).toBe(false);
  });
});

describe('A19 runtime wiring — serverFlagEnabled reads the canonical FLAG parser, not the lock', () => {
  // RED against the pre-correction composer: stt/vision exported no flag-only
  // parser, so the dimension was COMPOSED from the triple lock — a flag `'1'`
  // without credential/cohort read `'unknown'`, a flag `'0'` with the lock off
  // read `'unknown'` too, and only a full lock proved `true`. The flag is its
  // own observable fact: each gate module now exports its exact flag-only
  // parser and the composer reuses it, so `'0'` is a proven OFF and `'1'` a
  // proven ON — with or without credential and cohort.

  const sttEntry = (extraEnv: Record<string, string>): CapabilityInventoryEntry =>
    entryOf(
      buildRuntimeCapabilityInventory({
        env: createAttachmentTestAgent({ extraEnv }).agent.env,
        ...IDENTITY,
      }),
      'stt',
    );

  const visionEntry = (extraEnv: Record<string, string>): CapabilityInventoryEntry =>
    entryOf(
      buildRuntimeCapabilityInventory({
        env: createAttachmentTestAgent({ extraEnv }).agent.env,
        ...IDENTITY,
      }),
      'vision',
    );

  it("STT flag `'0'` ⇒ false EVEN with key + cohort (the lock is not the flag)", () => {
    const entry = sttEntry({
      TED_AUDIO_STT_ENABLED: '0',
      GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
      TED_AUDIO_STT_COHORT: 'ws-1,actor-1',
    });
    expect(entry.evidence.serverFlagEnabled).toBe(false);
    // The cohort predicate is untouched: authorization is its own dimension.
    expect(entry.evidence.cohortAuthorized).toBe(true);
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it("STT flag `'1'` ⇒ true EVEN with NO key and NO cohort", () => {
    const entry = sttEntry({ TED_AUDIO_STT_ENABLED: '1' });
    expect(entry.evidence.serverFlagEnabled).toBe(true);
    expect(entry.evidence.cohortAuthorized).toBe(false);
    // A flag ON never means a provider answers: no probe, no `true`.
    expect(entry.evidence.providerAvailable).toBe('unknown');
    expect(entry.status).toBe('CONFIGURED_DISABLED');
  });

  it("STT flag ABSENT ⇒ false (default-off) even with key + cohort present", () => {
    const entry = sttEntry({
      GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
      TED_AUDIO_STT_COHORT: 'ws-1,actor-1',
    });
    expect(entry.evidence.serverFlagEnabled).toBe(false);
    expect(entry.evidence.configurationPresent).toBe(false);
    expect(entry.status).toBe('UNCONFIGURED');
  });

  it("STT flag whitespace `' 1 '` ⇒ true and `' 0 '` ⇒ false (the canonical trim parser)", () => {
    expect(sttEntry({ TED_AUDIO_STT_ENABLED: ' 1 ' }).evidence.serverFlagEnabled).toBe(true);
    expect(sttEntry({ TED_AUDIO_STT_ENABLED: ' 0 ' }).evidence.serverFlagEnabled).toBe(false);
  });

  it("STT flag `'true'`/empty ⇒ false (only `1` is ON)", () => {
    expect(sttEntry({ TED_AUDIO_STT_ENABLED: 'true' }).evidence.serverFlagEnabled).toBe(false);
    expect(sttEntry({ TED_AUDIO_STT_ENABLED: '' }).evidence.serverFlagEnabled).toBe(false);
  });

  it("Vision (groq default): `'1'` ⇒ true / `'0'` ⇒ false, independent of key and cohort", () => {
    expect(visionEntry({ TED_VISION_ENABLED: '1' }).evidence.serverFlagEnabled).toBe(true);
    expect(
      visionEntry({
        TED_VISION_ENABLED: '0',
        GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
        TED_VISION_COHORT: 'ws-1,actor-1',
      }).evidence.serverFlagEnabled,
    ).toBe(false);
  });

  it("Vision (gemini opt-in): the SAME canonical parser answers the flag", () => {
    const gemini = (flag: string): CapabilityInventoryEntry =>
      visionEntry({
        TED_VISION_PROVIDER: 'gemini',
        TED_VISION_ENABLED: flag,
        GOOGLE_AI_STUDIO_KEY: 'AIza-SECRET-VALUE',
        TED_VISION_COHORT: 'ws-1,actor-1',
      });
    expect(gemini('1').evidence.serverFlagEnabled).toBe(true);
    expect(gemini('0').evidence.serverFlagEnabled).toBe(false);
    expect(gemini('').evidence.serverFlagEnabled).toBe(false);
    // Selecting the provider never turns the flag on by itself.
    expect(
      visionEntry({
        TED_VISION_PROVIDER: 'gemini',
        GOOGLE_AI_STUDIO_KEY: 'AIza-SECRET-VALUE',
        TED_VISION_COHORT: 'ws-1,actor-1',
      }).evidence.serverFlagEnabled,
    ).toBe(false);
  });

  it('configurationPresent stays INDEPENDENT of the flag value (declared-but-off is still configured)', () => {
    expect(sttEntry({ TED_AUDIO_STT_ENABLED: '0' }).evidence.configurationPresent).toBe(true);
    expect(sttEntry({ TED_AUDIO_STT_ENABLED: '1' }).evidence.configurationPresent).toBe(true);
    expect(sttEntry({ TED_AUDIO_STT_ENABLED: '' }).evidence.configurationPresent).toBe(true);
    expect(sttEntry({ GROQ_API_KEY: 'gsk-live-SECRET-VALUE' }).evidence.configurationPresent).toBe(false);
  });

  it("providerAvailable stays 'unknown' without a health probe (flag on + key + cohort + binding)", () => {
    // RED against the reading that composed the flag from the lock: the lock
    // being ON is not a provider-health signal either — nothing in this build
    // probes the provider, so the dimension stays the honest 'unknown'.
    const { agent } = createAttachmentTestAgent({
      extraEnv: {
        TED_AUDIO_STT_ENABLED: '1',
        GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
        TED_AUDIO_STT_COHORT: '*',
        TED_VISION_ENABLED: '1',
        TED_VISION_COHORT: '*',
      },
    });
    const inventory = buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY });
    expect(entryOf(inventory, 'stt').evidence.providerAvailable).toBe('unknown');
    expect(entryOf(inventory, 'vision').evidence.providerAvailable).toBe('unknown');
    expect(entryOf(inventory, 'stt').status).toBe('CONFIGURED_DISABLED');
    expect(entryOf(inventory, 'vision').status).toBe('CONFIGURED_DISABLED');
  });

  it('a flag never becomes a secret, an env name or a credential in the report', () => {
    const { agent } = createAttachmentTestAgent({
      extraEnv: {
        TED_AUDIO_STT_ENABLED: '1',
        TED_VISION_ENABLED: '1',
        GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
        GOOGLE_AI_STUDIO_KEY: 'AIza-SECRET-VALUE',
        TED_VISION_COHORT: 'ws-1,actor-1',
      },
    });
    const serialized = JSON.stringify(buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }));
    for (const forbidden of ['TED_AUDIO_STT_ENABLED', 'TED_VISION_ENABLED', 'gsk-live-SECRET-VALUE', 'AIza-SECRET-VALUE']) {
      expect(serialized).not.toContain(forbidden);
    }
    // Only the closed dimension vocabulary: booleans and 'unknown'.
    expect(serialized).toContain('"serverFlagEnabled":true');
    expect(serialized).not.toContain('"serverFlagEnabled":"unknown"');
  });
});

describe('A19 runtime wiring — PDF blocked consistent with the unconditional override', () => {
  it('flag ON (config) ⇒ still BLOCKED: no code path enables the parser', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_PDF_TEXT_ENABLED: '1' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'pdf-text',
    );
    // The DECLARED config says on; the OBSERVED runtime says blocked.
    expect(entry.evidence.serverFlagEnabled).toBe(true);
    expect(entry.evidence.operationalBlock).toBe(true);
    expect(entry.status).toBe('BLOCKED');
  });

  it('flag OFF ⇒ BLOCKED too (the block is unconditional, not config-derived)', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_PDF_TEXT_ENABLED: '0' } });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'pdf-text',
    );
    expect(entry.evidence.configurationPresent).toBe(true);
    expect(entry.evidence.serverFlagEnabled).toBe(false);
    expect(entry.status).toBe('BLOCKED');
  });

  it('a NON-STRING flag value is TOTAL: numeric `1` never throws, reads OFF, stays BLOCKED', () => {
    // RED against the string-only canonical parser: `raw.trim()` over a
    // NON-STRING env value throws a TypeError straight out of the inventory
    // builder, so the A19 report was NOT total over a misconfigured
    // deployment that injects the flag as a number (or boolean/object).
    const { agent } = createAttachmentTestAgent({
      extraEnv: { TED_PDF_TEXT_ENABLED: 1 as unknown as string },
    });
    expect(() => buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY })).not.toThrow();
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'pdf-text',
    );
    // The key is still DECLARED (a presence fact, never a parsed value) ...
    expect(entry.evidence.configurationPresent).toBe(true);
    // ... but a non-string value never reads ON: fail-closed like any other
    // value that is not exactly '1' — never a crash, never a promotion.
    expect(entry.evidence.serverFlagEnabled).toBe(false);
    expect(entry.status).toBe('BLOCKED');
  });

  it('nothing configured at all ⇒ BLOCKED with configurationPresent false (block outranks, presence never fabricated)', () => {
    const { agent } = createAttachmentTestAgent({ withBucket: false });
    const entry = entryOf(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
      'pdf-text',
    );
    expect(entry.evidence.configurationPresent).toBe(false);
    expect(entry.evidence.operationalBlock).toBe(true);
    expect(entry.status).toBe('BLOCKED');
  });
});

describe('A19 runtime wiring — an UNKNOWN dimension never derives ACTIVE', () => {
  it('maximal env + a fresh scoped sink success ⇒ NO capability is ACTIVE', () => {
    // RED against the pre-correction composer: this exact shape derived
    // ACTIVE for upload from the provenance-less sink row.
    const { agent } = createAttachmentTestAgent({
      extraEnv: {
        TED_ATTACHMENTS_ENABLED: '1',
        TED_ATTACHMENTS_COHORT: '*',
        TED_AUDIO_STT_ENABLED: '1',
        TED_AUDIO_STT_COHORT: '*',
        GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
        TED_VISION_ENABLED: '1',
        TED_VISION_COHORT: '*',
        TED_PDF_TEXT_ENABLED: '1',
      },
    });
    const { sql } = installRealSql(agent);
    initializeAttachmentObservabilitySchema(sql);
    emitAttachmentObservabilityEvent(sql, {
      ...IDENTITY,
      cohort: 'member',
      event: 'succeeded',
      capability: 'image',
      success: true,
      now: BASE_NOW,
    });
    const inventory = buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY, canarySql: sql, now: BASE_NOW });
    for (const entry of inventory) {
      expect(entry.status).not.toBe('ACTIVE');
      expect(entry.status).not.toBe('CANARY');
    }
    expect(entryOf(inventory, 'attachments-upload').status).toBe('CONFIGURED_DISABLED');
    expect(entryOf(inventory, 'attachments-upload').evidence.canaryEvidence).toBe('unknown');
    expect(entryOf(inventory, 'stt').status).toBe('CONFIGURED_DISABLED');
    expect(entryOf(inventory, 'vision').status).toBe('CONFIGURED_DISABLED');
    expect(entryOf(inventory, 'pdf-text').status).toBe('BLOCKED');
  });
});

describe('A19 runtime wiring — closed/leak-proof report', () => {
  it('carries ONLY the four closed capability ids and the five-state union', () => {
    const { agent } = createAttachmentTestAgent({ ...GATE_ON, ...STT_ON });
    const inventory = buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY });
    expect(inventory.map((entry) => entry.capability)).toEqual([
      'attachments-upload',
      'stt',
      'vision',
      'pdf-text',
    ]);
    const statuses: readonly CapabilityStatus[] = [
      'UNCONFIGURED',
      'CONFIGURED_DISABLED',
      'CANARY',
      'ACTIVE',
      'BLOCKED',
    ];
    for (const entry of inventory) expect(statuses).toContain(entry.status);
  });

  it('no env name, binding name, secret, workspace/actor id or free text travels', () => {
    const { agent } = createAttachmentTestAgent({
      extraEnv: {
        TED_ATTACHMENTS_ENABLED: '1',
        TED_ATTACHMENTS_COHORT: 'ws-1,actor-1',
        TED_AUDIO_STT_ENABLED: '1',
        TED_AUDIO_STT_COHORT: 'ws-1,actor-1',
        TED_VISION_ENABLED: '1',
        TED_VISION_PROVIDER: 'gemini',
        TED_VISION_COHORT: 'ws-1,actor-1',
        TED_PDF_TEXT_ENABLED: '1',
        GROQ_API_KEY: 'gsk-live-SECRET-VALUE',
        GOOGLE_AI_STUDIO_KEY: 'AIza-SECRET-VALUE',
      },
    });
    const serialized = JSON.stringify(
      buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY }),
    );
    for (const forbidden of [
      'GROQ_API_KEY',
      'GOOGLE_AI_STUDIO_KEY',
      'TED_ATTACHMENTS_BUCKET',
      'TED_ATTACHMENTS_ENABLED',
      'TED_ATTACHMENTS_COHORT',
      'TED_AUDIO_STT_ENABLED',
      'TED_AUDIO_STT_COHORT',
      'TED_VISION_ENABLED',
      'TED_VISION_COHORT',
      'TED_VISION_PROVIDER',
      'TED_PDF_TEXT_ENABLED',
      'gsk-live-SECRET-VALUE',
      'AIza-SECRET-VALUE',
      'config-test-token',
      'api.test.local',
      'ws-1',
      'actor-1',
      'gemini',
      'secret',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Only the closed vocabulary survives.
    expect(serialized).not.toContain('unknown_capability');
  });

  it('an unusable env value never derails the build (pure failure-closed dimensions)', () => {
    const { agent } = createAttachmentTestAgent({ extraEnv: { TED_ATTACHMENTS_ENABLED: ' 1 ' } });
    const inventory = buildRuntimeCapabilityInventory({ env: agent.env, ...IDENTITY });
    expect(entryOf(inventory, 'attachments-upload').evidence.serverFlagEnabled).toBe(false);
  });

  it('a missing/!object env is TOTAL: never throws, everything fails closed', () => {
    for (const env of [null, undefined, 'not-an-object', 42]) {
      const inventory = buildRuntimeCapabilityInventory({ env, ...IDENTITY });
      expect(inventory.map((entry) => entry.capability)).toEqual([
        'attachments-upload',
        'stt',
        'vision',
        'pdf-text',
      ]);
      expect(entryOf(inventory, 'attachments-upload').evidence.configurationPresent).toBe(false);
      expect(entryOf(inventory, 'stt').evidence.configurationPresent).toBe(false);
      expect(entryOf(inventory, 'vision').evidence.configurationPresent).toBe(false);
      // PDF's override is unconditional: the block is the observable fact.
      expect(entryOf(inventory, 'pdf-text').status).toBe('BLOCKED');
    }
  });
});

describe('A19 runtime wiring — GET /rpc/attachments/observability (existing endpoint)', () => {
  const get = (agent: {
    fetch: (request: Request) => Promise<Response>;
  }, actorId = 'actor-1'): Promise<Response> =>
    agent.fetch(
      new Request('https://agent.test.local/rpc/attachments/observability', {
        headers: { 'x-agent-actor': actorId, 'x-agent-workspace': 'ws-1' },
      }),
    );

  it('200 keeps the existing baseline/cohort contract AND adds the capability inventory', async () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    const { sql } = installRealSql(agent);
    initializeAttachmentObservabilitySchema(sql);
    emitAttachmentObservabilityEvent(sql, { workspaceId: 'ws-1', actorId: 'actor-1', cohort: 'member', event: 'succeeded', capability: 'image', success: true, now: Date.now() });
    const res = await get(agent);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      cohort: string;
      baseline: { total: number };
      capabilities: readonly { capability: string; status: string }[];
    };
    expect(body.workspaceId).toBe('ws-1');
    expect(body.cohort).toBe('member');
    expect(body.baseline.total).toBe(1);
    expect(body.capabilities.map((entry) => entry.capability)).toEqual([
      'attachments-upload',
      'stt',
      'vision',
      'pdf-text',
    ]);
    // The capability report is closed and leak-proof.
    const serialized = JSON.stringify(body.capabilities);
    expect(serialized).not.toContain('gsk');
    expect(serialized).not.toContain('TED_');
    expect(serialized).not.toContain('ws-1');
  });

  it('a real fresh upload in the sink does NOT make the scoped upload ACTIVE (no generation provenance)', async () => {
    // RED against the pre-correction composer: this exact live flow derived
    // ACTIVE for upload from the provenance-less sink row.
    const { agent } = createAttachmentTestAgent(GATE_ON);
    installRealSql(agent);
    const up = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(8, 8)), { 'x-ted-attachment-kind': 'image', 'x-ted-attachment-name': 'a.png' }),
    );
    expect(up.status).toBe(200);
    const res = await get(agent);
    const body = (await res.json()) as {
      capabilities: readonly { capability: string; status: string; evidence: Record<string, unknown> }[];
    };
    const upload = body.capabilities.find((entry) => entry.capability === 'attachments-upload');
    expect(upload?.evidence.canaryEvidence).toBe('unknown');
    expect(upload?.evidence.providerAvailable).toBe('unknown');
    expect(upload?.status).not.toBe('ACTIVE');
  });

  it('scope: a success by actor-2 does not promote actor-1 (canary stays unknown)', async () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    const { sql } = installRealSql(agent);
    initializeAttachmentObservabilitySchema(sql);
    emitAttachmentObservabilityEvent(sql, { workspaceId: 'ws-1', actorId: 'actor-2', cohort: 'member', event: 'succeeded', capability: 'image', success: true, now: Date.now() });
    const res = await get(agent);
    const body = (await res.json()) as {
      capabilities: readonly { capability: string; status: string; evidence: Record<string, unknown> }[];
    };
    const upload = body.capabilities.find((entry) => entry.capability === 'attachments-upload');
    expect(upload?.evidence.canaryEvidence).toBe('unknown');
    expect(upload?.status).not.toBe('ACTIVE');
  });

  it('an OLD success is not proof: a 90d-retained stale row leaves canary unknown', async () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    const { sql } = installRealSql(agent);
    initializeAttachmentObservabilitySchema(sql);
    emitAttachmentObservabilityEvent(sql, {
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      cohort: 'member',
      event: 'succeeded',
      capability: 'image',
      success: true,
      now: Date.now() - 90 * 24 * 60 * 60 * 1000,
    });
    const res = await get(agent);
    const body = (await res.json()) as {
      capabilities: readonly { capability: string; status: string; evidence: Record<string, unknown> }[];
    };
    const upload = body.capabilities.find((entry) => entry.capability === 'attachments-upload');
    expect(upload?.evidence.canaryEvidence).toBe('unknown');
    expect(upload?.status).not.toBe('ACTIVE');
  });

  it('unauthenticated GET still 401 (behavior preserved)', async () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    installRealSql(agent);
    const res = await agent.fetch(new Request('https://agent.test.local/rpc/attachments/observability'));
    expect(res.status).toBe(401);
  });

  it('broken sink still 503 agent.observability_unavailable (behavior preserved)', async () => {
    const { agent } = createAttachmentTestAgent(GATE_ON);
    Object.defineProperty(agent, 'ctx', {
      value: {
        storage: {
          sql: {
            exec: () => {
              throw new Error('sink down');
            },
          },
          transactionSync: <T>(fn: () => T): T => fn(),
        },
      },
      configurable: true,
      writable: true,
    });
    const res = await get(agent);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('agent.observability_unavailable');
  });

  it('the GET is read-only: zero writes to the sink and zero mutations to the bucket', async () => {
    const { agent, bucket } = createAttachmentTestAgent(GATE_ON);
    const { sql } = installRealSql(agent);
    // Seed THROUGH the shim the endpoint itself reads (never the raw
    // `DatabaseSync` handle): the shim is the adapter production uses, so the
    // seeding path is exercised end-to-end — and a silent seeding failure
    // (sink down, shim that drops the write) must fail the test instead of
    // leaving an empty "before" that would make the comparison vacuous.
    expect(initializeAttachmentObservabilitySchema(sql)).toBe(true);
    expect(
      emitAttachmentObservabilityEvent(sql, {
        workspaceId: 'ws-1',
        actorId: 'actor-1',
        cohort: 'member',
        event: 'succeeded',
        capability: 'image',
        success: true,
        now: Date.now(),
      }),
    ).toBe(true);
    const readSink = (): Array<Record<string, unknown>> => [
      ...sql.exec<Record<string, unknown>>(
        `SELECT * FROM ${ATTACHMENT_OBSERVABILITY_TABLE} ORDER BY id`,
      ),
    ];
    const before = readSink();
    // Non-vacuous by construction: the sink really carries the seeded row.
    expect(before.length).toBeGreaterThan(0);

    // Observe EVERY statement the endpoint attempts during the GET. A
    // COUNT-ONLY comparison cannot see an in-place row rewrite (the count is
    // unchanged), so read-only is asserted directly: zero data-mutating
    // statements, and the only DDL tolerated is the endpoint's own one-time
    // idempotent schema init (`IF NOT EXISTS`).
    const observed: string[] = [];
    const storage = (agent as unknown as { ctx: { storage: { sql: SqlShim } } }).ctx.storage;
    storage.sql = {
      exec: <T>(query: string, ...bindings: unknown[]): Iterable<T> => {
        observed.push(query);
        return sql.exec<T>(query, ...bindings);
      },
    };

    const res = await get(agent);
    expect(res.status).toBe(200);

    const dataMutations = observed.filter((query) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query));
    expect(dataMutations).toEqual([]);
    for (const ddl of observed.filter((query) => /^\s*(CREATE|DROP|ALTER)\b/i.test(query))) {
      expect(ddl).toMatch(/IF NOT EXISTS/i);
    }
    // FULL-ROW snapshot, not a count: an in-place UPDATE (or a delete+insert)
    // changes the rows even when the row COUNT would stay identical.
    expect(readSink()).toEqual(before);
    expect(bucket.objects.size).toBe(0);
  });
});
