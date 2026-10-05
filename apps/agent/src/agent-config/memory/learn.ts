/**
 * Post-turn learning (Part B, item 15): lightweight extraction of 0–2
 * durable learnings per turn (preferred account, recurring categories,
 * cited goals, format preferences).
 *
 * - Runs every turn with a cheap local heuristic; an optional LLM
 *   extractor runs only every LEARN_EVERY_TURNS turns.
 * - Dedup by token similarity (bump instead of insert); salience decays
 *   via recall-time recency weighting (see store.ts).
 * - Respects the per-workspace privacy toggle and redacts transcripts
 *   before persisting. Card numbers are never stored.
 */

import {
  isFingerprintTombstoned,
  isMemoryEnabled,
  memoryFingerprint,
  normalizeMemoryScope,
  rememberCorrection,
  rememberFact,
  textSimilarity,
  type MemoryItem,
  type MemoryScope,
  type MemorySql,
} from './store.js';

export const LEARN_EVERY_TURNS = 5;
export const MAX_LEARNINGS_PER_TURN = 2;
export const LEARN_DEDUP_THRESHOLD = 0.6;

/**
 * G06.2: behavioral inference stays a CANDIDATE. A correction observed in a
 * turn is persisted as a derived `learning`, never promoted to a durable
 * `fact`/`preference` without an explicit user declaration.
 */
export type LearningCorrection = {
  /** Stable identity of what was corrected (entity/alias being fixed). */
  target: string;
  /** Which field of the target the correction applies to. */
  field: string;
  /** Identity of the correcting turn; makes redelivery idempotent. */
  turnFingerprint?: string;
};

export type LearningCandidate = {
  kind: 'preference' | 'fact' | 'learning';
  content: string;
  salience: number;
};

const HEURISTIC_PATTERNS: Array<{ test: RegExp; kind: LearningCandidate['kind']; salience: number }> = [
  { test: /prefiro|prefere|gosto mais|sempre uso/i, kind: 'preference', salience: 0.8 },
  { test: /lembre[ -]se|não esqueça|nao esqueca| memorize|guarde (isso|esta)/i, kind: 'preference', salience: 0.9 },
  { test: /minha (conta|meta|categoria).+ é |meu (banco|cartão|cartao|limite) é /i, kind: 'fact', salience: 0.7 },
  { test: /todo (mês|mes|dia|semana|ano) (eu )?/i, kind: 'learning', salience: 0.6 },
];

export const extractLearningsHeuristic = (userText: string, _assistantText: string): LearningCandidate[] => {
  const found: LearningCandidate[] = [];
  for (const pattern of HEURISTIC_PATTERNS) {
    if (pattern.test.test(userText)) {
      const content = userText.trim().slice(0, 280);
      if (content.length > 0) found.push({ kind: pattern.kind, content, salience: pattern.salience });
    }
    if (found.length >= MAX_LEARNINGS_PER_TURN) break;
  }
  return found.slice(0, MAX_LEARNINGS_PER_TURN);
};

export const isDuplicateLearning = (candidate: string, existing: MemoryItem[]): boolean =>
  existing.some((item) => textSimilarity(item.content, candidate) >= LEARN_DEDUP_THRESHOLD);

export type LearnTurnInput = {
  workspaceId: string;
  actorId: string;
  userText: string;
  assistantText: string;
  turnCount: number;
  /** Optional cheap-LLM extractor used only when the turn is due. */
  llmExtract?: (transcript: string) => Promise<string[]>;
  /** G06.4: explicit scope; without it the current behavior is unchanged. */
  scope?: MemoryScope;
  /**
   * A17: a correction observed in this turn. Persisted as a derived learning
   * with a deterministic fingerprint (AC26a), never as a durable rule.
   */
  correction?: LearningCorrection;
};

export const learnFromTurn = async (sql: MemorySql, input: LearnTurnInput): Promise<MemoryItem[]> => {
  if (!isMemoryEnabled(sql, input.workspaceId)) return [];
  // A failed/empty assistant turn is not an actual response and must not
  // teach durable memory from an uncompleted interaction.
  if (typeof input.assistantText !== 'string' || input.assistantText.trim().length === 0) return [];
  const scope = input.scope
    ?? normalizeMemoryScope({ workspaceId: input.workspaceId, actor: input.actorId, shared: false });
  const learned: MemoryItem[] = [];
  const persist = (candidate: LearningCandidate): void => {
    const result = rememberFact(sql, {
      workspaceId: input.workspaceId,
      actor: input.actorId,
      kind: candidate.kind,
      content: candidate.content,
      salience: candidate.salience,
      scope,
    });
    if (result.stored && !result.deduped) learned.push(result.item);
  };

  // A17: an explicit correction takes the derived path. It is stored as a
  // `learning` with provenance, and a tombstoned identity is refused so the
  // job cannot resurrect what the user forgot (AC26b).
  if (input.correction) {
    const fingerprint = memoryFingerprint({
      scope,
      target: input.correction.target,
      field: input.correction.field,
    });
    if (!isFingerprintTombstoned(sql, { workspaceId: input.workspaceId, actor: input.actorId, fingerprint })) {
      const content = input.userText.trim().slice(0, 280);
      if (content.length > 0) {
        const result = rememberCorrection(sql, {
          workspaceId: input.workspaceId,
          actor: input.actorId,
          target: input.correction.target,
          field: input.correction.field,
          turnFingerprint: input.correction.turnFingerprint,
          content,
          scope,
        });
        if (result.stored && !result.deduped) learned.push(result.item);
      }
    }
    // A correction turn teaches exactly one derived candidate: never run the
    // heuristic/LLM extractors on it, which could promote a durable rule.
    return learned;
  }

  for (const candidate of extractLearningsHeuristic(input.userText, input.assistantText)) {
    if (learned.length >= MAX_LEARNINGS_PER_TURN) break;
    persist(candidate);
  }

  if (input.llmExtract && input.turnCount > 0 && input.turnCount % LEARN_EVERY_TURNS === 0) {
    try {
      const extra = await input.llmExtract(`Usuário: ${input.userText}\nTED: ${input.assistantText}`);
      for (const content of (extra ?? []).slice(0, MAX_LEARNINGS_PER_TURN - learned.length)) {
        if (typeof content === 'string' && content.trim().length > 0) {
          persist({ kind: 'learning', content: content.trim().slice(0, 280), salience: 0.6 });
        }
      }
    } catch {
      // Silent: learning must never break the turn.
    }
  }
  return learned;
};
