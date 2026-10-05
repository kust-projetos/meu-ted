/**
 * P4 slices A16/A17/A18 (integration) — judgment, memory and user skills in the
 * SAME process and on the SAME workspace, in the same turn flow.
 *
 * The unit suites prove each slice in isolation. This file proves they compose
 * without leaking into each other:
 *
 * 1. default-off: the negotiation turn is byte for byte the pre-wiring turn, no
 *    `judgment.consulted` event, no network;
 * 2. with a judge stub answering AGAINST the deterministic relation, the
 *    deterministic value still wins (AC25);
 * 3. a memory derived from a correction (learning, non-promotable, requiring
 *    revalidation when it cites an account) is present in the recall block of a
 *    real turn;
 * 4. a promoted user skill (replay + safety + approval) appears in the shared
 *    selection inside the budget, and a rule whose category no longer exists is
 *    simply not applied.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { createJudgmentProvider, type JudgmentEnv, type JudgmentProvider } from '../../src/judgment/provider.js';
import { assembleCognition } from '../../src/agent-config/index.js';
import { fitSkills, renderInjectedSkills } from '../../src/agent-config/select-skill.js';
import {
  initializeMemorySchema,
  recallMemories,
  renderMemoryBlock,
} from '../../src/agent-config/memory/store.js';
import { learnFromTurn } from '../../src/agent-config/memory/learn.js';
import {
  initializeUserSkillsSchema,
  listActiveUserSkills,
  recordReplayEvidence,
  recordSafetyReport,
  recordSkillCandidate,
  type ReplayEvidence,
  type SkillSafetyReport,
} from '../../src/agent-config/user-skills/store.js';
import { promoteSkillCandidate } from '../../src/agent-config/user-skills/promotion.js';
import { toSelectableSkills } from '../../src/agent-config/user-skills/resolve.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../../src/mutations/mutation-draft.js';
import type { EntityReader } from '../../src/mutations/entity-resolver.js';
import { createMemorySql, type MemorySqlMock } from '../helpers/memory-sql.js';

const WORKSPACE = 'ws-p4-integration';
const ACTOR = 'u-p4';
const NOW_MS = Date.parse('2026-10-05T12:00:00.000Z');

const identity: AuthenticatedIdentity = {
  actorId: ACTOR,
  workspaceId: WORKSPACE,
  role: 'member',
  deviceId: 'device-p4',
};

const reader: EntityReader = {
  listAccounts: async () => [
    { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Itaú' },
  ],
  listCategories: async () => [
    { id: 'cat_padarias', name: 'Padarias' },
    { id: 'cat_mercado', name: 'Mercado' },
  ],
};

const enabledEnv: JudgmentEnv = {
  TED_JUDGMENT_ENDPOINT: 'https://judgment.example.test/evaluate',
  TED_JUDGMENT_ALLOWED_MODELS: 'judgment-model-v1',
};

const ctxOf = () => ({
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  deviceId: identity.deviceId ?? null,
});

const judgeAnswer = (choice: unknown) =>
  new Response(JSON.stringify({ choice, rationale: 'continuação', confidence: 0.95 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

type Events = Array<{ eventType: string; fields: Record<string, unknown> }>;

const runNegotiation = async (options: { provider?: JudgmentProvider } = {}) => {
  const store = new InMemoryMutationDraftStore();
  const writes: string[] = [];
  const events: Events = [];
  const request = vi.fn();
  request.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET') {
      if (path === '/pending-operations/v2/active') return { items: [], total: 0 };
      throw new Error(`unexpected read ${path}`);
    }
    writes.push(`${method} ${path}`);
    throw new Error('financial.mutation.must_not_happen');
  });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: new MutationApiClient({ request }),
    entityReader: reader,
    draftStore: store,
    draftNow: () => NOW_MS,
    events: (eventType, fields) => {
      events.push({ eventType, fields });
    },
    ...(options.provider ? { judgmentProvider: () => options.provider } : {}),
  });
  const run = (text: string, intentionId: string) =>
    orchestrator.runTurn(normalizeRestTurn({ text, intentionId }, identity));
  const first = await run('Gastei R$ 50 no mercado', 'p4-open');
  const second = await run('não', 'p4-neg');
  const draft = store.listActive(ctxOf(), NOW_MS)[0]!;
  return { first, second, draft, events, writes };
};

describe('P4 A16/A17/A18 integration on one workspace', () => {
  it('default-off is byte for byte the pre-wiring turn and emits no judgment event', async () => {
    const defaultOff = await runNegotiation();
    // The provider exists but has no endpoint: identical to no provider at all.
    const configured = await runNegotiation({
      provider: createJudgmentProvider({ fetchImpl: vi.fn() as unknown as typeof fetch }),
    });

    expect(JSON.stringify(defaultOff.first)).toBe(JSON.stringify(configured.first));
    expect(JSON.stringify(defaultOff.second)).toBe(JSON.stringify(configured.second));
    expect(defaultOff.events.filter((event) => event.eventType === 'judgment.consulted')).toEqual([]);
    expect(defaultOff.writes).toEqual([]);
    expect(defaultOff.draft.relations).toContain('negation');
  });

  it('a judge answering AGAINST the deterministic relation does not change the turn (AC25)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => judgeAnswer('continuation'));
    const state = await runNegotiation({
      provider: createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const consult = state.events.find((event) => event.eventType === 'judgment.consulted');
    expect(consult?.fields).toMatchObject({
      operation: 'jev_decide',
      choice: 'continuation',
      deterministicRelation: 'negation',
    });
    // Deterministic value is authoritative: negation, no continuation, no write.
    expect(state.draft.relations).toContain('negation');
    expect(state.draft.relations).not.toContain('continuation');
    expect(state.writes).toEqual([]);
  });

  it('a correction-derived memory shows up in the recall block of a real turn', async () => {
    const sql: MemorySqlMock = createMemorySql();
    initializeMemorySchema(sql);

    const learned = await learnFromTurn(sql, {
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      userText: 'Na verdade, Padaria São José usa a conta account_id=acc_padaria',
      assistantText: 'Corrigido, obrigado.',
      turnCount: 1,
      correction: { target: 'merchant:padaria-sao-jose', field: 'account', turnFingerprint: 'p4-turn-1' },
    });
    expect(learned).toHaveLength(1);
    expect(learned[0]!.kind).toBe('learning');
    expect(learned[0]!.promotable).toBe(false);

    const recalled = recallMemories(sql, { workspaceId: WORKSPACE, actor: ACTOR });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.promotable).toBe(false);
    expect(recalled[0]!.requiresRevalidation).toBe(true);
    const block = renderMemoryBlock(recalled)!;
    expect(block).toContain('acc_padaria');
    expect(block).toContain('revalidar');

    // The same memory reaches the system prompt of a real negotiation turn.
    const state = await runNegotiation();
    expect(state.second.clarification?.text).toBeTruthy();
    const cognition = assembleCognition('o que devo declarar para padaria do bairro?', {
      hooks: { memoryContext: block },
    });
    expect(cognition.system).toContain('acc_padaria');
    expect(cognition.system).toContain('NÃO CONFIÁVEIS');
  });

  it('a promoted user skill is selected inside the shared budget; a removed category is not applied', async () => {
    const sql: MemorySqlMock = createMemorySql();
    initializeUserSkillsSchema(sql);

    const replay: ReplayEvidence = {
      fixturesId: 'fixtures-2026-10-05-p4',
      readOnly: true,
      cases: 20,
      baselineAverage: 0.6,
      candidateAverage: 0.91,
      evalsFrozenAt: '2026-10-05T00:00:00.000Z',
    };
    const safety: SkillSafetyReport = { passed: true, failures: [] };

    const promoted = recordSkillCandidate(sql, {
      workspaceId: WORKSPACE,
      name: 'alias-padaria',
      rule: { merchantPattern: 'padaria do bairro', categoryId: 'cat_padarias' },
      source: 'learn',
      scope: 'user',
    });
    if (!promoted.stored) throw new Error(`candidate refused: ${promoted.code}`);
    recordReplayEvidence(sql, { workspaceId: WORKSPACE, candidateId: promoted.candidate.id, evidence: replay });
    recordSafetyReport(sql, { workspaceId: WORKSPACE, candidateId: promoted.candidate.id, safety });
    const result = promoteSkillCandidate(sql, {
      workspaceId: WORKSPACE,
      candidateId: promoted.candidate.id,
      approvedBy: 'operator@pi',
    });
    expect(result.promoted).toBe(true);

    const active = listActiveUserSkills(sql, WORKSPACE);
    expect(active).toHaveLength(1);
    const skills = toSelectableSkills(active, await reader.listCategories());
    expect(skills).toHaveLength(1);

    // Same heuristic, same budget, same tool catalog as core skills.
    const fit = fitSkills('gastei na padaria do bairro', undefined, skills);
    expect(fit.selected?.name).toBe('alias-padaria');
    expect(renderInjectedSkills(fit)).toContain('Padarias');
    expect(renderInjectedSkills(fit)!.length).toBeLessThanOrEqual(6000);
    const cognition = assembleCognition('gastei na padaria do bairro', { userSkills: skills });
    expect(cognition.system).toContain('Preferência do usuário');

    // The same rule against a catalog WITHOUT the category does not apply — it
    // is dropped, never turned into a category.
    const removed = toSelectableSkills(active, [{ id: 'cat_mercado', name: 'Mercado' }]);
    expect(removed).toHaveLength(0);
    const fitWithout = fitSkills('gastei na padaria do bairro', undefined, removed);
    expect(fitWithout.injected.map((skill) => skill.name)).not.toContain('alias-padaria');
  });
});