// SPIKE 05 — harness de negativos (sintético, determinístico, in-memory).
//
// TEST-DOUBLE NÃO-AUTORITATIVO (S05-REV-01 P1-1): o store importado de
// ../scripts/confirm-cli.mjs NÃO é a autoridade Pending V2 — é um double
// sintético apenas para isolar a UX de confirmação (ação explícita; "sim"
// textual nunca confirma). Os casos marcados [DOUBLE-ONLY] correlacionam
// essa UX e NADA provam sobre idempotência/persistência/recibo da fronteira.
// As asserções comportamentais autoritativas (replay mesma-instância,
// conflito de payload, ausência de persistência cross-processo) vivem nos
// casos [REAL-PENDING-V2], que exercem o Pending V2 real via
// bootstrap/finance-bridge.ts (runPropose + store in-memory real
// compartilhado no mesmo processo bridge). Prova contra o v2Store real em
// ted-local é follow-up OBRIGATÓRIO antes de conclusão sobre a fronteira.
//
// SCOPE: experiments/ted-runtime/spike-05 only (+ bridge one-shot via child
// process para os casos [REAL-PENDING-V2]; sem Postgres, sem containers,
// sem rede, sem inferência paga, sem apps/*, sem .env, sem push/deploy).
// Importa o double sintético de ../scripts/confirm-cli.mjs + a fixture;
// os casos reais falam com o bridge por STDIO (mesmo protocolo do transport).
//
// Run:  node --test tests/spike-05-negatives.test.mjs   (a partir de spike-05/)
// Critério principal: confirmada => no máximo 1 efeito; não confirmada => 0.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createStore, yesterdayUTC, KNOWN, loadFixture } from '../scripts/confirm-cli.mjs';

const WS = KNOWN.householdId;
const ACTOR = KNOWN.actor;

// ---- [REAL-PENDING-V2] harness: Pending V2 real, mesma instância ------------
// Fala com bootstrap/finance-bridge.ts por STDIO (protocolo do transport):
// UMA invocação = UM processo = UM app + UM v2Store real compartilhado.
// verifyReplay/verifyConflictBody re-injetam NESSE mesmo app/store — é assim
// que o retry de cliente é provado (mesma instância). Duas invocações NUNCA
// compartilham estado (bridge one-shot; produção persiste em Postgres).
const TEST_HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(TEST_HERE, '..', '..', 'bootstrap', 'finance-bridge.ts');
const API_DIR = 'D:/projetos/pi-financeiro/apps/api';
const REAL_ACCOUNT_A1 = '11111111-1111-4111-8111-111111111111'; // seed real (Itaú/HOUSEHOLD_A)
const REAL_CATEGORY_FOOD_A = '22222222-2222-4222-8222-222222222221'; // seed real (Mercado)

function resolveTsxCli() {
  const apiRequire = createRequire(path.join(API_DIR, 'package.json'));
  const pkgPath = apiRequire.resolve('tsx/package.json');
  const pkg = apiRequire(pkgPath);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsx;
  return path.join(path.dirname(pkgPath), bin);
}

function runBridge(request) {
  const r = spawnSync(process.execPath, [resolveTsxCli(), BRIDGE], {
    cwd: API_DIR,
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  assert.equal(r.error ?? null, null, `bridge spawn falhou: ${String(r.error)}`);
  const lines = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && ('statusCode' in parsed || 'fatal' in parsed)) return parsed;
    } catch { /* continua */ }
  }
  throw new Error(`bridge sem payload JSON: stdout=${String(r.stdout).slice(0, 300)} stderr=${String(r.stderr).slice(0, 300)}`);
}

function realProposeBody(over = {}) {
  return {
    tool: 'transactions.expense.create',
    normalizedArgs: {
      amountCents: 3500,
      description: 'mercado s05 real',
      date: yesterdayUTC(),
      accountId: REAL_ACCOUNT_A1,
      categoryId: REAL_CATEGORY_FOOD_A,
      ...over,
    },
  };
}

function baseProposal(store, over = {}) {
  return store.propose({
    workspaceId: WS,
    actorId: ACTOR,
    amountCents: 3500,
    accountId: KNOWN.accountNubank,
    categoryId: KNOWN.categoryMercado,
    description: 'mercado',
    date: yesterdayUTC(),
    ...over,
  });
}

describe('spike-05 negatives (synthetic in-memory, deterministic)', () => {
  let store;
  beforeEach(() => { store = createStore(); });

  it('(0) fixture congelada documenta o caso principal', () => {
    const f = loadFixture();
    assert.equal(f.expected.amountCents, 3500);
    assert.equal(f.expected.accountId, KNOWN.accountNubank);
    assert.equal(f.expected.categoryId, KNOWN.categoryMercado);
    assert.equal(f.expected.kind, 'expense');
    assert.match(f.expected.dateRule, /YESTERDAY_DYNAMIC/);
    assert.match(yesterdayUTC(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it('(1) conta ambígua ("banco" casa Itaú+Nubank) exige desambiguação, 0 efeitos', () => {
    assert.throws(() => baseProposal(store, { accountId: undefined, accountName: 'banco' }), /ambiguous/);
    assert.equal(store.ledger.length, 0);
  });

  it('(2) conta inexistente falha no propose, 0 efeitos', () => {
    assert.throws(
      () => baseProposal(store, { accountId: '11111111-1111-4111-8111-deadbeef0000' }),
      /unknown account/,
    );
    assert.equal(store.ledger.length, 0);
  });

  it('(3) valor inválido (zero/negativo/não-inteiro) falha no propose, 0 efeitos', () => {
    for (const amountCents of [0, -3500, 35.5, NaN]) {
      assert.throws(() => baseProposal(store, { amountCents }), /invalid amount/, `amount ${String(amountCents)}`);
    }
    assert.equal(store.ledger.length, 0);
  });

  it('(4) workspace incorreto no confirm é negado, 0 efeitos', () => {
    const p = baseProposal(store);
    assert.throws(
      () => store.confirm({ id: p.id, actorId: ACTOR, workspaceId: '00000000-0000-4000-8000-00000000000b', action: 'confirm' }),
      /workspace mismatch/,
    );
    assert.equal(store.outcome(p.id).effects, 0);
  });

  it('(5) confirmação por outro usuário é negada, 0 efeitos', () => {
    const p = baseProposal(store);
    assert.throws(
      () => store.confirm({ id: p.id, actorId: 'synth-actor-s05-intruder', workspaceId: WS, action: 'confirm' }),
      /another user/,
    );
    assert.equal(store.outcome(p.id).effects, 0);
  });

  it('(6) proposta expirada não confirma, 0 efeitos', () => {
    const p = baseProposal(store, { expiresInMs: -1000 });
    assert.throws(() => store.confirm({ id: p.id, actorId: ACTOR, workspaceId: WS, action: 'confirm' }), /expired/);
    assert.equal(store.outcome(p.id).effects, 0);
  });

  it('(7) [DOUBLE-ONLY] confirmação duplicada no double: ainda 1 efeito, mesmo recibo (UX; sem valor de autoridade)', () => {
    const p = baseProposal(store);
    const first = store.confirm({ id: p.id, actorId: ACTOR, workspaceId: WS, action: 'confirm' });
    const second = store.confirm({ id: p.id, actorId: ACTOR, workspaceId: WS, action: 'confirm' });
    assert.equal(first.receipt.entityId, second.receipt.entityId);
    assert.equal(store.ledger.length, 1);
    assert.equal(store.outcome(p.id).effects, 1);
  });

  it('(8) [DOUBLE-ONLY] repetição da LLM no double (mesma intentionId) reusa a proposta (UX; sem valor de autoridade)', () => {
    const a = baseProposal(store, { intentionId: 'int-synth-s05-repeat-01' });
    const b = baseProposal(store, { intentionId: 'int-synth-s05-repeat-01' });
    assert.equal(a.id, b.id);
    store.confirm({ id: a.id, actorId: ACTOR, workspaceId: WS, action: 'confirm' });
    assert.equal(store.ledger.length, 1);
  });

  it('(9) timeout após envio sem confirmação: pending, 0 efeitos', () => {
    const p = baseProposal(store);
    const o = store.outcome(p.id); // transport respondeu, usuário não confirmou
    assert.equal(o.status, 'proposed');
    assert.equal(o.effects, 0);
    assert.equal(store.ledger.length, 0);
  });

  it('(10) falha da API no propose fecha-falha: exceção, 0 efeitos', () => {
    assert.throws(() => baseProposal(store, { simulateTransportFailure: true }), /fail-closed/);
    assert.equal(store.ledger.length, 0);
  });

  it('(11) [DOUBLE-ONLY] restart no double preserva a intenção via save/load (correlação de intenção; NÃO prova de autoridade Pending V2)', () => {
    const p = baseProposal(store, { intentionId: 'int-synth-s05-restart-01' });
    const snap = store.save();
    const rebooted = createStore();
    rebooted.load(snap);
    const out = rebooted.confirm({ id: p.id, actorId: ACTOR, workspaceId: WS, action: 'confirm' });
    assert.equal(out.status, 'confirmed');
    assert.equal(rebooted.ledger.length, 1);
    // Duplicada pós-restart continua idempotente.
    rebooted.confirm({ id: p.id, actorId: ACTOR, workspaceId: WS, action: 'confirm' });
    assert.equal(rebooted.ledger.length, 1);
  });

  it('(12) [DOUBLE-ONLY] recibo ausente no double => outcome unverified (UX; sem valor de autoridade)', () => {
    const p = baseProposal(store);
    store.confirm({ id: p.id, actorId: ACTOR, workspaceId: WS, action: 'confirm' });
    store._proposals.get(p.id).receipt = null; // simula perda do recibo
    const o = store.outcome(p.id);
    assert.equal(o.status, 'unverified');
    assert.equal(o.receipt, null);
  });

  it('(13) tentativa de execução direta pela LLM é negada, 0 efeitos', () => {
    const p = baseProposal(store);
    assert.throws(() => store.executeDirect({ id: p.id }), /confirm first/);
    assert.equal(store.ledger.length, 0);
    assert.equal(store.outcome(p.id).effects, 0);
  });

  it('(14) "sim" textual nunca confirma: action ausente/divergente é negada', () => {
    const p = baseProposal(store);
    for (const action of [undefined, null, 'sim', 'yes', 'confirmar']) {
      assert.throws(
        () => store.confirm({ id: p.id, actorId: ACTOR, workspaceId: WS, action }),
        /explicit action/,
        `action ${String(action)}`,
      );
    }
    assert.equal(store.outcome(p.id).effects, 0);
  });

  it('(PRINCIPAL) [DOUBLE-ONLY] double: confirmada => no máximo 1 efeito; não confirmada => 0 (UX; autoridade provada nos casos [REAL-PENDING-V2])', () => {
    const confirmed = baseProposal(store, { intentionId: 'int-s05-principal-yes' });
    const untouched = baseProposal(store, { intentionId: 'int-s05-principal-no' });
    store.confirm({ id: confirmed.id, actorId: ACTOR, workspaceId: WS, action: 'confirm' });
    store.confirm({ id: confirmed.id, actorId: ACTOR, workspaceId: WS, action: 'confirm' }); // duplicada
    assert.ok(store.outcome(confirmed.id).effects <= 1, 'confirmada: no máximo 1 efeito');
    assert.equal(store.outcome(untouched.id).effects, 0, 'não confirmada: 0 lançamentos');
    assert.equal(store.ledger.filter((e) => e.proposalId === untouched.id).length, 0);
  });

  it('(R1) [REAL-PENDING-V2] replay mesma-instância: mesma chave + mesmo payload => 200 existing:true, MESMO id (autoridade real)', () => {
    const key = `ted-s05-r1-${Date.now()}-${process.pid}`;
    const body = realProposeBody();
    const out = runBridge({
      token: 'dev-token-1',
      route: '/pending-operations/v2/propose',
      method: 'POST',
      body,
      idempotencyKey: key,
      delegated: { capabilities: ['financial.approval.propose'], requestId: `int-s05-r1-${Date.now()}` },
      verifyReplay: true,
      verifyConflictBody: realProposeBody({ amountCents: 9999 }),
    });
    assert.equal(out.statusCode, 201, `propose inicial deve ser 201: ${JSON.stringify(out.body).slice(0, 300)}`);
    assert.ok(out.body && typeof out.body.id === 'string', 'propose real retorna id');
    assert.ok(out.replay, 'bridge deve retornar o probe de replay mesma-instância');
    assert.equal(out.replay.statusCode, 200, `replay mesma chave+payload deve ser 200: ${JSON.stringify(out.replay.body).slice(0, 300)}`);
    assert.equal(out.replay.body.existing, true, 'replay marca existing:true');
    assert.equal(out.replay.body.id, out.body.id, 'replay retorna o MESMO id (autoridade Pending V2, mesmo store)');
  });

  it('(R2) [REAL-PENDING-V2] conflito mesma-instância: mesma chave + payload divergente => 409 idempotency.conflict (autoridade real)', () => {
    const key = `ted-s05-r2-${Date.now()}-${process.pid}`;
    const out = runBridge({
      token: 'dev-token-1',
      route: '/pending-operations/v2/propose',
      method: 'POST',
      body: realProposeBody(),
      idempotencyKey: key,
      delegated: { capabilities: ['financial.approval.propose'], requestId: `int-s05-r2-${Date.now()}` },
      verifyReplay: false,
      verifyConflictBody: realProposeBody({ amountCents: 9999 }),
    });
    assert.equal(out.statusCode, 201, `propose inicial deve ser 201: ${JSON.stringify(out.body).slice(0, 300)}`);
    assert.ok(out.conflict, 'bridge deve retornar o probe de conflito mesma-instância');
    assert.equal(out.conflict.statusCode, 409, `payload divergente deve ser 409: ${JSON.stringify(out.conflict.body).slice(0, 300)}`);
    assert.equal(out.conflict.body.code, 'idempotency.conflict');
  });

  it('(R3) [REAL-PENDING-V2] one-shot NÃO persiste cross-processo: mesma chave + mesmo payload em 2 processos => 2 ids distintos (sem claim falso de restart)', () => {
    const key = `ted-s05-r3-${Date.now()}-${process.pid}`;
    const body = realProposeBody({ description: 'mercado s05 r3 mesma-chave' });
    const req = () => ({
      token: 'dev-token-1',
      route: '/pending-operations/v2/propose',
      method: 'POST',
      body,
      idempotencyKey: key,
      delegated: { capabilities: ['financial.approval.propose'], requestId: `int-s05-r3-${Date.now()}` },
    });
    // NOTA: mesma chave + mesmo payload NUM store compartilhado daria 200
    // replay com o MESMO id (cf. R1). Aqui cada processo tem store fresco, por
    // isso ambos respondem 201 com ids DISTINTOS — o bridge one-shot nunca
    // prova persistência cross-processo/restart; produção usa Postgres.
    const first = runBridge(req());
    const second = runBridge(req());
    assert.equal(first.statusCode, 201, `1º processo deve ser 201: ${JSON.stringify(first.body).slice(0, 200)}`);
    assert.equal(second.statusCode, 201, `2º processo com store fresco deve ser 201 novo (nada persistiu): ${JSON.stringify(second.body).slice(0, 200)}`);
    assert.notEqual(second.body.id, first.body.id, 'stores distintos => ids distintos; cross-processo NÃO compartilha idempotência');
  });
});
