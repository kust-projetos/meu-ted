// SPIKE 05L — list_categories como ferramenta nativa de leitura (determinístico, sem LLM).
//
// Cobre o fatiamento mínimo: TOOL_DEFS + validateToolArgs/knownKeys/routeFor +
// executors + finance-transport (ALLOWED_PATHS/METHODS) + finance-bridge
// (pathname gate, buildTestApp real) + plugin genérico (for..of TOOL_DEFS, sem
// alteração) + facade do gateway. Nenhuma escrita nova: só GET /categories;
// confirm/cancel/execute seguem fora do allowlist; FORBIDDEN_KEYS intactas.
//
// Run (cwd = experiments/ted-runtime/bootstrap):
//   node --test spike-05l-category-tool.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TED = path.join(HERE, '..');
const BOOT = HERE;
const requireBoot = createRequire(path.join(BOOT, 'run-identity.mjs'));

process.env.TED_HOME_ROOT = TED;
const { setupIsolation } = requireBoot('./env.cjs');

// Synthetic identities (mesmo mapeamento do test-app real:
// dev-token-1 -> HOUSEHOLD_A, dev-token-2 -> HOUSEHOLD_B). Nunca credencial real.
const HOST_A = { label: 'A', token: 'dev-token-1', household: 'HOUSEHOLD_A', actorId: 'dev-device-1', deviceId: 'dev-device-1' };
const HOST_B = { label: 'B', token: 'dev-token-2', household: 'HOUSEHOLD_B', actorId: 'dev-device-2', deviceId: 'dev-device-2' };

let gw;
let env;
let A;
let B;

describe('spike-05L list_categories (native read-only, real authority)', () => {
  before(async () => {
    setupIsolation('c');
    gw = await import('./ted-gateway.mjs');
    env = await gw.createTedEnvironment({ identity: 'c' });
    A = env.facadeFor(HOST_A);
    B = env.facadeFor(HOST_B);
  });

  after(async () => {
    await env.close().catch(() => {});
  });

  it('(def) TOOL_DEFS lista list_categories com input fechado e output schema', async () => {
    const tools = await import('./ted-finance-tools.mjs');
    const def = tools.TOOL_DEFS.find((t) => t.name === 'list_categories');
    assert.ok(def, 'TOOL_DEFS must include list_categories');
    assert.equal(def.input.additionalProperties, false);
    assert.deepEqual(def.input.properties.kind.enum, ['expense', 'income']);
    assert.deepEqual(def.input.required, []);
    assert.ok(def.output && typeof def.output === 'object', 'output schema required (native prompt-loop)');
    // Nenhuma escrita nova: só esta leitura foi adicionada; confirm/cancel/execute seguem ausentes.
    const names = tools.TOOL_DEFS.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_month_summary', 'list_accounts', 'list_categories', 'propose_expense']);
    for (const banned of ['confirm_expense', 'cancel_expense', 'execute_expense', 'confirm', 'cancel', 'execute']) {
      assert.ok(!names.includes(banned), `${banned} must not exist as a tool`);
    }
  });

  it('(args) validateToolArgs: forma válida passa; identidade/smuggling e kind não-string rejeitados pré-transporte', async () => {
    const { validateToolArgs } = await import('./ted-finance-tools.mjs');
    assert.deepEqual(validateToolArgs('list_categories', {}), {});
    assert.deepEqual(validateToolArgs('list_categories', { kind: 'expense' }), { kind: 'expense' });
    for (const k of ['actorId', 'workspaceId', 'token', 'deviceId', 'intentionId', 'idempotencyKey', 'callId', 'householdId']) {
      assert.throws(() => validateToolArgs('list_categories', { [k]: 'x' }), /forbidden|host-bound/, `identity key '${k}' rejected`);
    }
    assert.throws(() => validateToolArgs('list_categories', { kind: 1 }), /kind/);
    assert.throws(() => validateToolArgs('list_categories', { bogus: 'x' }), /unknown arg/);
  });

  it('(route) allowlist exata: /categories legível GET-only; prefixos e POST barrados pré-spawn', async () => {
    const { isRouteAllowlisted } = await import('./finance-transport.mjs');
    assert.equal(isRouteAllowlisted('/categories'), true);
    assert.equal(isRouteAllowlisted('/categories?kind=expense'), true);
    for (const hostile of ['/categories/123', '/categories/tree', '/categories-extra', '/categorias']) {
      assert.equal(isRouteAllowlisted(hostile), false, `${hostile} must not be allowlisted`);
    }
    const { callFinance } = await import('./finance-transport.mjs');
    const bad = await callFinance({ route: '/categories', method: 'POST', host: HOST_A }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, error: e }),
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'tool.invalid_args');
  });

  it('(e2e) list_accounts + list_categories resolvem ids reais; propose usa a categoria listada (nunca inventada)', async () => {
    const accounts = await A.list_accounts({});
    assert.equal(accounts.total, 2);
    const itau = accounts.items.find((a) => a.name === 'Itaú');
    assert.ok(itau && typeof itau.id === 'string', 'Itaú account resolved from real listing');

    const cats = await A.list_categories({ kind: 'expense' });
    assert.equal(cats.total, 2);
    const mercado = cats.items.find((c) => c.name === 'Mercado');
    assert.ok(mercado && typeof mercado.id === 'string', 'Mercado category resolved from real listing');
    assert.equal(mercado.id, '22222222-2222-4222-8222-222222222221', 'resolved id matches the real seed row (not invented)');
    assert.ok(cats.items.every((c) => c.kind === 'expense'), 'kind filter honored by the real handler');

    const proposed = await A.list_categories({}).then(async (all) => {
      assert.equal(all.total, 3, 'unfiltered A categories: Mercado+Aluguel+Salário');
      // Propose vive nos executors (a facade expõe só leitura+sessões+catálogos):
      // mesma função execute que o plugin nativo registra, identidade host-bound.
      const { createToolExecutors } = await import('./ted-finance-tools.mjs');
      const { callFinance } = await import('./finance-transport.mjs');
      return createToolExecutors(callFinance).propose_expense({
        amountCents: 3500,
        description: 'mercado 05L',
        date: '2026-06-10',
        accountId: itau.id,
        categoryId: mercado.id,
      }, HOST_A, { intentionId: 'test-05l-propose-1' });
    });
    assert.equal(proposed.tool, 'transactions.expense.create');
    assert.equal(proposed.normalizedArgs.categoryId, mercado.id, 'proposal carries the listed category id');
    assert.equal(proposed.normalizedArgs.accountId, itau.id, 'proposal carries the listed account id');
    assert.ok(typeof proposed.id === 'string', 'real Pending V2 proposal returns an id');
  });

  it('(neg) kind inválida: 400 validation.error da autoridade real, sem dado fabricado', async () => {
    const err = await A.list_categories({ kind: 'bogus' }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, 'invalid kind must fail');
    assert.equal(err.statusCode, 400);
    assert.equal(err.body.code, 'validation.error');
    assert.equal(err.body.items, undefined, 'no fabricated items on invalid input');
  });

  it('(iso) outro workspace: negação da autoridade real + isolamento A/B disjunto', async () => {
    // Mesmo mecanismo do spike-02 (7), agora na nova rota: o double deny-all
    // no seam workspaceAccess faz o middleware REAL negar com 403.
    const denied = await A.list_categories({}, { access: 'deny-all', workspaceId: 'synthetic-workspace' }).then(
      () => null,
      (e) => e,
    );
    assert.ok(denied, 'denying access store must fail');
    assert.equal(denied.statusCode, 403, 'real middleware 403 (auth.workspace_forbidden)');
    assert.equal(denied.body.code, 'auth.workspace_forbidden');

    const bCats = await B.list_categories({ kind: 'expense' });
    assert.equal(bCats.total, 1);
    assert.equal(bCats.items[0].name, 'Mercado');
    assert.equal(bCats.items[0].householdId, '00000000-0000-4000-8000-00000000000b', 'B sees only B rows');
    const aIds = new Set((await A.list_categories({})).items.map((c) => c.id));
    const bIds = new Set(bCats.items.map((c) => c.id));
    for (const id of bIds) assert.ok(!aIds.has(id), 'A/B category sets are disjoint');
  });
});
