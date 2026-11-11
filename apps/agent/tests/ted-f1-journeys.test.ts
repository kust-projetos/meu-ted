import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJourneyHarness } from './helpers/ted-f1-journey-harness.js';
import type { JourneyTurnObservation } from './helpers/ted-f1-journey-harness.js';

const outputPath = resolve(import.meta.dirname, '../evals/reports/ted-f1-journeys.json');

const ACC_PRINCIPAL = '10000000-0000-4000-8000-000000000003';
const CAT_MERCADO = '20000000-0000-4000-8000-000000000003';
const ACC_AURORA_A = '10000000-0000-4000-8000-000000000001';
const ACC_AURORA_B = '10000000-0000-4000-8000-000000000002';

const accountPrincipal = { id: ACC_PRINCIPAL, name: 'Conta principal', kind: 'bank', isActive: true, householdId: 'f1-synthetic-workspace' };
const categoryMercado = { id: CAT_MERCADO, name: 'Mercado', kind: 'expense', householdId: 'f1-synthetic-workspace' };
const auroraA = { id: ACC_AURORA_A, name: 'Aurora', kind: 'bank', isActive: true, householdId: 'f1-synthetic-workspace' };
const auroraB = { id: ACC_AURORA_B, name: 'Aurora', kind: 'bank', isActive: true, householdId: 'f1-synthetic-workspace' };

// ---------------------------------------------------------------------------
// Pure evaluator helpers (unit-tested below with ARTIFICIAL fixtures;
// evaluator-unit only, never product proof).
// ---------------------------------------------------------------------------

export const isExactExpenseProposal = (
  args: Record<string, unknown>,
  expected: { accountId: string; categoryId: string; amountCents: number },
): boolean => {
  const tool = String(args.tool ?? '');
  const norm = (args.normalizedArgs ?? {}) as Record<string, unknown>;
  return (
    tool === 'transactions.expense.create' &&
    norm.accountId === expected.accountId &&
    norm.categoryId === expected.categoryId &&
    norm.amountCents === expected.amountCents
  );
};

export const isExactRenameProposal = (
  args: Record<string, unknown>,
  expected: { accountId: string; newName: string; expectedName?: string },
): boolean => {
  if (String(args.tool ?? '') !== 'accounts.update') return false;
  const norm = (args.normalizedArgs ?? {}) as Record<string, unknown>;
  const target = norm.accountId ?? norm.id ?? norm.targetId;
  const name = norm.newName ?? norm.name;
  const cas = norm.expectedName;
  return target === expected.accountId && String(name ?? '') === expected.newName
    && (expected.expectedName === undefined || cas === expected.expectedName);
};

export const isCancelledPending = (snapshot: JourneyTurnObservation['pendingSnapshot'], id: string): boolean =>
  snapshot.some((p) => p.id === id && p.status === 'cancelled');

export const isValidBoundReceipt = (
  snapshot: JourneyTurnObservation['pendingSnapshot'],
  id: string,
): { bound: boolean; synthetic: boolean } => {
  const pending = snapshot.find((p) => p.id === id);
  if (!pending || !pending.receipt || typeof pending.receipt !== 'object') return { bound: false, synthetic: false };
  const receipt = pending.receipt as Record<string, unknown>;
  const entity = receipt.entity as { id?: unknown } | undefined;
  const bound = pending.status === 'succeeded' && receipt.operationId === id
    && entity?.id === `synthetic-entity-${id}`;
  const synthetic = (receipt as { synthetic?: unknown }).synthetic === true;
  return { bound, synthetic };
};

export const hasRefusal = (text: string | null): boolean =>
  typeof text === 'string' && /não posso|não consigo|indispon[íi]vel|sem suporte|não suport/i.test(text);

describe('evaluator units (ARTIFICIAL fixtures only — not product proof)', () => {
  it('fails invalid receipt (operationId mismatch)', () => {
    const snap = [{ id: 'p1', tool: 'transactions.expense.create', normalizedArgs: {}, status: 'succeeded', attestation: 'a', receipt: { operationId: 'other' }, intentionId: 'i' }] as unknown as JourneyTurnObservation['pendingSnapshot'];
    expect(isValidBoundReceipt(snap, 'p1').bound).toBe(false);
  });
  it('fails wrong entity (category mismatch)', () => {
    expect(isExactExpenseProposal({ tool: 'transactions.expense.create', normalizedArgs: { accountId: ACC_PRINCIPAL, categoryId: 'wrong', amountCents: 250000 } }, { accountId: ACC_PRINCIPAL, categoryId: CAT_MERCADO, amountCents: 250000 })).toBe(false);
  });
  it('fails still-proposed cancel (not cancelled)', () => {
    const snap = [{ id: 'p1', tool: 'x', normalizedArgs: {}, status: 'proposed', attestation: null, receipt: null, intentionId: 'i' }] as unknown as JourneyTurnObservation['pendingSnapshot'];
    expect(isCancelledPending(snap, 'p1')).toBe(false);
  });
  it('passes exact rename binding (artificial)', () => {
    expect(isExactRenameProposal({ tool: 'accounts.update', normalizedArgs: { accountId: ACC_AURORA_A, newName: 'Reserva', expectedName: 'Aurora' } }, { accountId: ACC_AURORA_A, newName: 'Reserva', expectedName: 'Aurora' })).toBe(true);
  });
  it('rejects incomplete or still-proposed receipts even with a matching operation ID', () => {
    const pending = { id: 'p1', tool: 'accounts.update', normalizedArgs: {}, status: 'proposed', receipt: { operationId: 'p1', entity: { id: 'synthetic-entity-p1' } } };
    expect(isValidBoundReceipt([pending] as unknown as JourneyTurnObservation['pendingSnapshot'], 'p1').bound).toBe(false);
    expect(isValidBoundReceipt([{ ...pending, status: 'succeeded', receipt: { operationId: 'p1', entity: { id: 'wrong' } } }] as unknown as JourneyTurnObservation['pendingSnapshot'], 'p1').bound).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Journey table: 10 journeys x >=2 consecutive REST turns, same harness.
// ---------------------------------------------------------------------------

type StepSetup = { auditItems?: Array<Record<string, unknown>>; providerFailure?: { status: number; code: string } | null };
type JourneyStep = { text: string; intentionId: string; before?: StepSetup };
type ExpectedStage = 'clarify' | 'propose' | 'confirm' | 'cancel' | 'read' | 'redelivery' | 'undo' | 'context-read';

type JourneySpec = {
  id: string;
  seed: Parameters<typeof createJourneyHarness>[0];
  steps: JourneyStep[];
  expectedStages: ExpectedStage[];
  rationale: string;
};

const ownAudit = [{ id: 'synthetic-op-own-1', operation: 'transactions.expense.create', actorId: 'f1-synthetic-actor', createdAt: '2026-10-24T11:00:00.000Z' }];
const foreignAudit = [{ id: 'synthetic-op-123', operation: 'transactions.expense.create', actorId: 'other-actor', createdAt: '2026-10-24T11:00:00.000Z' }];

const JOURNEYS: JourneySpec[] = [
  {
    id: 'J01', seed: { accounts: [accountPrincipal], categories: [categoryMercado] },
    steps: [
      { text: 'Gastei com carne na Conta principal categoria mercado', intentionId: 'f1-j01-t1' },
      { text: '2500', intentionId: 'f1-j01-t2' },
    ],
    expectedStages: ['clarify', 'propose'],
    rationale: 'Missing amount clarifies, then bare value 2500 resumes partial draft to exact proposal.',
  },
  {
    id: 'J02', seed: { accounts: [accountPrincipal], categories: [categoryMercado] },
    steps: [
      { text: 'Gastei 50 na Conta principal com carne', intentionId: 'f1-j02-t1' },
      { text: 'mercado', intentionId: 'f1-j02-t2' },
    ],
    expectedStages: ['clarify', 'propose'],
    rationale: 'Category inference: seeded catalog read, then bare answer must resolve exact categoryId.',
  },
  {
    id: 'J03', seed: {},
    steps: [
      { text: 'Crie conta chamada Reserva', intentionId: 'f1-j03-t1' },
      { text: 'banco com saldo 100', intentionId: 'f1-j03-t2' },
    ],
    expectedStages: ['clarify', 'propose'],
    rationale: 'Account draft continuity: name first, then kind bank + balance 100.',
  },
  {
    id: 'J04', seed: { accounts: [auroraA] },
    steps: [
      { text: 'Renomeie conta Aurora para Reserva', intentionId: 'f1-j04-t1' },
      { text: 'sim confirmo', intentionId: 'f1-j04-t2' },
    ],
    expectedStages: ['propose', 'confirm'],
    rationale: 'Unique rename proposes with CAS binding, then explicit confirm reaches decision path.',
  },
  {
    id: 'J05', seed: { accounts: [auroraA, auroraB] },
    steps: [
      { text: 'Renomeie conta Aurora para Reserva', intentionId: 'f1-j05-t1' },
      { text: 'a primeira conta Aurora', intentionId: 'f1-j05-t2' },
    ],
    expectedStages: ['clarify', 'propose'],
    rationale: 'Homonyms stay unresolved, then distinguishing selection must bind exactly one ID.',
  },
  {
    id: 'J06', seed: { accounts: [accountPrincipal], categories: [categoryMercado] },
    steps: [
      { text: 'Gastei R$ 25,00 com carne na Conta principal categoria mercado', intentionId: 'f1-j06-t1' },
      { text: 'cancele', intentionId: 'f1-j06-t2' },
    ],
    expectedStages: ['propose', 'cancel'],
    rationale: 'Valid expense proposes, then cancel ends cancelled with zero effect.',
  },
  {
    id: 'J07', seed: { accounts: [accountPrincipal], categories: [categoryMercado] },
    steps: [
      { text: 'Gastei R$ 25,00 com carne na Conta principal categoria mercado', intentionId: 'f1-j07-same' },
      { text: 'Gastei R$ 25,00 com carne na Conta principal categoria mercado', intentionId: 'f1-j07-same' },
    ],
    expectedStages: ['propose', 'redelivery'],
    rationale: 'Identical intention redelivery: first proposes, second adds no new pending.',
  },
  {
    id: 'J08', seed: {},
    steps: [
      { text: 'Desfaça última ação', intentionId: 'f1-j08-t1', before: { auditItems: ownAudit } },
      { text: 'pode desfazer', intentionId: 'f1-j08-t2' },
      { text: 'Desfaça a operação 123', intentionId: 'f1-j08-t3', before: { auditItems: foreignAudit } },
    ],
    expectedStages: ['undo', 'undo', 'undo'],
    rationale: 'Own implicit undo, confirm attempt, then foreign-only undo stays honest (C017).',
  },
  {
    id: 'J09', seed: {},
    steps: [
      { text: 'Quanto gastei neste mês?', intentionId: 'f1-j09-t1' },
      { text: 'E no mês passado?', intentionId: 'f1-j09-t2' },
    ],
    expectedStages: ['context-read', 'context-read'],
    rationale: 'Context reuse requires exact previous-month window query, not merely GET.',
  },
  {
    id: 'J10', seed: { accounts: [accountPrincipal], categories: [categoryMercado] },
    steps: [
      { text: 'Gastei R$ 25,00 com carne na Conta principal categoria mercado', intentionId: 'f1-j10-t1' },
      { text: 'pode confirmar', intentionId: 'f1-j10-t2' },
    ],
    expectedStages: ['propose', 'confirm'],
    rationale: 'Pending expense then confirm against fake executor: synthetic receipt is uncertain, never real proof.',
  },
];

type Completion = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

const evaluateJourney = (
  spec: JourneySpec,
  turns: JourneyTurnObservation[],
  counts: { executions: number },
): { completion: Completion; reasons: string[] } => {
  const reasons: string[] = [];
  const allHttpOk = turns.every((t) => t.httpStatus === 200);
  if (!allHttpOk) reasons.push('non-200 turn');
  const noRejected = turns.every((t) => t.rejectedOutbound.length === 0 && t.unexpectedOutbound.length === 0 && t.responseParseError === null);
  if (!noRejected) reasons.push('rejected outbound or parse error');
  const noExec = (n: number) => turns[n]!.executionsDelta === 0;

  const pendingCount = (t: JourneyTurnObservation) => t.pendingSnapshot.length;
  const firstProposalId = (): string | null => {
    for (const t of turns) {
      const proposed = t.pendingSnapshot.find((p) => p.status !== undefined && (t.proposalArgs.length > 0 || pendingCount(t) > 0));
      if (proposed) return proposed.id;
    }
    const any = turns.flatMap((t) => t.pendingSnapshot);
    return any.length ? any[0]!.id : null;
  };

  switch (spec.id) {
    case 'J01': {
      const clarified = turns[0]!.clarificationText !== null;
      if (!clarified) reasons.push('t1 expected clarify, none observed');
      const last = turns[turns.length - 1]!;
      const hit = last.proposalArgs.some((a) => isExactExpenseProposal(a, { accountId: ACC_PRINCIPAL, categoryId: CAT_MERCADO, amountCents: 250000 }));
      const snapHit = last.pendingSnapshot.some((p) => {
        const n = p.normalizedArgs as Record<string, unknown>;
        return p.tool === 'transactions.expense.create' && n.accountId === ACC_PRINCIPAL && n.categoryId === CAT_MERCADO && n.amountCents === 250000;
      });
      if (!hit && !snapHit) reasons.push('no exact expense proposal (account+category+250000)');
      if (reasons.length) return { completion: 'FAIL', reasons };
      return { completion: 'PASS', reasons: ['exact draft-continuity proposal observed'] };
    }
    case 'J02': {
      const last = turns[turns.length - 1]!;
      const snapHit = last.pendingSnapshot.some((p) => {
        const n = p.normalizedArgs as Record<string, unknown>;
         return p.tool === 'transactions.expense.create' && n.categoryId === CAT_MERCADO && n.accountId === ACC_PRINCIPAL && n.amountCents === 5000;
      });
      const argHit = last.proposalArgs.some((a) => {
        const n = (a.normalizedArgs ?? {}) as Record<string, unknown>;
         return String(a.tool ?? '') === 'transactions.expense.create' && n.categoryId === CAT_MERCADO && n.accountId === ACC_PRINCIPAL && n.amountCents === 5000;
      });
      if (!snapHit && !argHit) reasons.push('no proposal with exact resolved categoryId');
      if (reasons.length) return { completion: 'FAIL', reasons };
      return { completion: 'PASS', reasons: ['exact categoryId resolved, not mere catalog read'] };
    }
    case 'J03': {
      const last = turns[turns.length - 1]!;
      const hit = [...last.proposalArgs, ...last.pendingSnapshot.map((p) => ({ tool: p.tool, normalizedArgs: p.normalizedArgs }))].some((a) => {
        const t = String((a as Record<string, unknown>).tool ?? '');
        const n = ((a as Record<string, unknown>).normalizedArgs ?? {}) as Record<string, unknown>;
        const name = String(n.name ?? n.newName ?? '');
        const kind = String(n.kind ?? '');
        return t === 'accounts.create' && name === 'Reserva' && kind === 'bank' && n.initialBalanceCents === 10000;
      });
      if (!hit) reasons.push('no accounts.create with name Reserva + kind bank');
      if (reasons.length) return { completion: 'FAIL', reasons };
      return { completion: 'PASS', reasons: ['account draft continuity with exact kind'] };
    }
    case 'J04': {
      const first = turns[0]!;
      const proposed = first.proposalArgs.some((a) => isExactRenameProposal(a, { accountId: ACC_AURORA_A, newName: 'Reserva', expectedName: 'Aurora' }))
        || first.pendingSnapshot.some((p) => {
          const n = p.normalizedArgs as Record<string, unknown>;
          const target = n.accountId ?? n.id ?? n.targetId;
          const name = n.newName ?? n.name;
          return p.tool === 'accounts.update' && target === ACC_AURORA_A && String(name ?? '') === 'Reserva' && n.expectedName === 'Aurora';
        });
      if (!proposed) return { completion: 'INCONCLUSIVE', reasons: ['C004: CAS binding not observed via REST (no exact rename proposal)'] };
      if (!noExec(0)) return { completion: 'FAIL', reasons: ['proposal turn executed (must bind without execution)'] };
      const last = turns[turns.length - 1]!;
      const pid = firstProposalId() ?? last.pendingSnapshot[0]?.id ?? null;
      if (!pid) return { completion: 'INCONCLUSIVE', reasons: ['C004: no pending id to bind receipt'] };
      const { bound, synthetic } = isValidBoundReceipt(last.pendingSnapshot, pid);
      const decided = last.v2DecisionsDelta > 0 || ['confirmed', 'succeeded'].includes(last.pendingSnapshot.find((p) => p.id === pid)?.status ?? '');
      if (!bound || !decided) return { completion: 'FAIL', reasons: [`confirm path not reached with bound receipt (bound=${bound} decided=${decided})`] };
      if (last.mutationStatus !== 'succeeded') return { completion: 'INCONCLUSIVE', reasons: ['fake state succeeded, but the real REST result did not attest successful mutation; no completion inferred from fake state'] };
      if (synthetic) return { completion: 'PASS', reasons: ['confirm binds synthetic receipt only — harness PASS, never real financial proof'] };
      return { completion: 'PASS', reasons: ['confirm binds valid receipt'] };
    }
    case 'J05': {
      const first = turns[0]!;
      if (first.v2ProposalsDelta !== 0 || first.pendingSnapshot.length !== 0) return { completion: 'FAIL', reasons: ['homonym turn must not propose'] };
      const last = turns[turns.length - 1]!;
      const exactOne = last.pendingSnapshot.length === 1 && last.pendingSnapshot[0]!.status === 'proposed'
        && isExactRenameProposal(last.pendingSnapshot[0]! as unknown as Record<string, unknown>, { accountId: ACC_AURORA_A, newName: 'Reserva', expectedName: 'Aurora' });
      if (!exactOne) return { completion: 'FAIL', reasons: ['no selection bound exactly one homonym ID'] };
      return { completion: 'PASS', reasons: ['selection binds exact entity ID'] };
    }
    case 'J06': {
      const first = turns[0]!;
      if (first.pendingSnapshot.length === 0 && first.proposalArgs.length === 0) return { completion: 'FAIL', reasons: ['no proposal to cancel'] };
      const last = turns[turns.length - 1]!;
      const pid = firstProposalId();
      if (!pid) return { completion: 'FAIL', reasons: ['no pending id'] };
      const cancelled = isCancelledPending(last.pendingSnapshot, pid);
      const anySucceeded = last.pendingSnapshot.some((p) => p.status === 'succeeded');
      if (!cancelled) return { completion: 'FAIL', reasons: ['pending not in exact cancelled status'] };
      if (anySucceeded || counts.executions !== 0) return { completion: 'FAIL', reasons: ['financial effect observed after cancel'] };
      return { completion: 'PASS', reasons: ['V2 cancel ends cancelled, zero effect'] };
    }
    case 'J07': {
      const first = turns[0]!;
      const second = turns[1]!;
      if (first.pendingSnapshot.length === 0 && first.proposalArgs.length === 0) return { completion: 'FAIL', reasons: ['first proposal absent, redelivery unmeasurable'] };
      const firstIds = new Set(first.pendingSnapshot.map((p) => p.id));
      const secondIds = new Set(second.pendingSnapshot.map((p) => p.id));
      const newIds = [...secondIds].filter((id) => !firstIds.has(id));
      if (second.v2ProposalsDelta !== 0 || newIds.length !== 0) return { completion: 'FAIL', reasons: [`redelivery created new pending (http=${second.proposalHttpDelta} new=${second.v2ProposalsDelta})`] };
      if (counts.executions !== 0) return { completion: 'FAIL', reasons: ['execution on redelivery'] };
      const label = second.proposalHttpDelta > 0 ? 'fake-service dedupe (HTTP re-attempted, state deduped)' : 'product no-retry (no second HTTP propose)';
      return { completion: 'PASS', reasons: [label] };
    }
    case 'J08': {
      const anyExec = turns.some((t) => t.executionsDelta !== 0) || counts.executions !== 0;
      if (anyExec) return { completion: 'FAIL', reasons: ['free-text undo executed (cross-actor risk)'] };
      return { completion: 'INCONCLUSIVE', reasons: ['C017: free-text undo completion unobservable via REST without authenticated decision RPC; safety holds (no execution) but target election not proven'] };
    }
    case 'J09': {
      const q0 = turns[0]!.apiRequests.find((r) => r.startsWith('GET /dashboard/month-summary')) ?? turns[0]!.apiRequests.find((r) => r.startsWith('GET /transactions'));
      const q1 = turns[1]!.apiRequests.find((r) => r.startsWith('GET /dashboard/month-summary')) ?? turns[1]!.apiRequests.find((r) => r.startsWith('GET /transactions'));
      const hasPrev = turns[1]!.apiRequests.some((r) => r.includes('2026-09'));
      const hasCurr = turns[0]!.apiRequests.some((r) => r.includes('2026-10'));
      if (!q0 || !q1) return { completion: 'FAIL', reasons: ['context turn without scoped read'] };
      if (!hasCurr || !hasPrev) return { completion: 'FAIL', reasons: ['window query mismatch: expected 2026-10 then 2026-09 exact'] };
      const wrote = turns.some((t) => t.v2ProposalsDelta !== 0 || t.executionsDelta !== 0);
      if (wrote) return { completion: 'FAIL', reasons: ['context read proposed/executed'] };
      return { completion: 'INCONCLUSIVE', reasons: ['exact window queries observed; narration figures are model-dependent fixture output, not verified'] };
    }
    case 'J10': {
      const first = turns[0]!;
      if (first.pendingSnapshot.length === 0 && first.proposalArgs.length === 0) return { completion: 'FAIL', reasons: ['no pending to confirm'] };
      const last = turns[turns.length - 1]!;
      const pid = firstProposalId();
      if (!pid) return { completion: 'FAIL', reasons: ['no pending id'] };
      const { bound, synthetic } = isValidBoundReceipt(last.pendingSnapshot, pid);
      if (!bound) return { completion: 'FAIL', reasons: ['confirm without valid bound receipt (uncertain honest)'] };
      if (synthetic) return { completion: 'INCONCLUSIVE', reasons: ['bound receipt is synthetic fake-service output — uncertain, never real execution proof'] };
      return { completion: 'INCONCLUSIVE', reasons: ['fake executor cannot prove real mutation, regardless of a synthetic marker being present or absent'] };
    }
    default:
      return { completion: 'FAIL', reasons: ['unknown journey'] };
  }
};

describe('TED F1 journeys: successive REST turns with persistent synthetic state', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  for (const spec of JOURNEYS) {
    it(`${spec.id} executes ${spec.steps.length} consecutive turns (${spec.rationale})`, async () => {
      vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
      const harness = createJourneyHarness(spec.seed);
      try {
        const observations: JourneyTurnObservation[] = [];
        for (const step of spec.steps) {
          if (step.before?.auditItems) harness.setAuditItems(step.before.auditItems);
          if (step.before?.providerFailure !== undefined) harness.setProviderFailure(step.before.providerFailure);
          const [turn] = await harness.runTurns([{ text: step.text, intentionId: step.intentionId }]);
          observations.push(turn!);
        }
        // Must execute all turns; never silently swallow a turn.
        expect(observations).toHaveLength(spec.steps.length);
        for (const turn of observations) {
          expect(turn.httpStatus).toBe(200);
          expect(turn.rejectedOutbound).toEqual([]);
          expect(turn.unexpectedOutbound).toEqual([]);
          expect(turn.responseParseError).toBeNull();
          expect(turn.conversationId).toBe('f1-journey-conv-stable');
        }
        // Strict evaluator runs; product FAIL/INCONCLUSIVE does NOT fail the test.
        const verdict = evaluateJourney(spec, observations, harness.counts());
        expect(['PASS', 'FAIL', 'INCONCLUSIVE']).toContain(verdict.completion);
      } finally { harness.close(); }
    });
  }

  it('writes the machine-readable journey report with honest derived metrics', async () => {
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
    type JourneyEvidence = {
      id: string;
      rationale: string;
      expectedStages: ExpectedStage[];
      turns: JourneyTurnObservation[];
      completion: Completion;
      reasons: string[];
      evidenceKind: string;
    };
    const evidences: JourneyEvidence[] = [];

    for (const spec of JOURNEYS) {
      const harness = createJourneyHarness(spec.seed);
      try {
        const observations: JourneyTurnObservation[] = [];
        for (const step of spec.steps) {
          if (step.before?.auditItems) harness.setAuditItems(step.before.auditItems);
          if (step.before?.providerFailure !== undefined) harness.setProviderFailure(step.before.providerFailure);
          const [turn] = await harness.runTurns([{ text: step.text, intentionId: step.intentionId }]);
          observations.push(turn!);
        }
        const verdict = evaluateJourney(spec, observations, harness.counts());
        evidences.push({
          id: spec.id, rationale: spec.rationale, expectedStages: spec.expectedStages,
          turns: observations, completion: verdict.completion, reasons: verdict.reasons,
          evidenceKind: 'synthetic REST turns over in-memory fakes; no provider/DB/production',
        });
      } finally { harness.close(); }
    }

    const totalJourneys = evidences.length;
    const totalTurns = evidences.reduce((sum, e) => sum + e.turns.length, 0);
    const completed = evidences.filter((e) => e.completion === 'PASS');
    const observable = evidences.filter((e) => e.completion !== 'INCONCLUSIVE');
    const multiTurn = evidences.filter((e) => e.turns.length >= 2);

    // Needed/redundant clarifications from per-turn expected stage + observed text.
    let neededClar = 0; let observedClar = 0; let redundantClar = 0;
    // Confirmations require actual first pending + confirmation path reached; cancel is NOT confirmation.
    let neededConf = 0; let handledConf = 0;
    for (const e of evidences) {
      e.expectedStages.forEach((stage, idx) => {
        const turn = e.turns[idx]!;
        if (stage === 'clarify') {
          neededClar += 1;
          if (turn.clarificationText !== null && !/confirma[^?]*\?/i.test(turn.clarificationText)) observedClar += 1;
        } else if (turn.clarificationText !== null && !/confirma[^?]*\?/i.test(turn.clarificationText)) {
          redundantClar += 1;
        }
        if (stage === 'confirm') {
          neededConf += 1;
          const priorPending = e.turns.slice(0, idx + 1).some((t) => t.pendingSnapshot.length > 0 || t.proposalArgs.length > 0);
          const decided = turn.v2DecisionsDelta > 0 || turn.pendingSnapshot.some((p) => p.status === 'confirmed' || p.status === 'succeeded');
          if (priorPending && decided) handledConf += 1;
        }
      });
    }

    // False refusals: only over observable supported-task turns with verified refusal regex.
    const refusalRe = /não posso|não consigo|indispon[íi]vel|sem suporte|não suport/i;
    const supportedTurns = evidences.flatMap((e) => e.turns.map((t, idx) => ({ t, stage: e.expectedStages[idx]! })))
      .filter(({ stage }) => stage === 'propose' || stage === 'read' || stage === 'clarify' || stage === 'context-read');
    const refused = supportedTurns.filter(({ t }) => refusalRe.test(t.output ?? '') || refusalRe.test(t.clarificationText ?? ''));
    const falseRefusals = supportedTurns.length > 0
      ? { numerator: refused.length, denominator: supportedTurns.length, value: refused.length / supportedTurns.length }
      : { numerator: 0, denominator: 0, value: null as number | null, reason: 'unavailable: no observable supported-task turns' };

    // False-success: denominator = actual mutation decisions that returned success claim/status.
    const successTurns = evidences.flatMap((e) => e.turns).filter((t) =>
      t.mutationStatus === 'succeeded' || (/sucesso|registrad[oa]|confirmad[oa]/i.test(t.output ?? '') && !/não|processamento|incerto/i.test(t.output ?? '')));
    const falseSuccesses = successTurns.filter((t) => {
      const succeeded = t.pendingSnapshot.filter((p) => p.status === 'succeeded');
      if (succeeded.length === 0) return true;
      return !succeeded.some((p) => {
        return isValidBoundReceipt(t.pendingSnapshot, p.id).bound;
      });
    });
    const falseSuccessMetric = successTurns.length > 0
      ? { numerator: falseSuccesses.length, denominator: successTurns.length, value: falseSuccesses.length / successTurns.length }
      : { numerator: 0, denominator: 0, value: null as number | null, reason: 'unavailable: no actual mutation success decisions observed (zero denominator, not zero rate)' };

    // Entity/category metrics require exact ID args, never catalog-read counts.
    const entityChecks = ['J01', 'J04', 'J05'].map((id) => ({ journey: id, ok: evidences.find((e) => e.id === id)!.turns.some((t) => t.pendingSnapshot.some((p) => p.normalizedArgs.accountId === (id === 'J01' ? ACC_PRINCIPAL : ACC_AURORA_A))) }));
    const categoryChecks = [
      { journey: 'J02', ok: evidences.find((e) => e.id === 'J02')!.completion === 'PASS' },
    ];

    const completionTurns = completed.reduce((sum, e) => sum + e.turns.length, 0);
    const rawReads = evidences.flatMap((e) => e.turns.flatMap((t) => t.apiReads));
    const duplicatedReads = evidences.reduce((sum, e) => {
      const reads = e.turns.flatMap((t) => t.apiReads);
      return sum + reads.length - new Set(reads).size;
    }, 0);
    const redundantConfirmations = evidences.flatMap((e) => e.turns.map((t, index) => ({ t, stage: e.expectedStages[index] })))
      .filter(({ t, stage }) => /confirma[^?]*\?/i.test(t.output ?? '') && stage !== 'propose' && t.proposalHttpDelta === 0).length;
    vi.useRealTimers();
    const report = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      baseline: '98221f5a2c92de01d18d71fc6a7b05988c8139c3',
      environment: 'local-synthetic',
      execution: { externalNetwork: false, realFinancialData: false, realWriter: false, syntheticInMemoryOnly: true, llmCalls: 0, providerIdentity: 'opencode-zen/zen-free-model (allowlisted; local fetch interception)' },
      totalJourneys,
      totalTurns,
      journeys: evidences,
      directedStructural: [
        { id: 'C004', kind: 'structural-over-fixture', result: evidences.find((e) => e.id === 'J04')!.completion, note: 'Unique rename CAS binding; INCONCLUSIVE when actual proposal not observed (never PASS by default).' },
        { id: 'C007', kind: 'structural-over-fixture', result: 'INCONCLUSIVE', note: 'REST no-op is not proof of ADR-028 target election; recorded in J08.' },
        { id: 'C012', kind: 'structural-over-fixture', result: evidences.find((e) => e.id === 'J05')!.completion, note: 'Homonym divergence: PASS only with exact single-ID binding.' },
        { id: 'C013', kind: 'structural', result: evidences.find((e) => e.id === 'J07')!.completion, note: 'Redelivery: HTTP propose count vs new pendings distinguished (fake dedupe vs product no-retry).' },
        { id: 'C011', kind: 'structural', result: 'INCONCLUSIVE', note: 'No-write observed; receipt behavior not established without a real writer.' },
        { id: 'C017', kind: 'explicit-limitation', result: 'INCONCLUSIVE', note: 'Free-text undo completion unobservable via REST without authenticated decision RPC; J08 safety holds (zero executions) but election not proven.' },
        { id: 'C024', kind: 'structural', result: 'INCONCLUSIVE', note: 'Statement-payment no-write observed at REST boundary; receipt behavior not established.' },
      ],
      metrics: {
        correctTaskCompletion: { numerator: completed.length, denominator: observable.length, value: observable.length ? completed.length / observable.length : null, totalJourneys, excluded: evidences.filter((e) => e.completion === 'INCONCLUSIVE').map((e) => ({ id: e.id, reasons: e.reasons })), note: 'Observable subset only; exclusions and all-journey result counts are explicit.' },
        turnsPerTask: { totalTurns, totalJourneys, value: totalTurns / totalJourneys },
        completionTurns: { turns: completionTurns, completedJourneys: completed.length, value: completed.length ? completionTurns / completed.length : null, reason: completed.length ? undefined : 'unavailable: zero PASS journeys' },
        neededClarifications: { numerator: observedClar, denominator: neededClar, value: neededClar ? observedClar / neededClar : null, reason: neededClar ? undefined : 'unavailable: no clarify-expected turns' },
        redundantClarifications: { numerator: redundantClar, denominator: totalTurns, value: redundantClar / totalTurns },
        neededConfirmations: { numerator: handledConf, denominator: neededConf, value: neededConf ? handledConf / neededConf : null, reason: neededConf ? undefined : 'unavailable: no confirm-expected turns', note: 'cancel is NOT confirmation' },
        redundantConfirmations: { numerator: redundantConfirmations, denominator: totalTurns, value: redundantConfirmations / totalTurns, note: 'Confirmation question outside an expected proposal stage, without a new proposal HTTP call; deterministic text heuristic, not UX adjudication.' },
        falseRefusals,
        categoryInference: { numerator: evidences.find((e) => e.id === 'J02')!.turns[0]!.pendingSnapshot.filter((p) => p.normalizedArgs.categoryId === CAT_MERCADO).length > 0 ? 1 : 0, denominator: 1, note: 'Category selected before the user supplies Mercado; assisted follow-up resolution is separate.' },
        categoryResolution: { numerator: categoryChecks.filter((c) => c.ok).length, denominator: categoryChecks.length, value: categoryChecks.filter((c) => c.ok).length / categoryChecks.length, note: 'Assisted follow-up resolves exact categoryId; not autonomous inference.' },
        entityResolution: { numerator: entityChecks.filter((c) => c.ok).length, denominator: entityChecks.length, value: entityChecks.filter((c) => c.ok).length / entityChecks.length, note: 'Exact entity ID arg required.' },
        contextReuse: { numerator: evidences.find((e) => e.id === 'J09')!.completion === 'PASS' ? 1 : 0, denominator: 1, value: evidences.find((e) => e.id === 'J09')!.completion === 'PASS' ? 1 : 0, note: 'Exact previous-month window query required; GET count alone never counts.' },
        apiReadsPerTask: { numerator: rawReads.length, denominator: totalJourneys, value: rawReads.length / totalJourneys },
        apiReadsPerTurn: { numerator: rawReads.length, denominator: totalTurns, value: rawReads.length / totalTurns },
        apiDuplicateReads: { numerator: duplicatedReads, denominator: rawReads.length, value: rawReads.length ? duplicatedReads / rawReads.length : null, note: 'Repeated identical GET including query within one journey; necessary refreshes may also repeat. Raw chronological calls retained; not proven avoidable calls.' },
        falseSuccessWithoutReceipt: falseSuccessMetric,
        validReceipts: { numerator: 0, denominator: 0, value: null as number | null, reason: 'unavailable: real-writer receipts not observable with fake executor' },
      },
      safety: {
        note: 'Safety (no financial write) is NOT completion and is reported separately.',
        journeysWithZeroExecutions: evidences.filter((e) => e.turns.every((t) => t.executionsDelta === 0)).length,
        totalJourneys,
      },
      limitations: [
        'Fixture + structural only: no real provider, DB, or production; fake API is in-memory.',
        'Model-dependent narration is INCONCLUSIVE by construction (synthetic relay text).',
        'C004 CAS: INCONCLUSIVE when actual binding not observed.',
        'C007/C011/C024/C017 remain INCONCLUSIVE without authenticated ledger/writer/decision RPC.',
        'C005/C010 stay FAIL per baseline and are not re-litigated here.',
      ],
      evidenceKind: 'fixture+structural REST journeys over in-memory fakes; no real integration, provider, DB, or production',
      fakeExecuteNote: 'Any execute in these journeys mutates only the in-memory fake ledger; synthetic receipts are not real financial proof.',
    };
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    expect(totalJourneys).toBe(10);
    expect(totalTurns).toBe(21);
    expect(multiTurn.length).toBe(10);
    expect(report.metrics.correctTaskCompletion.denominator).toBe(observable.length);
    expect(report.metrics.correctTaskCompletion.denominator + report.metrics.correctTaskCompletion.excluded.length).toBe(totalJourneys);
  });
});
