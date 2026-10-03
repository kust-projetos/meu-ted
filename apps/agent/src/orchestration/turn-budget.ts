import { createHash } from 'node:crypto';

/**
 * R10 (SPEC AC20/AC30): a shared per-turn recovery budget.
 *
 * A turn may recover at most TWICE, across every recovery axis. The existing
 * grounding correction retry spends one slot; a read-only entity-resolution
 * recovery spends another. This bounds a turn that keeps re-deriving instead
 * of asking the user, without touching the structural caps that already own
 * their own axis (planner corrections stay 0..1, propose attempts stay ≤2 and
 * the tool-step ceiling stays where it is).
 *
 * Anti-repetition is stricter than the ceiling: an identical resolution
 * recovery (same kind + args + workspace/actor scope + evidence-source
 * revision + effective resolution hint) never re-executes, even while budget
 * remains. Repeating it would re-read the same authoritative lists and reach
 * the same conclusion, so the caller gets a safe stop instead of a loop.
 *
 * The module is pure and dependency-free: it counts, it never performs I/O and
 * it never throws for a refused recovery.
 */
export type RecoveryAxis = 'grounding_retry' | 'resolution_recovery' | 'propose_attempt';

/**
 * Declared safe terminal reasons for a turn. `budget_exhausted` and
 * `no_new_strategy` are the two refusals this module can produce; the rest
 * describe terminal outcomes owned by the orchestrator.
 */
export type TurnStopReason =
  | 'completed'
  | 'clarification_needed'
  | 'permanent_error'
  | 'write_uncertain'
  | 'cancelled'
  | 'budget_exhausted'
  | 'deadline_exceeded'
  | 'no_new_strategy';

/** Shared ceiling across every recovery axis (SPEC R10). */
export const TURN_RECOVERY_CAP = 2;

/**
 * Read-only entity-resolution recovery request. `args` is the canonical
 * financial shape; `evidenceRevision` is whatever the caller can compare
 * across attempts (e.g. `retrievedAt`). When no comparable revision exists the
 * caller omits it, and the fingerprint then covers kind + args + scope only —
 * same input, same result, no new evidence.
 *
 * `resolutionHint` is the EFFECTIVE text the resolver actually matched the
 * account against (the turn's text, or the draft description plus the user's
 * answer): naming "Nubank" and then "Itaú" is a different strategy for the
 * same money, so it must not collapse into one attempt. Optional — omitting it
 * keeps the previous fingerprint exactly.
 */
export type ResolutionRecoveryRequest = Readonly<{
  kind: 'expense' | 'income';
  args: Readonly<{
    amountCents: number;
    description: string;
    date: string;
    categoryQuery?: string;
  }>;
  workspaceId: string;
  actorId: string;
  evidenceRevision?: string;
  resolutionHint?: string;
}>;

export type RecoveryPermit =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; stop: 'budget_exhausted' | 'no_new_strategy' }>;

/** Numeric-only counters. Never carries args, user text or technical ids. */
export type TurnBudgetSnapshot = Readonly<{
  recoveryCap: number;
  recoveriesUsed: number;
  groundingRetries: number;
  resolutionRecoveries: number;
  proposeAttempts: number;
  blockedRepeats: number;
  stop: TurnStopReason;
}>;

const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`;
};

/**
 * Identity of a resolution recovery attempt. Scoped to workspace + actor so a
 * repeat in one conversation can never be confused with the same intent in
 * another, and covers the EFFECTIVE resolution hint the resolver matches
 * accounts against — a different hint is a different strategy. Folded into
 * sha256 so no raw arg, hint or id is ever retained.
 */
export const resolutionRecoveryFingerprint = (request: ResolutionRecoveryRequest): string =>
  createHash('sha256')
    .update(stableSerialize({
      axis: 'resolution_recovery' satisfies RecoveryAxis,
      kind: request.kind,
      args: request.args,
      workspaceId: request.workspaceId,
      actorId: request.actorId,
      evidenceRevision: request.evidenceRevision ?? null,
      resolutionHint: request.resolutionHint ?? null,
    }))
    .digest('hex');

export class TurnBudget {
  private groundingRetries = 0;
  private resolutionRecoveries = 0;
  private proposeAttempts = 0;
  private blockedRepeats = 0;
  private stop: TurnStopReason = 'completed';
  private readonly seenRecoveryFingerprints = new Set<string>();

  private get recoveriesUsed(): number {
    return this.groundingRetries + this.resolutionRecoveries;
  }

  /** Spends one shared slot when the grounding correction retry actually runs. */
  noteGroundingRetry(): void {
    this.groundingRetries += 1;
  }

  /**
   * Propose attempts already have a structural cap of their own (ADR-014); this
   * only records them so the snapshot shows the axis without granting budget.
   */
  noteProposeAttempt(): void {
    this.proposeAttempts += 1;
  }

  /**
   * Admits a read-only resolution recovery. Refusal is a safe stop, never a
   * throw: the caller clarifies instead of re-running the same read.
   */
  tryResolutionRecovery(request: ResolutionRecoveryRequest): RecoveryPermit {
    const fingerprint = resolutionRecoveryFingerprint(request);
    // Fingerprint first: an identical attempt is refused even under budget.
    if (this.seenRecoveryFingerprints.has(fingerprint)) {
      this.blockedRepeats += 1;
      this.stop = 'no_new_strategy';
      return { allowed: false, stop: 'no_new_strategy' };
    }
    if (this.recoveriesUsed >= TURN_RECOVERY_CAP) {
      this.stop = 'budget_exhausted';
      return { allowed: false, stop: 'budget_exhausted' };
    }
    this.seenRecoveryFingerprints.add(fingerprint);
    this.resolutionRecoveries += 1;
    return { allowed: true };
  }

  /** Records why the turn stopped, for the sanitized `turn.budget` snapshot. */
  stopWith(stop: TurnStopReason): void {
    this.stop = stop;
  }

  snapshot(): TurnBudgetSnapshot {
    return {
      recoveryCap: TURN_RECOVERY_CAP,
      recoveriesUsed: this.recoveriesUsed,
      groundingRetries: this.groundingRetries,
      resolutionRecoveries: this.resolutionRecoveries,
      proposeAttempts: this.proposeAttempts,
      blockedRepeats: this.blockedRepeats,
      stop: this.stop,
    };
  }
}