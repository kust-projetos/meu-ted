import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateIdentityGate,
  evaluateSignatureGate,
  signatureFromFindings,
} from './rehearse-canonical-conversion.mjs';

const finding = (overrides = {}) => ({
  check: 'card_purchase',
  kind: 'purchase_amount_mismatch',
  entity: 'card_purchases',
  entityId: '11111111-1111-4111-8111-111111111111',
  expected: 1000,
  actual: 900,
  ...overrides,
});

const codeOf = (f) => `${f.check}:${f.kind}`;

test('F2 identity-swap: same check:kind count passes the signature gate but FAILS the identity gate', () => {
  const legacy = [finding({ entityId: 'aaaaaaaa-0000-4000-8000-000000000001' })];
  const canonical = [finding({ entityId: 'bbbbbbbb-0000-4000-8000-000000000002' })];
  // The count-only gate is blind to the swap (1 == 1).
  const sigGate = evaluateSignatureGate(
    signatureFromFindings(legacy.map(codeOf)),
    signatureFromFindings(canonical.map(codeOf)),
  );
  assert.equal(sigGate.pass, true, 'signature gate must stay blind to identity swaps (documents the hole)');
  // The identity gate must catch it.
  const gate = evaluateIdentityGate(legacy, canonical);
  assert.equal(gate.pass, false, 'identity-swap must fail');
  assert.equal(gate.missing.length, 1);
  assert.equal(gate.extra.length, 1);
});

test('F2 value-change: same entity identity with different expected/actual FAILS', () => {
  const legacy = [finding({ expected: 1000, actual: 900 })];
  const canonical = [finding({ expected: 1000, actual: 800 })];
  const gate = evaluateIdentityGate(legacy, canonical);
  assert.equal(gate.pass, false, 'value change on the same entity must fail');
  assert.equal(gate.changed.length, 1);
});

test('F2 faithful preservation: same identities and values PASSES', () => {
  const legacy = [finding(), finding({ entityId: 'bbbbbbbb-0000-4000-8000-000000000002' })];
  const canonical = [finding(), finding({ entityId: 'bbbbbbbb-0000-4000-8000-000000000002' })];
  const gate = evaluateIdentityGate(legacy, canonical);
  assert.equal(gate.pass, true);
});

test('F2 grain-mismatch special case: statement_payment:payment_coverage_gap skips identity comparison', () => {
  const legacy = [
    {
      check: 'statement_payment',
      kind: 'payment_coverage_gap',
      entity: 'statement_cycle',
      entityId: 'household|2026-07',
      expected: 5000,
      actual: 0,
    },
  ];
  const canonical = [
    {
      check: 'statement_payment',
      kind: 'payment_coverage_gap',
      entity: 'statements',
      entityId: 'cccccccc-0000-4000-8000-000000000003',
      expected: 5000,
      actual: 0,
    },
  ];
  const gate = evaluateIdentityGate(legacy, canonical);
  assert.equal(gate.pass, true, 'different-grain coverage gap stays on the count gate, not the identity gate');
  assert.equal(gate.skipped.length, 2);
});

test('F2 ADR-018 semantic exception skips identity comparison (decision-required via signature gate)', () => {
  const legacy = [
    {
      check: 'accounts_balance',
      kind: 'historical_exception_count_mismatch',
      entity: 'reconciliation',
      entityId: 'historical_exception:negative_credit_balance',
      expected: 1,
      actual: 1,
    },
  ];
  const canonical = [];
  const gate = evaluateIdentityGate(legacy, canonical);
  assert.equal(gate.pass, true, 'ADR-018 delta is owned by the signature gate DECISION-REQUIRED path');
});

test('F2 PII-safety: entityId sentinel never appears in gate diagnostics/evidence/failures', () => {
  const SENTINEL = 'SENTINEL_PII_9f8e7d6c5b4a_ENTITYID';
  const legacy = [
    finding({
      entityId: `aaaaaaaa-0000-4000-8000-000000000001-${SENTINEL}`,
      expected: `legacy-${SENTINEL}`,
      actual: 1,
      detail: `legacy-detail-${SENTINEL}`,
    }),
    finding({
      entityId: `cccccccc-0000-4000-8000-000000000003-${SENTINEL}`,
      expected: 1,
      actual: 1,
      detail: 'gone',
    }),
  ];
  const canonical = [
    finding({
      entityId: `aaaaaaaa-0000-4000-8000-000000000001-${SENTINEL}`,
      expected: `canonical-${SENTINEL}`,
      actual: 1,
      detail: `canonical-detail-${SENTINEL}`,
    }),
    finding({
      entityId: `dddddddd-0000-4000-8000-000000000004-${SENTINEL}`,
      expected: 2,
      actual: 2,
      detail: 'new',
    }),
  ];
  const gate = evaluateIdentityGate(legacy, canonical);
  // Raw comparison in memory must still detect swap + value change.
  assert.equal(gate.pass, false, 'sanitized gate must still fail on value change / swap');
  const serialized = JSON.stringify(gate);
  assert.ok(!serialized.includes(SENTINEL), 'serialized gate must not contain raw entityId/values');
  for (const failure of gate.failures) {
    assert.ok(!JSON.stringify(failure).includes(SENTINEL), `failure ${failure.code} must not contain raw entityId`);
  }
  for (const group of [gate.missing, gate.extra, gate.changed, gate.skipped]) {
    assert.ok(!JSON.stringify(group).includes(SENTINEL), 'diagnostic group must not contain raw entityId');
  }
});

test('F2 canonical recon CLI requests JSON so drift output stays parseable (fail-on-drift still exits non-zero)', async () => {
  const mod = await import('./rehearse-canonical-conversion.mjs');
  assert.equal(typeof mod.canonicalReconArgs, 'function', 'canonicalReconArgs helper must exist');
  const args = mod.canonicalReconArgs('11111111-1111-4111-8111-111111111111');
  assert.ok(args.includes('reconciliation'), 'must invoke the reconciliation CLI');
  assert.ok(args.includes('--schema=canonical'), 'must pin the canonical schema');
  assert.ok(args.includes('--fail-on-drift'), 'must keep --fail-on-drift');
  assert.ok(args.includes('--format=json'), 'must request --format=json so drift output parses');
});

test('F2 drift stdout from a non-zero CLI exit still parses and reaches the identity gate', async () => {
  const mod = await import('./rehearse-canonical-conversion.mjs');
  assert.equal(typeof mod.parseReport, 'function', 'parseReport must be exported for drift-stdout parsing');
  // pnpm banner + JSON report on stdout with drift (CLI would exit non-zero via --fail-on-drift).
  const driftStdout = [
    '> api@0.1.0 reconciliation',
    '{ "schema": "canonical", "totals": { "checked": 2, "drifted": 1 },',
    '"checks": [ { "check": "card_purchase", "findings": [ { "kind": "purchase_amount_mismatch",',
    '"entity": "card_purchases", "entityId": "aaaaaaaa-0000-4000-8000-000000000001",',
    '"expected": 1000, "actual": 800 } ] } ] }',
    'Done in 1.2s',
  ].join('\n');
  const recon = mod.parseReport(driftStdout);
  assert.equal(recon.totals?.drifted, 1, 'drift report must parse from noisy stdout');
  const canonicalFindingObjs = (recon.checks ?? []).flatMap((c) =>
    (c.findings ?? []).map((f) => ({
      check: c.check,
      kind: f.kind,
      entity: f.entity,
      entityId: f.entityId,
      expected: f.expected,
      actual: f.actual,
      detail: f.detail,
    })),
  );
  // Identity gate must be reachable on the parsed drift: same entity, changed value fails.
  const gate = mod.evaluateIdentityGate(
    [
      {
        check: 'card_purchase',
        kind: 'purchase_amount_mismatch',
        entity: 'card_purchases',
        entityId: 'aaaaaaaa-0000-4000-8000-000000000001',
        expected: 1000,
        actual: 900,
      },
    ],
    canonicalFindingObjs,
  );
  assert.equal(gate.pass, false, 'identity gate must run on parsed drift output');
  assert.equal(gate.changed.length, 1);
});

test('F2 canonical recon source hygiene: every canonical --fail-on-drift call carries --format=json', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./rehearse-canonical-conversion.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /'--fail-on-drift'\](?![\s\S]{0,200}--format=json)/, 'canonical calls must pair --fail-on-drift with --format=json');
  assert.match(src, /canonicalReconArgs/, 'canonical CLI args must come from a single helper');
});

test('F2 PII-safety: identity-gate diagnostics never emit raw expected/actual/detail', () => {
  const SENTINEL = 'SENTINEL_PII_9f8e7d6c5b4a_FINANCIAL_TEXT';
  const legacy = [
    finding({
      entityId: 'aaaaaaaa-0000-4000-8000-000000000001',
      expected: `legacy-${SENTINEL}`,
      actual: `legacy-actual-${SENTINEL}`,
      detail: { description: `legacy-detail-${SENTINEL}` },
    }),
    finding({
      entityId: 'cccccccc-0000-4000-8000-000000000003',
      expected: `gone-${SENTINEL}`,
      actual: 1,
      detail: `gone-detail-${SENTINEL}`,
    }),
  ];
  const canonical = [
    finding({
      entityId: 'aaaaaaaa-0000-4000-8000-000000000001',
      expected: `canonical-${SENTINEL}`,
      actual: `canonical-actual-${SENTINEL}`,
      detail: { description: `canonical-detail-${SENTINEL}` },
    }),
    finding({
      entityId: 'dddddddd-0000-4000-8000-000000000004',
      expected: `new-${SENTINEL}`,
      actual: 2,
      detail: `new-detail-${SENTINEL}`,
    }),
  ];
  const gate = evaluateIdentityGate(legacy, canonical);
  // Comparison must still use full values in memory: swap + value change fail.
  assert.equal(gate.pass, false, 'sanitized gate must still fail on value change / swap');
  assert.equal(gate.changed.length, 1, 'value change must still be detected');
  // Diagnostics / evidence / serialized failures must not carry raw values.
  const serialized = JSON.stringify(gate);
  assert.ok(!serialized.includes(SENTINEL), 'serialized gate must not contain raw expected/actual/detail text');
  for (const failure of gate.failures) {
    const failureSerialized = JSON.stringify(failure);
    assert.ok(!failureSerialized.includes(SENTINEL), `failure ${failure.code} must not contain raw values`);
  }
});

test('F2 improvement: missing-only with lower canonical count and no extras PASSES (real-dump 550e household)', () => {
  // Reproduces the real-dump F2 bug: household 550e... fails solely on
  // identity:payable_payment:test_fixture_count_mismatch +
  // identity:duplicates:duplicated_recurring_successor 'finding disappeared
  // in canonical'. Canonical fixed/dropped one entity per code with no new
  // identities — a pure improvement the signature gate already allows
  // (c<l). The identity gate must allow it too.
  const legacy = [
    {
      check: 'payable_payment',
      kind: 'test_fixture_count_mismatch',
      entity: 'payables',
      entityId: 'aaaaaaaa-0000-4000-8000-000000000001',
      expected: 2,
      actual: 1,
    },
    {
      check: 'payable_payment',
      kind: 'test_fixture_count_mismatch',
      entity: 'payables',
      entityId: 'bbbbbbbb-0000-4000-8000-000000000002',
      expected: 2,
      actual: 1,
    },
    {
      check: 'duplicates',
      kind: 'duplicated_recurring_successor',
      entity: 'transactions',
      entityId: 'cccccccc-0000-4000-8000-000000000003',
      expected: 1,
      actual: 2,
    },
  ];
  const canonical = [
    {
      check: 'payable_payment',
      kind: 'test_fixture_count_mismatch',
      entity: 'payables',
      entityId: 'aaaaaaaa-0000-4000-8000-000000000001',
      expected: 2,
      actual: 1,
    },
    // duplicates code fully resolved in canonical (0 < 1, no extras).
  ];
  const gate = evaluateIdentityGate(legacy, canonical);
  assert.equal(gate.pass, true, 'missing-only improvement with no extras must pass');
  assert.equal(gate.extra.length, 0);
  assert.equal(gate.changed.length, 0);
});

test('F2 swap-guard: same count with different entity still FAILS', () => {
  const legacy = [finding({ entityId: 'aaaaaaaa-0000-4000-8000-000000000001' })];
  const canonical = [finding({ entityId: 'bbbbbbbb-0000-4000-8000-000000000002' })];
  const gate = evaluateIdentityGate(legacy, canonical);
  assert.equal(gate.pass, false, 'same-count identity swap must fail even though counts match');
  assert.equal(gate.missing.length, 1);
  assert.equal(gate.extra.length, 1);
});

test('F2 new-entity-guard: fewer canonical count but with a new entity still FAILS', () => {
  const legacy = [
    finding({ entityId: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    finding({ entityId: 'bbbbbbbb-0000-4000-8000-000000000002' }),
    finding({ entityId: 'cccccccc-0000-4000-8000-000000000003' }),
  ];
  const canonical = [
    finding({ entityId: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    finding({ entityId: 'dddddddd-0000-4000-8000-000000000004' }),
  ];
  const gate = evaluateIdentityGate(legacy, canonical);
  assert.equal(gate.pass, false, 'fewer count with a new entity must fail (not a pure improvement)');
  assert.equal(gate.extra.length, 1);
});

test('F2 value-guard: shared entity with changed values still FAILS', () => {
  const legacy = [
    finding({ entityId: 'aaaaaaaa-0000-4000-8000-000000000001', expected: 1000, actual: 900 }),
    finding({ entityId: 'bbbbbbbb-0000-4000-8000-000000000002', expected: 1000, actual: 900 }),
  ];
  const canonical = [
    finding({ entityId: 'aaaaaaaa-0000-4000-8000-000000000001', expected: 1000, actual: 800 }),
    finding({ entityId: 'bbbbbbbb-0000-4000-8000-000000000002', expected: 1000, actual: 900 }),
  ];
  const gate = evaluateIdentityGate(legacy, canonical);
  assert.equal(gate.pass, false, 'silent value change on a shared entity must fail');
  assert.equal(gate.changed.length, 1);
});
