import { describe, expect, it } from 'vitest';
import { parseTedRiskBasedAutoexecute } from '../../src/approvals/authorization-config.js';
import { computePendingOperationV2Hash, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { randomUUID } from 'node:crypto';

describe('TED risk-based autoexecute flag', () => {
  it.each([
    [undefined, 'off'], ['off', 'off'], ['on', 'on'], ['shadow', 'shadow'], ['ON', 'off'], ['enabled', 'off'],
  ] as const)('parses %s as %s (case-sensitive, fail-closed)', (raw, expected) => {
    expect(parseTedRiskBasedAutoexecute(raw)).toBe(expected);
  });
});

it('authorizes a proposed in-memory operation once and persists its decision metadata', async () => {
  const identity = { workspaceId: 'w', actorId: 'a', deviceId: 'd' };
  const args = { description: 'x', amountCents: 3499, date: '2026-10-02', accountId: randomUUID(), categoryId: randomUUID() };
  const base = { version: 2 as const, ...identity, tool: 'transactions.expense.create', normalizedArgs: args, proposalHash: '', idempotencyKey: randomUUID(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), bindings: identity };
  const proposal: PendingOperationV2 = { ...base, proposalHash: await computePendingOperationV2Hash(base) };
  const store = createInMemoryPendingOperationV2Store();
  const saved = await store.propose(proposal);
  const authorized = await store.authorize(saved.id, identity, { mode: 'auto', reason: 'explicit_low_risk', riskTier: 'low' });
  expect(authorized).toMatchObject({ status: 'confirmed', authorizationMode: 'auto', authorizationReason: 'explicit_low_risk', riskTier: 'low' });
  expect(authorized.authorizedAt).toBeTruthy();
  expect(store.audit.at(-1)?.event).toBe('authorize');
  await expect(store.authorize(saved.id, identity, { mode: 'auto', reason: 'explicit_low_risk', riskTier: 'low' })).rejects.toMatchObject({ code: 'approval.not_pending' });
});

it('manual confirmation stores explicit or backwards-compatible authorization metadata', async () => {
  const identity = { workspaceId: 'w', actorId: 'a', deviceId: 'd' };
  const createProposal = async (key: string): Promise<PendingOperationV2> => {
    const base = { version: 2 as const, ...identity, tool: 'transactions.expense.create', normalizedArgs: { description: 'x', amountCents: 50_000, date: '2026-10-02', accountId: randomUUID(), categoryId: randomUUID() }, proposalHash: '', idempotencyKey: key, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), bindings: identity };
    return { ...base, proposalHash: await computePendingOperationV2Hash(base) };
  };
  const store = createInMemoryPendingOperationV2Store();
  const explicit = await store.propose(await createProposal('manual-explicit'));
  const confirmed = await store.confirm(explicit.id, identity, { mode: 'manual', reason: 'high_value', riskTier: 'high' });
  expect(confirmed).toMatchObject({ authorizationMode: 'manual', authorizationReason: 'high_value', riskTier: 'high' });
  const legacy = await store.propose(await createProposal('manual-default'));
  expect(await store.confirm(legacy.id, identity)).toMatchObject({ authorizationMode: 'manual', authorizationReason: 'policy_required', riskTier: null });
});
