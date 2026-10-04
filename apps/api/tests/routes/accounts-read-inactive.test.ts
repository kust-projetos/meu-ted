import { describe, expect, it } from 'vitest';
import { buildTestApp, TOKEN_A, TOKEN_B } from '../test-app.js';
import { ACCOUNT_A1, ACCOUNT_A2, CARD_A1, HOUSEHOLD_B } from '../fixtures/seed.js';
import type { Account } from '../../src/types/domain.js';

/**
 * A08 (R08): `GET /accounts?includeInactive=true` — the opt-in slice that
 * returns DEACTIVATED accounts alongside the active ones.
 *
 * Why the flag exists: the entity resolver can only answer "essa conta está
 * indisponível" if the row is actually readable. The store filters
 * `status = 'active'`, so a deactivated account used to be indistinguishable
 * from one that never existed. The generated agent tool already maps
 * `active` from `status` in `openapi/agent-tools.openapi.json`.
 *
 * Three invariants this file locks:
 * - the DEFAULT never moves (omitted, `false`, empty and garbage all keep the
 *   active-only read);
 * - the widening is workspace-scoped (`household_id` stays the first bind);
 * - `includeInactive` is an AVAILABILITY opt-in, not a `kind` opt-in: credit
 *   cards stay out of the generic account surface even when it is true.
 */

const authA = { 'x-device-token': TOKEN_A };
const authB = { 'x-device-token': TOKEN_B };

/** Deactivated row of household B — visible to B, never to A. */
const INACTIVE_B: Account = {
  id: '11111111-1111-4111-8111-11111111111f',
  householdId: HOUSEHOLD_B,
  name: 'Bradesco antigo',
  kind: 'bank',
  balanceCents: 0,
  status: 'inactive',
};

const buildApp = () => buildTestApp({ accounts: [ACCOUNT_A1, ACCOUNT_A2, CARD_A1, INACTIVE_B], categories: [], transactions: [] });

type Created = { id: string };

const createAndDeactivate = async (app: ReturnType<typeof buildApp>['app'], name: string): Promise<Created> => {
  const created = await app.inject({
    method: 'POST',
    url: '/accounts',
    headers: { ...authA, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    payload: { name, kind: 'cash', initialBalanceCents: 0 },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;

  const deactivated = await app.inject({
    method: 'POST',
    url: `/accounts/${id}/deactivate`,
    headers: { ...authA, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    payload: {},
  });
  expect(deactivated.statusCode).toBe(200);
  return { id };
};

const idsOf = (body: { items?: Array<{ id: string }> }): string[] => (body.items ?? []).map((item) => item.id);

describe('GET /accounts?includeInactive', () => {
  it('returns the deactivated account with its inactive status when opted in', async () => {
    const { app } = buildApp();
    const { id } = await createAndDeactivate(app, 'Carteira velha');

    const response = await app.inject({ method: 'GET', url: '/accounts?includeInactive=true', headers: authA });

    expect(response.statusCode).toBe(200);
    expect(idsOf(response.json())).toContain(id);
    expect(response.json().items.find((item: { id: string }) => item.id === id)).toMatchObject({
      name: 'Carteira velha',
      status: 'inactive',
    });
    // The active rows are still there — the opt-in widens, it does not replace.
    expect(idsOf(response.json())).toEqual(expect.arrayContaining([ACCOUNT_A1.id, ACCOUNT_A2.id]));
  });

  it('keeps the active-only read as the default when the flag is absent', async () => {
    const { app } = buildApp();
    const { id } = await createAndDeactivate(app, 'Carteira velha');

    const response = await app.inject({ method: 'GET', url: '/accounts', headers: authA });

    expect(response.statusCode).toBe(200);
    expect(idsOf(response.json())).not.toContain(id);
    expect(response.json().total).toBe(2); // ACCOUNT_A1 + ACCOUNT_A2
  });

  it('treats the string "false" as OFF (never as truthy input)', async () => {
    const { app } = buildApp();
    const { id } = await createAndDeactivate(app, 'Carteira velha');

    const response = await app.inject({ method: 'GET', url: '/accounts?includeInactive=false', headers: authA });

    expect(response.statusCode).toBe(200);
    expect(idsOf(response.json())).not.toContain(id);
  });

  it('fails closed on a value outside the closed flag set', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/accounts?includeInactive=maybe', headers: authA });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation.error' });
  });

  it('fails closed on a bare flag with no value', async () => {
    const { app } = buildApp();
    const { id } = await createAndDeactivate(app, 'Carteira velha');

    const response = await app.inject({ method: 'GET', url: '/accounts?includeInactive=', headers: authA });

    expect(response.statusCode).toBe(400);
    expect(idsOf(response.json().items ?? [])).not.toContain(id);
  });

  it('never widens across workspaces: household B sees only its own inactive row', async () => {
    const { app } = buildApp();

    const forB = await app.inject({ method: 'GET', url: '/accounts?includeInactive=true', headers: authB });
    const forA = await app.inject({ method: 'GET', url: '/accounts?includeInactive=true', headers: authA });

    expect(forB.statusCode).toBe(200);
    expect(idsOf(forB.json())).toEqual([INACTIVE_B.id]);
    expect(idsOf(forA.json())).not.toContain(INACTIVE_B.id);
    expect(idsOf(forA.json())).toEqual([ACCOUNT_A1.id, ACCOUNT_A2.id]);
  });

  it('keeps credit cards out of the generic account surface even when opted in', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/accounts?includeInactive=true', headers: authA });

    expect(response.statusCode).toBe(200);
    expect(idsOf(response.json())).not.toContain(CARD_A1.id);
  });

  it('composes with the kind filter', async () => {
    const { app } = buildApp();
    const { id } = await createAndDeactivate(app, 'Carteira velha'); // kind: cash

    const cash = await app.inject({ method: 'GET', url: '/accounts?includeInactive=true&kind=cash', headers: authA });

    expect(cash.statusCode).toBe(200);
    expect(idsOf(cash.json())).toEqual([id]);
  });

  it('leaves GET /accounts/:id fail-closed for a deactivated account', async () => {
    const { app } = buildApp();
    const { id } = await createAndDeactivate(app, 'Carteira velha');

    const response = await app.inject({ method: 'GET', url: `/accounts/${id}`, headers: authA });

    expect(response.statusCode).toBe(404);
  });

  it('requires no Idempotency-Key (it is a read)', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/accounts?includeInactive=true', headers: authA });

    expect(response.statusCode).toBe(200);
  });
});