/**
 * Draft follow-up date defects — TDD.
 *
 * (A) Security-review hypothesis: an UNRESOLVED absolute date in the turn
 * that completes a draft must never be silently dropped while the draft
 * proposes with the STALE stored date ("categoria mercado dia 15" proposed
 * with the old date, "dia 15" ignored).
 *
 * (B) Independent finding: a bare relative date ("ontem") must correct the
 * draft's date WITHOUT becoming `categoryQuery` ("ontem"), even though no
 * category named "ontem" exists.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../src/mutations/mutation-draft.js';
import type { EntityReader } from '../src/mutations/entity-resolver.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-draft-date',
  workspaceId: 'workspace-draft-date',
  role: 'member',
  deviceId: 'device-draft-date',
};

const ACCOUNT_NUBANK = { id: '00000000-0000-4000-8000-000000000001', name: 'Nubank' };
const CATEGORY_MERCADO = { id: '00000000-0000-4000-8000-000000000011', name: 'Mercado' };
const CATEGORY_SAUDE = { id: '00000000-0000-4000-8000-000000000012', name: 'Saude' };

const NOW_MS = Date.parse('2026-10-20T12:00:00Z');
const TODAY = '2026-10-20';
const YESTERDAY = '2026-10-19';

const harness = () => {
  let now = NOW_MS;
  const store = new InMemoryMutationDraftStore();
  const request = vi.fn().mockImplementation(async (method: string, path: string) => {
    if (method === 'POST' && path === '/pending-operations/v2/propose') return { id: 'op-draft-date-1' };
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = new MutationApiClient({ request });
  const reader: EntityReader = {
    listAccounts: async () => [ACCOUNT_NUBANK],
    listCategories: async () => [CATEGORY_MERCADO, CATEGORY_SAUDE],
  };
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: reader,
    draftStore: store,
    draftNow: () => now,
    events: () => undefined,
  });
  const actives = () =>
    store.listActive(
      { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null },
      now + 60_000,
    );
  return { store, request, orchestrator, actives };
};

const openCategoryPendingDraft = async (h: ReturnType<typeof harness>, tag: string) => {
  const r1 = await h.orchestrator.runTurn(
    normalizeRestTurn({ text: 'gastei 50 no nubank', intentionId: `${tag}-t1` }, identity),
  );
  expect(r1.mutation).toBeUndefined();
  const drafts = h.actives();
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.missingFields).toContain('categoryId');
  expect(drafts[0]!.resolvedArgs.date).toBe(TODAY);
};

describe('draft follow-up absolute date (A) — never propose with a stale date', () => {
  it('a completing turn carrying "dia 15" clarifies instead of proposing', async () => {
    const h = harness();
    await openCategoryPendingDraft(h, 'a1');
    const r2 = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'categoria mercado dia 15', intentionId: 'a1-t2' }, identity),
    );
    // Fail-closed: no proposal — the explicit date was NOT understood.
    expect(h.request).not.toHaveBeenCalled();
    expect(r2.mutation).toBeUndefined();
    // The draft survives untouched: stale date kept, nothing invented.
    const drafts = h.actives();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.resolvedArgs.date).toBe(TODAY);
    expect(drafts[0]!.missingFields).toContain('categoryId');
    expect(drafts[0]!.resolvedArgs.categoryQuery).toBeUndefined();
    // Honest copy: names the only supported dates.
    const copy = r2.clarification?.text ?? r2.response?.text ?? '';
    const lower = copy.toLowerCase();
    expect(lower).toContain('hoje');
    expect(lower).toContain('ontem');
    expect(lower).toContain('anteontem');
  });

  it('a plain category answer still completes the draft (regression guard)', async () => {
    const h = harness();
    await openCategoryPendingDraft(h, 'a2');
    const r2 = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'categoria mercado', intentionId: 'a2-t2' }, identity),
    );
    expect(r2.mutation?.status).toBe('proposed');
    expect(h.request).toHaveBeenCalledTimes(1);
    const body = h.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({
      amountCents: 5000,
      accountId: ACCOUNT_NUBANK.id,
      categoryId: CATEGORY_MERCADO.id,
      date: TODAY,
    });
  });

  it('a relative date plus a category still completes with the relative date (control)', async () => {
    const h = harness();
    await openCategoryPendingDraft(h, 'a3');
    const r2 = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'categoria mercado ontem', intentionId: 'a3-t2' }, identity),
    );
    expect(r2.mutation?.status).toBe('proposed');
    expect(h.request).toHaveBeenCalledTimes(1);
    const body = h.request.mock.calls[0]?.[2] as { body?: { normalizedArgs?: Record<string, unknown> } };
    expect(body?.body?.normalizedArgs).toMatchObject({
      amountCents: 5000,
      accountId: ACCOUNT_NUBANK.id,
      categoryId: CATEGORY_MERCADO.id,
      date: YESTERDAY,
    });
  });

  it('relative + absolute together clarify instead of proposing (combination)', async () => {
    const h = harness();
    await openCategoryPendingDraft(h, 'a4');
    const r2 = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'categoria mercado ontem dia 15', intentionId: 'a4-t2' }, identity),
    );
    // Fail-closed: two date signals, one of them not understood — no proposal,
    // no date write (neither ontem nor the stale date may win silently).
    expect(h.request).not.toHaveBeenCalled();
    expect(r2.mutation).toBeUndefined();
    const drafts = h.actives();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.resolvedArgs.date).toBe(TODAY);
    expect(drafts[0]!.missingFields).toContain('categoryId');
    expect(drafts[0]!.resolvedArgs.categoryQuery).toBeUndefined();
    const copy = r2.clarification?.text ?? r2.response?.text ?? '';
    const lower = copy.toLowerCase();
    expect(lower).toContain('hoje');
    expect(lower).toContain('ontem');
    expect(lower).toContain('anteontem');
  });
});

describe('draft follow-up bare relative date (B) — date-only, never a category', () => {
  it('"ontem" corrects the date without becoming categoryQuery', async () => {
    const h = harness();
    await openCategoryPendingDraft(h, 'b1');
    const r2 = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'ontem', intentionId: 'b1-t2' }, identity),
    );
    expect(h.request).not.toHaveBeenCalled();
    expect(r2.mutation).toBeUndefined();
    const drafts = h.actives();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.resolvedArgs.date).toBe(YESTERDAY);
    expect(drafts[0]!.resolvedArgs.categoryQuery).toBeUndefined();
    expect(drafts[0]!.missingFields).toContain('categoryId');
    // The question is still "which category" — never "category 'ontem' not found".
    const copy = r2.clarification?.text ?? r2.response?.text ?? '';
    expect(copy).not.toMatch(/categoria "ontem"/i);
  });
});

describe('draft follow-up ambiguous abbreviated month — em mar/dez clarifies', () => {
  it.each(['categoria mercado em mar', 'categoria mercado em dez'])(
    'a completing turn carrying "%s" clarifies instead of proposing',
    async (text) => {
      const h = harness();
      await openCategoryPendingDraft(h, `c-${text.length}`);
      const r2 = await h.orchestrator.runTurn(
        normalizeRestTurn({ text, intentionId: `c-t2-${text.length}` }, identity),
      );
      expect(h.request).not.toHaveBeenCalled();
      expect(r2.mutation).toBeUndefined();
      const drafts = h.actives();
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.resolvedArgs.date).toBe(TODAY);
      expect(drafts[0]!.missingFields).toContain('categoryId');
      expect(drafts[0]!.resolvedArgs.categoryQuery).toBeUndefined();
      const copy = (r2.clarification?.text ?? r2.response?.text ?? '').toLowerCase();
      expect(copy).toContain('data');
      expect(copy).toContain('hoje');
      expect(copy).toContain('ontem');
      expect(copy).toContain('anteontem');
    },
  );
});
