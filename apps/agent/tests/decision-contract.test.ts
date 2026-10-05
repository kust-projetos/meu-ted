/**
 * Issue #86 — the NEUTRAL decision contract (block 1).
 *
 * This file pins the shape that lets Jev, Cloudflare Clef and Strands Decider be
 * interchangeable, and — more important — pins what the shape must NEVER be able
 * to carry.
 *
 * The non-negotiable of the issue is "no write can be authorized by
 * DecisionProvider". In TypeScript the strongest available version of that claim
 * is structural: the request and outcome types contain no field that could be
 * read as an authorization, so there is nothing for a consumer to trust even by
 * mistake. The source guard below is what makes that claim testable (the same
 * technique `attachments/channel-invariant.test.ts` uses for `decisionText`): it
 * fails the moment someone adds an `approved`/`authorized`/`capability`/`write`
 * field to the contract, which a behavioural test could never catch because a
 * new field is inert until it is consumed.
 *
 * The second guard is the closed `op` enum: the neutral layer only ever consults
 * operations the domain declared, mirroring the A16 operation allowlist that
 * lived inside the Jev boundary.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DECISION_ALLOWED_OPERATIONS,
  DECISION_QUESTION_TYPES,
  answerValue,
  isAdvisoryOutcome,
  type DecisionOutcome,
  type DecisionRequest,
} from '../src/decision/contract.js';

const CONTRACT_SOURCE = readFileSync(new URL('../src/decision/contract.ts', import.meta.url), 'utf8');

/**
 * Strips block/line comments so a doc comment that merely EXPLAINS the invariant
 * ("a decision never authorizes a write") cannot satisfy — or trip — the guard.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('issue #86 — neutral decision contract', () => {
  it('accepts a provider-neutral request: scalar state plus typed questions', () => {
    const request: DecisionRequest = {
      op: 'continuation_relation',
      // Structural facts only: labels, counts, booleans. Never an amount, a date,
      // a description or an account id (that rule lives in `decision/wiring.ts`
      // and is re-proved there against the real payload).
      state: { activeDraft: true, draftStatus: 'proposing', pendingFieldCount: 2, negationMarker: false },
      questions: {
        relation: { type: 'choice', instructions: 'Classifique a relação deste turno.', criteria: { options: ['correction', 'negation', 'continuation'] } },
        confident: { type: 'noul', instructions: 'A relação está clara?' },
        severity: { type: 'score', instructions: 'Quão ambíguo é o turno?', criteria: { levels: ['low', 'high'] } },
      },
      turnId: 'contract-turn-1',
    };

    expect(request.op).toBe('continuation_relation');
    expect(Object.keys(request.questions)).toEqual(['relation', 'confident', 'severity']);
    expect(DECISION_QUESTION_TYPES).toEqual(['noul', 'choice', 'score']);
  });

  it('the contract declares NO authorization, approval, capability or write field', () => {
    const code = stripComments(CONTRACT_SOURCE);
    // Each token would be a field an adapter or a consumer could read as
    // authority. The decision layer is advisory by construction, so the absence
    // is the invariant.
    const forbidden = [
      /\bauthoriz\w*/i,
      /\bapprov\w*/i,
      /\bpermission\w*/i,
      /\bcapabilit\w*/i,
      /\bgrant\w*/i,
      /\battestation\b/i,
      /\breceipt\b/i,
      /\bentitlement\w*/i,
      /\bwrite\b/i,
      /\bwriteback\b/i,
      /\bscope\b/i,
    ];
    for (const pattern of forbidden) {
      expect(code, `contract.ts must not mention ${pattern}`).not.toMatch(pattern);
    }
  });

  it('the outcome type is a single advisory record, and every status carries advisory: true', () => {
    const decision: DecisionOutcome = {
      provider: 'clef',
      status: 'decision',
      answers: { relation: { value: 'continuation', confidence: 0.82 } },
      confidence: 0.82,
      advisory: true,
    };
    const abstained: DecisionOutcome = { provider: 'clef', status: 'abstained', reason: 'low_confidence', advisory: true };
    const unavailable: DecisionOutcome = { provider: 'clef', status: 'unavailable', reason: 'not_configured', advisory: true };

    for (const outcome of [decision, abstained, unavailable]) {
      expect(isAdvisoryOutcome(outcome)).toBe(true);
      // A decision can never be non-advisory; the literal is part of the type.
      expect(outcome.advisory).toBe(true);
    }
    // `detail` is diagnostics prose; it is never a value a consumer may branch on.
    expect(answerValue(decision, 'relation')).toBe('continuation');
    expect(answerValue(decision, 'absent')).toBeNull();
    expect(answerValue(abstained, 'relation')).toBeNull();
  });

  it('the op enum is CLOSED: an operation the domain did not declare is not consultable', () => {
    expect(DECISION_ALLOWED_OPERATIONS).toEqual(['continuation_relation']);
    expect(DECISION_ALLOWED_OPERATIONS).not.toContain('jev_decide');
    expect(DECISION_ALLOWED_OPERATIONS).not.toContain('clef_run');
  });
});
