/**
 * F2-A structured interpretation — deterministic TDD tests.
 *
 * Scope: pure adapter over ALREADY-RETURNED LLM JSON. No provider client, no
 * fetch, no DB, no execution, no receipts. Every negative oracle below must
 * throw a typed `StructuredInterpretationError` and never execute anything.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TED_APPROVAL_TOOLS } from '@pi-finance/llm-contracts/types';
import { describe, expect, it } from 'vitest';
import type { MutationDraftResolvedArgs } from '../../src/mutations/mutation-draft.js';
import {
  ALLOWED_OPERATIONS,
  DRAFT_ARG_KEYS,
  MUTATION_OPERATIONS,
  OPERATION_ARG_KEYS,
  READ_OPERATION_NAMES,
  getArgSpec,
  hasOperationArgSchema,
} from '../../src/poc-structured/registry.js';
import * as structuredModule from '../../src/poc-structured/structured-interpretation.js';
import {
  STRUCTURED_LIMITS,
  StructuredInterpretationError,
  parseStructuredLLMOutput,
  toCandidate,
  type StructuredInterpretationReason,
} from '../../src/poc-structured/structured-interpretation.js';

const wrap = (interpretation: unknown): string => JSON.stringify({ interpretation });

const base = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  intent: 'read',
  operation: 'get_month_summary',
  args: { yearMonth: '2026-10' },
  contextProvenance: { origin: 'local-fixture', corpusId: 'LOCAL-X' },
  entities: [],
  ambiguities: [],
  clarification: null,
  missingFields: [],
  ...overrides,
});

const expectReason = (fn: () => unknown, reason: StructuredInterpretationReason): void => {
  let captured: unknown;
  try {
    fn();
  } catch (error) {
    captured = error;
  }
  expect(captured, `expected throw ${reason}`).toBeInstanceOf(StructuredInterpretationError);
  const typed = captured as StructuredInterpretationError;
  expect(typed.code).toBe('agent.invalid_structured_interpretation');
  expect(typed.reason).toBe(reason);
};

describe('F2-A structured interpretation adapter', () => {
  it('RED-01: parses an already-returned read interpretation (F1-B002 shape)', () => {
    const parsed = parseStructuredLLMOutput(
      wrap({
        intent: 'read',
        operation: 'get_month_summary',
        args: { yearMonth: '2026-10' },
        contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B002' },
        entities: [{ kind: 'period', value: '2026-10', provenance: 'corpus-context' }],
        ambiguities: [],
        clarification: null,
        missingFields: [],
      }),
    );
    expect(parsed.intent).toBe('read');
    expect(parsed.operation).toBe('get_month_summary');
    expect(parsed.args).toEqual({ yearMonth: '2026-10' });
    expect(parsed.clarification).toBeNull();
    expect(parsed.missingFields).toEqual([]);
    expect(toCandidate(parsed).contextProvenance).toEqual(parsed.contextProvenance);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.args)).toBe(true);
    expect(Object.isFrozen(parsed.entities)).toBe(true);
    expect(toCandidate(parsed).operation).toBe('get_month_summary');
  });

  it('RED-F2A1: represents clarify explicitly with bounded missing fields, not an executable op', () => {
    const parsed = parseStructuredLLMOutput(wrap(base({
      intent: 'clarify', operation: 'none', args: {}, missingFields: ['period'],
      ambiguities: [], clarification: 'Qual período?',
    })));
    expect(parsed.intent).toBe('clarify');
    expect(parsed.operation).toBe('none');
    expect(parsed.missingFields).toEqual(['period']);
  });

  it('keeps unsupported budget creation as semantic requestedAction, never as operation', () => {
    const parsed = parseStructuredLLMOutput(wrap(base({
      intent: 'unsupported', operation: 'none', args: {}, requestedAction: 'budgets.create',
      clarification: 'Não é possível criar orçamentos.',
    })));
    expect(parsed.requestedAction).toBe('budgets.create');
    expect(parsed.operation).toBe('none');
    expectReason(() => parseStructuredLLMOutput(wrap(base({ requestedAction: 'invented.execute' }))), 'invalid-operation');
  });

  it('RED-02: accepts only the strict { interpretation } envelope (object or JSON string)', () => {
    expect(parseStructuredLLMOutput(wrap(base())).intent).toBe('read');
    expect(parseStructuredLLMOutput(JSON.stringify({ interpretation: base() })).intent).toBe('read');
    // A bare record is no longer an accepted envelope.
    expectReason(() => parseStructuredLLMOutput(base()), 'wrapper-shape');
    // Sibling keys, wrong casing and nested wrappers are rejected.
    expectReason(
      () => parseStructuredLLMOutput({ interpretation: base(), extra: true }),
      'wrapper-shape',
    );
    expectReason(() => parseStructuredLLMOutput({ Interpretation: base() }), 'wrapper-shape');
    // A nested wrapper is still not a valid interpretation record: its
    // required fields are absent, so parsing stops at the first missing field.
    expectReason(
      () => parseStructuredLLMOutput({ interpretation: { interpretation: base() } }),
      'invalid-intent',
    );
  });

  it('NEG-01: malformed payloads are typed errors (non-JSON string, array, null, empty)', () => {
    const cases: readonly [unknown, StructuredInterpretationReason][] = [
      ['not-json{{{', 'malformed-payload'],
      ['', 'malformed-payload'],
      ['[]', 'wrapper-shape'],
      ['null', 'wrapper-shape'],
      ['42', 'wrapper-shape'],
      [null, 'wrapper-shape'],
      [undefined, 'wrapper-shape'],
      [42, 'wrapper-shape'],
      [[], 'wrapper-shape'],
    ];
    for (const [bad, reason] of cases) {
      expectReason(() => parseStructuredLLMOutput(bad), reason);
    }
  });

  it('NEG-02: unknown operations are rejected — no guessing', () => {
    expectReason(
      () => parseStructuredLLMOutput(wrap(base({ operation: 'transactions.time_travel' }))),
      'invalid-operation',
    );
    expect([...ALLOWED_OPERATIONS]).not.toContain('transactions.time_travel');
  });

  it('NEG-03: intent/operation coherence is enforced in both directions', () => {
    expectReason(
      () =>
        parseStructuredLLMOutput(
          wrap(
            base({
              intent: 'read',
              operation: 'transactions.expense.create',
              args: { amountCents: 5000 },
            }),
          ),
        ),
      'intent-operation-mismatch',
    );
    expectReason(
      () =>
        parseStructuredLLMOutput(
          wrap(base({ intent: 'mutation-proposal', operation: 'none', args: {} })),
        ),
      'intent-operation-mismatch',
    );
    expectReason(
      () =>
        parseStructuredLLMOutput(
          wrap(
            base({
              intent: 'conversation',
              operation: 'get_month_summary',
              args: { yearMonth: '2026-10' },
            }),
          ),
        ),
      'intent-operation-mismatch',
    );
  });

  it('RED-03: canonical mutation operations parse with canonical draft args', () => {
    const cases: readonly { operation: string; args: Record<string, unknown> }[] = [
      { operation: 'transactions.expense.create', args: { amountCents: 5000, description: 'carne' } },
      { operation: 'transactions.income.create', args: { amountCents: 20000, description: 'salário' } },
      {
        operation: 'transactions.update',
        args: {
          transactionId: 't-1',
          expectedDescription: 'carne',
          description: 'carne bovina',
          amountCents: 7500,
        },
      },
      {
        operation: 'accounts.create',
        args: { accountName: 'Nubank', accountKind: 'bank', initialBalanceCents: -500 },
      },
      {
        operation: 'accounts.update',
        args: { accountId: 'a-1', expectedName: 'Aurora', accountName: 'Reserva' },
      },
      { operation: 'accounts.deactivate', args: { accountId: 'a-1', expectedName: 'Aurora' } },
      {
        operation: 'categories.create',
        args: { categoryName: 'Viagem', categoryKind: 'expense', requiresParent: false },
      },
      {
        operation: 'categories.update',
        args: { categoryId: 'c-1', expectedName: 'Mercado', categoryName: 'Feira' },
      },
      { operation: 'categories.deactivate', args: { categoryId: 'c-1', expectedName: 'Feira' } },
    ];
    for (const testCase of cases) {
      const parsed = parseStructuredLLMOutput(
        wrap(base({ intent: 'mutation-proposal', ...testCase })),
      );
      expect(parsed.operation).toBe(testCase.operation);
      expect(parsed.args).toEqual(testCase.args);
    }
    // The POC argument vocabulary is a compile-time subset of the canonical
    // draft contract (drift breaks tsc) and the ops are the canonical import.
    const draftKeys: readonly (keyof MutationDraftResolvedArgs)[] = DRAFT_ARG_KEYS;
    expect(draftKeys).toHaveLength(DRAFT_ARG_KEYS.length);
    expect([...MUTATION_OPERATIONS]).toEqual([...TED_APPROVAL_TOOLS]);
  });

  it('RED-05: every canonical mutation op has an arg schema; lookups are own-property', () => {
    // Parity: a canonical approval op without a closed arg schema would accept
    // an incoherent interpretation (nothing to validate args against).
    for (const operation of TED_APPROVAL_TOOLS) {
      expect(hasOperationArgSchema(operation), operation).toBe(true);
      expect(OPERATION_ARG_KEYS[operation]?.size, operation).toBeGreaterThan(0);
    }
    // Every accepted argument key has an own ARG_SPECS entry, in every op.
    for (const [operation, keys] of Object.entries(OPERATION_ARG_KEYS)) {
      for (const key of keys) {
        expect(getArgSpec(key), `${operation}:${key}`).toBeDefined();
      }
    }
    // Prototype members are NOT argument vocabulary (own-property lookups).
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(getArgSpec(key), key).toBeUndefined();
      expect(hasOperationArgSchema(key), key).toBe(false);
      expectReason(
        () => parseStructuredLLMOutput(wrap(base({ args: { [key]: 'x' } }))),
        'args-unknown-key',
      );
    }
  });

  it('RED-04: read mirror still matches production OPERATION_TO_READ keys', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../src/orchestration/channel-evidence.ts'),
      'utf8',
    );
    const block = source.slice(
      source.indexOf('const OPERATION_TO_READ: Record<string, ReadKind> = {'),
      source.indexOf('/** Domain fallback when no planned operation maps to a read.'),
    );
    const productionKeys = [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]);
    expect(productionKeys.length).toBeGreaterThan(0);
    expect([...READ_OPERATION_NAMES].sort()).toEqual([...productionKeys].sort());
  });

  it('NEG-04: args must be appropriate for the operation (no cross-operation drift)', () => {
    expectReason(
      () =>
        parseStructuredLLMOutput(
          wrap(
            base({
              intent: 'mutation-proposal',
              operation: 'accounts.update',
              args: { accountId: 'a-1', amountCents: 100 },
            }),
          ),
        ),
      'args-not-allowed-for-operation',
    );
    expectReason(
      () =>
        parseStructuredLLMOutput(
          wrap(base({ intent: 'read', operation: 'list_recent_transactions', args: { description: 'x' } })),
        ),
      'args-not-allowed-for-operation',
    );
    expectReason(
      () => parseStructuredLLMOutput(wrap(base({ intent: 'conversation', operation: 'none', args: { date: '2026-10-01' } }))),
      'operation-args-inappropriate',
    );
  });

  it('NEG-05: args are flat primitives with strict value shapes (cents integers)', () => {
    expectReason(
      () => parseStructuredLLMOutput(wrap(base({ args: { yearMonth: ['2026-10'] } }))),
      'args-value-shape',
    );
    for (const amountCents of ['5000', 50.5, -5]) {
      expectReason(
        () =>
          parseStructuredLLMOutput(
            wrap(
              base({
                intent: 'mutation-proposal',
                operation: 'transactions.expense.create',
                args: { amountCents, description: 'carne' },
              }),
            ),
          ),
        'args-value-shape',
      );
    }
    expectReason(
      () =>
        parseStructuredLLMOutput(
          wrap(
            base({
              intent: 'mutation-proposal',
              operation: 'accounts.create',
              args: { accountName: 'X', accountKind: 'credit_card' },
            }),
          ),
        ),
      'args-value-shape',
    );
    expectReason(
      () =>
        parseStructuredLLMOutput(
          wrap(
            base({
              intent: 'mutation-proposal',
              operation: 'categories.create',
              args: { categoryName: 'X', categoryKind: 'transfer' },
            }),
          ),
        ),
      'args-value-shape',
    );
    // Calendar validity is real, not regex-only.
    for (const date of ['2026-02-30', '2026-13-01', '20261001']) {
      expectReason(
        () =>
          parseStructuredLLMOutput(
            wrap(
              base({
                intent: 'mutation-proposal',
                operation: 'transactions.expense.create',
                args: { amountCents: 100, description: 'x', date },
              }),
            ),
          ),
        'args-value-shape',
      );
    }
    const leap = parseStructuredLLMOutput(
      wrap(
        base({
          intent: 'mutation-proposal',
          operation: 'transactions.expense.create',
          args: { amountCents: 100, description: 'x', date: '2024-02-29' },
        }),
      ),
    );
    expect(leap.args.date).toBe('2024-02-29');
  });

  it('NEG-06: authority/receipt/credential keys are rejected at every depth, normalized', () => {
    for (const key of [
      'capability',
      'workspaceId',
      'actorId',
      'idempotencyKey',
      'attestation',
      'writeAuthorized',
      'write_authorized',
      'Write-Authorized',
      'WRITEAUTHORIZED',
      'Idempotency-Key',
      'auto_execute',
      'approval',
      'token',
    ]) {
      expectReason(
        () => parseStructuredLLMOutput(wrap(base({ [key]: 'injected' }))),
        'forbidden-authority-key',
      );
    }
    expectReason(
      () => parseStructuredLLMOutput(wrap(base({ args: { yearMonth: '2026-10', receipt: { operationId: 'x' } } }))),
      'forbidden-authority-key',
    );
    expectReason(
      () =>
        parseStructuredLLMOutput(
          wrap(
            base({
              entities: [{ kind: 'period', value: '2026-10', provenance: 'utterance', approval: true }],
            }),
          ),
        ),
      'forbidden-authority-key',
    );
    expectReason(
      () =>
        parseStructuredLLMOutput(
          wrap(base({ contextProvenance: { origin: 'local-fixture', corpusId: 'LOCAL-X', workspaceId: 'w' } })),
        ),
      'forbidden-authority-key',
    );
  });

  it('NEG-07: serialized size and nesting depth are bounded', () => {
    const huge = parseStructuredLLMOutput;
    expectReason(
      () =>
        huge(
          wrap(
            base({
              ambiguities: ['x'],
              clarification: 'a'.repeat(STRUCTURED_LIMITS.maxSerializedBytes),
            }),
          ),
        ),
      'max-size',
    );
    let nested: unknown = 'x';
    for (let index = 0; index < 12; index += 1) nested = { nested };
    expectReason(
      () => huge(wrap(base({ args: { yearMonth: nested } }))),
      'max-depth',
    );
    // Raw input bytes are bounded even when the parsed tree would be small.
    expectReason(
      () => huge(`${' '.repeat(STRUCTURED_LIMITS.maxSerializedBytes)}${wrap(base())}`),
      'max-size',
    );
    expectReason(
      () => huge(wrap(base({ args: { madeUpSlot: 1 } }))),
      'args-unknown-key',
    );
  });

  it('NEG-08: clarification and ambiguity can be independent; missing-field vocabulary is closed', () => {
    expect(parseStructuredLLMOutput(wrap(base({ missingFields: ['account'], clarification: null }))).missingFields).toEqual(['account']);
    expectReason(() => parseStructuredLLMOutput(wrap(base({ missingFields: ['invented'] }))), 'invalid-missing-fields');
    expect(parseStructuredLLMOutput(wrap(base({ ambiguities: [], clarification: 'Qual conta?' }))).clarification).toBe('Qual conta?');
    expectReason(
      () => parseStructuredLLMOutput(wrap(base({ ambiguities: ['account'], clarification: '   ' }))),
      'invalid-clarification',
    );
  });

  it('NEG-09: provenance, entities and unknown fields are closed', () => {
    expectReason(
      () => parseStructuredLLMOutput(wrap(base({ contextProvenance: { origin: 'web', corpusId: 'LOCAL-X' } }))),
      'invalid-provenance',
    );
    expectReason(
      () => parseStructuredLLMOutput(wrap(base({ contextProvenance: { origin: 'local-fixture', corpusId: 'nope' } }))),
      'invalid-provenance',
    );
    expectReason(
      () => parseStructuredLLMOutput(wrap(base({ entities: [{ kind: 'planet', value: 'x', provenance: 'utterance' }] }))),
      'invalid-entities',
    );
    expectReason(
      () => parseStructuredLLMOutput(wrap(base({ extraDecision: 'execute' }))),
      'unknown-field',
    );
  });

  it('NEG-10: module exports no execution/authority surface (actual namespace)', () => {
    const exported = Object.keys(structuredModule).sort();
    expect(exported).toEqual([
      'STRUCTURED_INTENTS',
      'STRUCTURED_LIMITS',
      'StructuredInterpretationError',
      'parseStructuredLLMOutput',
      'toCandidate',
    ]);
    const namespace = structuredModule as unknown as Record<string, unknown>;
    for (const forbidden of [
      'execute',
      'commit',
      'authorize',
      'approve',
      'dispatch',
      'receipt',
      'write',
      'propose',
      'provision',
      'migrate',
    ]) {
      expect(namespace[forbidden], forbidden).toBeUndefined();
    }
  });

  it('NEG-11: POC source imports nothing networked, stateful or executable', () => {
    const dir = resolve(import.meta.dirname, '../../src/poc-structured');
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
    expect(files.sort()).toEqual(['ab-compare.ts', 'registry.ts', 'structured-interpretation.ts']);
    const allowedSpecifiers = new Set([
      '@pi-finance/llm-contracts/types',
      './registry.js',
      './structured-interpretation.js',
      '../orchestration/conversation-orchestrator.js',
      '../mutations/mutation-draft.js',
    ]);
    for (const file of files) {
      const source = readFileSync(resolve(dir, file), 'utf8');
      const specifiers = [...source.matchAll(/import (?:type )?[\s\S]*?from ['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      );
      expect(specifiers.length, file).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(allowedSpecifiers.has(specifier), `${file}: ${specifier}`).toBe(true);
      }
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/node:(http|https|net|child_process|fs)/);
      expect(source, file).not.toMatch(/from ['"](?:pg|kysely|drizzle|undici|@ai-sdk|ai)['"]/);
      expect(source, file).not.toMatch(/wrangler|DurableObject/);
    }
    // ARG_SPECS is the closed vocabulary: every value has a declared shape and
    // every canonical draft key is present (own-property reads only).
    for (const key of DRAFT_ARG_KEYS) expect(getArgSpec(key), key).toBeDefined();
  });
});
