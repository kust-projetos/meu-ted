/**
 * P2 (2026-10-04) — EXECUTABLE PER-ROUTE CONTRACT for the evidence read path.
 *
 * The chain under test, end to end, with only the TRANSPORT faked:
 *
 *   real API route (apps/api, `buildTestApp` in-memory composition)
 *     -> REAL generated client (`src/generated/http-tools.ts`: `execute` +
 *        `project`) -> channel-evidence mapping (`mapAccounts`,
 *        `mapEntityList`, `mapAnalytics`) -> validated proof envelope
 *        (`declareAnalyticsEnvelope`).
 *
 * Why this file exists: every other suite in this package feeds the mappers a
 * hand-written object. A hand-written object can drift from the routes forever
 * without anything failing — that is exactly how `{ accounts: [...] }` (a shape
 * no route ever answers) stayed green while `readListPayload` was proving, in
 * production, that the workspace was empty. Route-faithful fixtures are better,
 * but a fixture is still a CLAIM about the route. Here the route answers.
 *
 * The single faked layer is `globalThis.fetch`, replaced by an adapter that
 * forwards the request into `app.inject` and returns a real `Response`. It
 * carries NO payload assumptions: it does not know, assert or reshape any body.
 * The only things it rewrites are the auth HEADER NAME (see `installBridge`),
 * because the production client sends the turn credential as
 * `authorization: Bearer <delegatedToken>` while `buildTestApp` (a composition
 * without better-auth) resolves the device token from `x-device-token`, and the
 * optional `faults` map (a route answered by the TRANSPORT with a chosen
 * status, for the failure paths where no test app answers that way).
 *
 * TYPECHECK: this file is listed in `apps/agent/tsconfig.json#exclude`. Being in
 * the agent's `tsc` program would pull the whole api route tree in, and
 * `api/src/auth/delegated-token.ts` + `api/src/push/vapid.ts` do not compile
 * under the agent's `lib`/`types` (they are green under the api's own
 * `tsc -p tsconfig.build.json`). The file itself is type-clean — with the
 * exclusion lifted, those two api files are the ONLY errors the program reports
 * — and it is still linted by `biome check tests`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_A1,
  ACCOUNT_A2,
  CARD_A1,
  CATEGORY_FOOD_A,
  CATEGORY_RENT_A,
  CATEGORY_SALARY_A,
  HOUSEHOLD_A,
  TRANSACTIONS,
} from '../../../api/tests/fixtures/seed.js';
import { buildTestApp, TOKEN_A } from '../../../api/tests/test-app.js';
import { declareAnalyticsEnvelope } from '../../src/agent-config/analytics-envelope.js';
import {
  analyticsCategoryBreakdownTool,
  analyticsKpisTool,
  listAccountsTool,
  listCategoriesTool,
  listRecentTransactionsTool,
  type ToolRequestAuth,
} from '../../src/generated/http-tools.js';
import { normalizeEntities } from '../../src/mutations/entity-resolver.js';
import {
  createChannelGrounding,
  defaultChannelReadTools,
  type ChannelReadTools,
} from '../../src/orchestration/channel-evidence.js';
import type { TurnInput, TurnPlan } from '../../src/orchestration/conversation-orchestrator.js';

type TestApp = ReturnType<typeof buildTestApp>;
type GeneratedTool = { execute: (...args: never[]) => Promise<unknown> };

/** Dummy https origin: the client builds absolute URLs from it; the bridge forwards every path. */
const API_ORIGIN = 'https://api.bridge.test';

/**
 * The seed transactions are dated 2026-06, so the analytics reads are pinned to
 * a CUSTOM window around them. `period` defaults to `last30days`, which would
 * make this suite depend on the day it runs.
 */
const WINDOW = { period: 'custom', from: '2026-06-01', to: '2026-06-30' } as const;

const seededApp = (): TestApp =>
  buildTestApp({
    accounts: [ACCOUNT_A1, ACCOUNT_A2, CARD_A1],
    categories: [CATEGORY_FOOD_A, CATEGORY_RENT_A, CATEGORY_SALARY_A],
    transactions: TRANSACTIONS,
  });

const emptyApp = (): TestApp => buildTestApp({ accounts: [], categories: [], transactions: [] });

const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const rowsOf = (value: unknown): Record<string, unknown>[] => value as Record<string, unknown>[];

/** A status/body the TRANSPORT answers for one path, instead of `app.inject`. */
type BridgeFault = Readonly<{ status: number; body: unknown }>;

/**
 * Replaces `globalThis.fetch` with an `app.inject` bridge.
 *
 * TRANSPORT-LEVEL AUTH WIRING — the only adaptation performed here, and it is a
 * header NAME, not a payload: `requestPiApiJson` sends
 * `authorization: Bearer <delegatedToken>`; the in-memory API composition
 * resolves identity from `x-device-token`. Production resolves the same
 * delegated credential on its own path; the rename keeps the credential
 * identical and stays confined to the transport.
 *
 * `faults` (optional, keyed by `pathname`) is the ONLY way a route in this file
 * fails: the bridge answers that path with the given status and JSON body and
 * never reaches `app.inject`, while every other path is forwarded normally. A
 * failure therefore has to survive the REAL generated client — the client
 * still issues the request, still parses the non-2xx, and still throws.
 */
const installBridge = (
  built: TestApp,
  faults: Readonly<Record<string, BridgeFault>> = {},
): Array<{ method: string; path: string }> => {
  const requests: Array<{ method: string; path: string }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
    headers.delete('authorization');
    if (bearer) headers.set('x-device-token', bearer);
    const path = `${url.pathname}${url.search}`;
    requests.push({ method: init?.method ?? 'GET', path });
    const fault = faults[url.pathname];
    if (fault) {
      return new Response(JSON.stringify(fault.body), {
        status: fault.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    const forwarded: Record<string, string> = {};
    headers.forEach((value, key) => {
      forwarded[key] = value;
    });
    const injected = await built.app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: path,
      headers: forwarded,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(injected.body, {
      status: injected.statusCode,
      headers: injected.headers as unknown as HeadersInit,
    });
  }) as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  return requests;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The exact call `channel-evidence.bindGenerated` makes for an evidence read. */
const auth: ToolRequestAuth = { delegatedToken: TOKEN_A, apiOrigin: API_ORIGIN };

const read = async (tool: GeneratedTool, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await tool.execute(
    'evidence-read' as never,
    params as never,
    undefined as never,
    undefined as never,
    auth as never,
  )) as Record<string, unknown>;

const inputFor = (workspaceId: string): TurnInput =>
  ({
    intentionId: 'intent-api-evidence-contract',
    traceId: 'intent-api-evidence-contract',
    text: 'qual meu saldo?',
    actorId: 'actor-contract',
    workspaceId,
    role: 'member',
    deviceId: 'dev-device-1',
    attachments: [],
    channel: 'pwa-rest',
  }) as TurnInput;

/** `general` has no domain fallback read, so exactly the planned reads run. */
const planFor = (operations: string[]): TurnPlan => ({
  version: '2',
  mode: 'read',
  domain: 'general',
  skillNames: ['s'],
  requestedOperations: operations.map((name) => ({ name, kind: 'read' })),
  missingFields: [],
  ambiguity: null,
  confidence: 1,
});

/**
 * The generated tools, with the two analytics reads pinned to `WINDOW`. The turn
 * path normalises its own window to the CURRENT month (`normalizeAnalyticsQuery`),
 * which would answer "empty" for a 2026-06 seed on any other month — the window
 * here is the only thing this file overrides, and it overrides it on the real
 * tools, not on the mapping.
 */
const windowedReadTools = (): ChannelReadTools => ({
  ...defaultChannelReadTools(),
  analyticsKpis: (params, requestAuth) =>
    analyticsKpisTool.execute(
      'evidence-read',
      { ...params, ...WINDOW },
      undefined,
      undefined,
      requestAuth ?? auth,
    ) as Promise<unknown>,
  analyticsCategoryBreakdown: (params, requestAuth) =>
    analyticsCategoryBreakdownTool.execute(
      'evidence-read',
      { ...params, ...WINDOW },
      undefined,
      undefined,
      requestAuth ?? auth,
    ) as Promise<unknown>,
});

const evidenceOver = async (
  app: TestApp,
  operations: string[],
  readTools: ChannelReadTools = windowedReadTools(),
) => {
  installBridge(app);
  const grounding = createChannelGrounding({
    respond: async () => 'unused',
    readTools,
    readToken: async () => TOKEN_A,
    apiOrigin: API_ORIGIN,
    events: () => {},
  });
  const envelope = await grounding.evidenceProvider(inputFor(HOUSEHOLD_A), planFor(operations));
  if (!envelope) throw new Error('envelope.expected');
  return envelope;
};

describe('contrato executavel por rota: rota real -> cliente gerado real -> evidencia', () => {
  describe('GET /accounts', () => {
    it('a projected list carries the items discriminant and real account rows', async () => {
      const app = seededApp();
      const requests = installBridge(app);
      const result = await read(listAccountsTool, { householdId: HOUSEHOLD_A });

      expect(requests.map((request) => request.path)).toEqual(['/accounts']);
      // The discriminant `readListPayload` requires before anything else.
      expect(Array.isArray(result['items'])).toBe(true);
      // ... and the key the generated projection manufactures on top of it.
      // Projection keys follow the `x-pi-tool` field names (`balance_cents`),
      // whose SOURCE PATH is the real route field (`balanceCents`) — so the
      // amount the route answered survives the projection.
      expect(result['accounts']).toEqual([
        { id: ACCOUNT_A1.id, name: ACCOUNT_A1.name, kind: 'bank', balance_cents: ACCOUNT_A1.balanceCents, active: true },
        { id: ACCOUNT_A2.id, name: ACCOUNT_A2.name, kind: 'bank', balance_cents: ACCOUNT_A2.balanceCents, active: true },
      ]);
      expect(result['total']).toBe(2);

      const items = rowsOf(result['items']);
      expect(items.map((row) => row['name'])).toEqual(['Itaú', 'Nubank']);
      for (const row of items) {
        expect(row).toMatchObject({ householdId: HOUSEHOLD_A, kind: 'bank', status: 'active' });
        expect(typeof row['id']).toBe('string');
        expect(typeof row['balanceCents']).toBe('number');
      }
    });

    it('never answers a credit_card row: cards are served by the CardStore', async () => {
      const app = seededApp();
      installBridge(app);
      const result = await read(listAccountsTool, { householdId: HOUSEHOLD_A });
      // CARD_A1 is in the seed; the route excludes credit_card in BOTH
      // includeInactive branches, so a grounding pool fed by this read has no
      // card debt to mislabel as an available balance.
      expect(rowsOf(result['items']).map((row) => row['name'])).not.toContain(CARD_A1.name);
    });

    it('normalizeEntities parses the RAW route payload with scopeId === householdId', async () => {
      const app = seededApp();
      // Raw, pre-projection body — what the entity resolver's request seam gets.
      const injected = await app.app.inject({
        method: 'GET',
        url: '/accounts',
        headers: { 'x-device-token': TOKEN_A },
      });
      expect(injected.statusCode).toBe(200);
      const entities = normalizeEntities(JSON.parse(injected.body) as unknown);
      expect(entities.map((entity) => entity.name)).toEqual(['Itaú', 'Nubank']);
      for (const entity of entities) {
        expect(entity.scopeId).toBe(HOUSEHOLD_A);
        expect(entity.status).toBe('active');
      }
    });

    it('maps to `ok` evidence through the REAL payload (never permanent_error)', async () => {
      const app = seededApp();
      const envelope = await evidenceOver(app, ['list_accounts']);
      // One item per projected row — the seed has two active bank accounts.
      expect(envelope.items).toHaveLength(2);
      expect(envelope.items.map((item) => record(item.data)['accountName'])).toEqual(['Itaú', 'Nubank']);
      const item = envelope.items[0]!;
      expect(item.status).toBe('ok');
      expect(item.source).toBe('api.accounts');
      expect('reason' in item).toBe(false);
      expect(item.ref).toBe(`account:${ACCOUNT_A1.id}`);
      expect(item.data).toMatchObject({
        accountName: 'Itaú',
        balanceCents: ACCOUNT_A1.balanceCents,
        kind: 'bank',
      });
    });
  });

  describe('GET /categories', () => {
    it('a projected list carries the items discriminant and real category rows', async () => {
      const app = seededApp();
      installBridge(app);
      const result = await read(listCategoriesTool, { householdId: HOUSEHOLD_A });

      expect(Array.isArray(result['items'])).toBe(true);
      expect(Array.isArray(result['categories'])).toBe(true);
      expect(result['categories']).toEqual([
        { id: CATEGORY_FOOD_A.id, name: CATEGORY_FOOD_A.name, kind: 'expense', status: 'active' },
        { id: CATEGORY_RENT_A.id, name: CATEGORY_RENT_A.name, kind: 'expense', status: 'active' },
        { id: CATEGORY_SALARY_A.id, name: CATEGORY_SALARY_A.name, kind: 'income', status: 'active' },
      ]);
      expect(result['total']).toBe(3);
      for (const row of rowsOf(result['items'])) {
        expect(row).toMatchObject({ householdId: HOUSEHOLD_A, status: 'active' });
        expect(typeof row['id']).toBe('string');
        expect(typeof row['name']).toBe('string');
        expect(['expense', 'income']).toContain(row['kind']);
      }
    });

    it('maps to `ok` evidence through the REAL payload', async () => {
      const app = seededApp();
      const envelope = await evidenceOver(app, ['list_categories']);
      expect(envelope.items).toHaveLength(1);
      expect(envelope.items[0]!.status).toBe('ok');
      expect(envelope.items[0]!.source).toBe('api.categories');
    });
  });

  describe('GET /transactions', () => {
    it('carries items, total, limit and offset — the shape the mappers read', async () => {
      const app = seededApp();
      installBridge(app);
      const result = await read(listRecentTransactionsTool, { householdId: HOUSEHOLD_A, limit: 20 });

      expect(Array.isArray(result['items'])).toBe(true);
      expect(Array.isArray(result['transactions'])).toBe(true);
      expect(result['total']).toBe(4); // 2 expenses + 1 income + 1 transfer, household A
      expect(result['limit']).toBe(20);
      expect(result['offset']).toBe(0);
      for (const row of rowsOf(result['items'])) {
        expect(row).toMatchObject({ householdId: HOUSEHOLD_A });
        expect(typeof row['description']).toBe('string');
        expect(typeof row['date']).toBe('string');
        expect(typeof row['amountCents']).toBe('number');
      }
      const projected = rowsOf(result['transactions']);
      expect(projected).toHaveLength(4);
      for (const row of projected) {
        expect(row).toMatchObject({
          id: expect.any(String),
          description: expect.any(String),
          amount_cents: expect.any(Number),
          date: expect.any(String),
          kind: expect.any(String),
          account_id: ACCOUNT_A1.id,
        });
      }
    });

    it('maps to `ok` evidence with the projected statement rows', async () => {
      const app = seededApp();
      const envelope = await evidenceOver(app, ['list_recent_transactions']);
      expect(envelope.items).toHaveLength(1);
      expect(envelope.items[0]!.status).toBe('ok');
      expect(envelope.items[0]!.source).toBe('api.transactions');
      expect(Array.isArray(envelope.items[0]!.data)).toBe(true);
    });
  });

  describe('GET /analytics/kpis', () => {
    it('answers the flat real shape with the proof fields the envelope gate needs', async () => {
      const app = seededApp();
      installBridge(app);
      const result = await read(analyticsKpisTool, { householdId: HOUSEHOLD_A, ...WINDOW });

      expect(result['period']).toEqual({ from: WINDOW.from, to: WINDOW.to });
      expect(record(result['previousPeriod'])).toMatchObject({
        from: expect.any(String),
        to: expect.any(String),
      });
      expect(result).toMatchObject({
        accountsTotalCents: ACCOUNT_A1.balanceCents + ACCOUNT_A2.balanceCents,
        dueSoonCents: 0,
        incomeCents: 1_200_000,
        expenseCents: 288_050,
        previousIncomeCents: 0,
        previousExpenseCents: 0,
        savingsRatePct: 76,
        savingsRateTargetPct: 20,
      });
      for (const key of ['netLiquidBalanceCents', 'netWorthCents', 'previousSavingsRatePct']) {
        expect(result).toHaveProperty(key);
      }
      const openInvoices = record(result['openInvoices']);
      expect(typeof openInvoices['committedCents']).toBe('number');
      expect(typeof openInvoices['limitCents']).toBe('number');
      expect(typeof record(result['fixedVsDiscretionary'])['fixedCents']).toBe('number');
      // There is no `balanceCents` on the KPIs route: net worth is declared by
      // `netLiquidBalanceCents`/`netWorthCents`, and a fixture that invented
      // `balanceCents` was asserting a field the API never sends.
      expect(result).not.toHaveProperty('balanceCents');

      // Proof envelope (G03), flat on the response exactly as the route spreads
      // it: `transactionCount`, `asOf`, `basis`, `semanticsVersion`,
      // `effectiveFilter`, `emptyReason`.
      expect(result).toMatchObject({
        transactionCount: 3, // the transfer is never summed, so never counted
        basis: 'liquidez',
        semanticsVersion: '1',
        emptyReason: null,
        effectiveFilter: { period: 'custom', from: WINDOW.from, to: WINDOW.to, accountId: null },
      });
      expect(typeof result['asOf']).toBe('string');
    });

    it('the REAL payload satisfies the agent proof gate, with the API basis passed through', async () => {
      const app = seededApp();
      installBridge(app);
      const result = await read(analyticsKpisTool, { householdId: HOUSEHOLD_A, ...WINDOW });

      const declared = declareAnalyticsEnvelope(result);
      if (!declared.ok) throw new Error(declared.message);
      // `declareAnalyticsEnvelope` only reaches `ok` through `period`, the very
      // `period{from,to}` the route returned — nothing here is hand-built.
      expect(declared.response).toMatchObject({
        effectivePeriod: { from: WINDOW.from, to: WINDOW.to },
        basis: result['basis'],
        transactionCount: 3,
        semanticsVersion: '1',
      });
    });

    it('maps to `ok` evidence carrying the declared proof', async () => {
      const app = seededApp();
      const envelope = await evidenceOver(app, ['analytics_kpis']);
      expect(envelope.items).toHaveLength(1);
      const item = envelope.items[0]!;
      expect(item.status).toBe('ok');
      expect(item.source).toBe('api.analytics.kpis');
      expect(item.data).toMatchObject({ effectivePeriod: { from: WINDOW.from, to: WINDOW.to }, basis: 'liquidez' });
    });
  });

  describe('GET /analytics/category-breakdown', () => {
    it('answers slices plus the same proof fields', async () => {
      const app = seededApp();
      installBridge(app);
      const result = await read(analyticsCategoryBreakdownTool, {
        householdId: HOUSEHOLD_A,
        kind: 'expense',
        ...WINDOW,
      });

      expect(result['period']).toEqual({ from: WINDOW.from, to: WINDOW.to });
      const slices = result['slices'];
      expect(Array.isArray(slices)).toBe(true);
      expect(slices).toHaveLength(2); // Mercado + Aluguel
      for (const slice of rowsOf(slices)) {
        expect(typeof slice['categoryId']).toBe('string');
        expect(typeof slice['name']).toBe('string');
        expect(typeof slice['totalCents']).toBe('number');
        expect(typeof slice['pct']).toBe('number');
      }
      // The breakdown reads only CATEGORISED rows, so it counts 2 while `kpis`
      // counts 3 (income included) — two declared universes, never merged.
      expect(result).toMatchObject({
        kind: 'expense',
        transactionCount: 2,
        semanticsVersion: '1',
        emptyReason: null,
      });
      expect(typeof result['asOf']).toBe('string');
      expect(declareAnalyticsEnvelope(result).ok).toBe(true);
    });

    it('maps to `ok` evidence through the REAL payload', async () => {
      const app = seededApp();
      const envelope = await evidenceOver(app, ['analytics_category_breakdown']);
      expect(envelope.items).toHaveLength(1);
      expect(envelope.items[0]!.status).toBe('ok');
      expect(envelope.items[0]!.source).toBe('api.analytics.category-breakdown');
    });
  });
});

describe('proveniencia de ausencia vem do payload REAL (workspace vazio)', () => {
  it('kpis responde transactionCount 0 com emptyReason fechado, e a evidencia vira period_empty', async () => {
    const app = emptyApp();
    installBridge(app);
    const result = await read(analyticsKpisTool, { householdId: HOUSEHOLD_A, ...WINDOW });
    expect(result['transactionCount']).toBe(0);
    // Closed enum (apps/api/src/analytics/types.ts): a guess would be a lie.
    expect(result['emptyReason']).toBe('no_transactions_in_period');

    const envelope = await evidenceOver(app, ['analytics_kpis', 'list_accounts']);
    const kpis = envelope.items.find((item) => item.source === 'api.analytics.kpis')!;
    expect(kpis.status).toBe('empty');
    expect(kpis.reason).toBe('period_empty');
    expect(kpis.data).toEqual([]);
  });

  it('accounts vazio e ausencia legitima (items: []), nunca erro', async () => {
    const app = emptyApp();
    installBridge(app);
    const result = await read(listAccountsTool, { householdId: HOUSEHOLD_A });
    expect(result['items']).toEqual([]);
    expect(result['total']).toBe(0);
    expect(Array.isArray(result['accounts'])).toBe(true);

    const envelope = await evidenceOver(app, ['list_accounts']);
    const accounts = envelope.items[0]!;
    expect(accounts.status).toBe('empty');
    expect(accounts.reason).toBe('setup_incomplete');
    expect(accounts.data).toEqual([]);
  });

  it('um payload FORA do contrato nunca vira "workspace vazio" (falha no TRANSPORTE, cliente real)', async () => {
    // The negative binding of the whole chain: an UNMODIFIED real read tool,
    // reading a route the TRANSPORT answers 500. Nothing is stubbed above the
    // wire — no fabricated tool error — so a regression that turned an HTTP 500
    // into an ABSENCE anywhere in the real client/bridge (`requestPiApiJson`
    // swallowing the non-2xx, a mapper reading the error body as an empty list,
    // `classifyReadFailure` degrading it to a no-rows outcome) would surface as
    // `empty`/`workspace_empty` here and fail.
    //
    // Chain now under test: transport 500 -> real `requestPiApiJson` non-2xx
    // handling (throws with `statusCode`) -> real channel-evidence catch ->
    // `classifyReadFailure` -> `error`/`retryable_error` (500 is a server
    // fault), `data: null`. The envelope is never null and never absent.
    const app = seededApp();
    const requests = installBridge(app, {
      '/accounts': { status: 500, body: { code: 'internal_error', message: 'accounts unavailable' } },
    });
    const grounding = createChannelGrounding({
      respond: async () => 'unused',
      readTools: defaultChannelReadTools(),
      readToken: async () => TOKEN_A,
      apiOrigin: API_ORIGIN,
      events: () => {},
    });
    const envelope = await grounding.evidenceProvider(inputFor(HOUSEHOLD_A), planFor(['list_accounts']));
    // The REAL client really did issue the read it then failed on.
    expect(requests.map((request) => request.path)).toEqual(['/accounts']);
    expect(envelope).not.toBeNull();
    const item = envelope!.items[0]!;
    expect(item.status).toBe('error');
    expect(item.data).toBeNull();
    expect(item.reason).toBe('retryable_error');
    // Absence lives on the OTHER axis; a failed read may never carry it.
    expect(['setup_incomplete', 'period_empty']).not.toContain(item.reason);
  });
});