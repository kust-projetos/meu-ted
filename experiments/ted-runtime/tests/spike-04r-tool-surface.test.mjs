// SPIKE 04R-WS4 proof — effective tool catalog + negative proofs (deterministic, NO inference).
//
// cwd: experiments/ted-runtime/bootstrap. TED_HOME_ROOT=.. (points at
// experiments/ted-runtime), so bridge fixtures + reports stay in-spike.
//   node --test ../tests/spike-04r-tool-surface.test.mjs
//
// CATÁLOGO EFETIVO (por escrito — distinção exigida pela tarefa):
//   (1) Financeiras permitidas (2): `list_accounts` + `get_month_summary` —
//       únicas tools registradas pelo plugin ted-finance via
//       ctx.tool.transform(editor.add) (TOOL_DEFS, mesma função execute usada
//       pelo gateway determinístico). Identidade SEMPRE host-bound (frozen host
//       do facade/binding); args aceitam SÓ campos de domínio (kind/
//       includeInactive, yearMonth); qualquer chave de identidade em args é
//       rejeitada ANTES do transporte (teste c).
//   (2) Wrapper administrativo `execute` (codemode): NÃO é ferramenta TED —
//       é o invólucro nativo do prompt-loop pelo qual o modelo invoca as
//       financeiras (input {code:string}, ex. "tools.list_accounts({})").
//       O alvo financeiro interno só se resolve APÓS a execução do código, por
//       isso um hook `execute.before` NÃO pode validar o alvo: a entrada do
//       hook é {code:string} opaco (sem campo de nome de tool), e validar por
//       regex sobre o código seria frágil/burlável (bypass por concatenação,
//       falso-positivo) — deliberadamente NÃO aproximado aqui.
//   (3) Administrativas nativas (shell/edit/write/subagent + provider.use):
//       presentes no catálogo NATIVO (transform ADICIONA, nunca substitui —
//       superset documentado), porém NEGADAS por config (denies, teste b) e
//       NUNCA expostas na facade (7 chaves, sem shell/prompt/edit/mcp).
//
// ENFORCEMENT RESTANTE = denies (config) + remoção de superfície (facade) +
// abort pós-observação (runner interrompe + aborta a jornada no primeiro
// foreign observado, teste d). NÃO há gate total pré-execução sobre o wrapper
// `execute` neste runtime — LIMITAÇÃO CONHECIDA, experimento futuro standalone
// (mesmo limite do 03B PASS / PRE_EXECUTION_ENFORCEMENT), fora de escopo aqui.
//
// (a) financeiras executam via executores REAIS com host-bound context e batem
//     os oráculos exatos (matchSummary/matchAccounts reutilizados).
// (b) build03BConfig contém denies shell/edit/write/subagent + provider
//     deny-all + 1 allow, e NÃO nega finance tools (falha se negar).
// (c) validateToolArgs rejeita smuggling de identidade; buildExecute sem
//     sessionID falha host_context_required (prova por mecanismo).
// (d) gradeTurn/summarizeSelection classifica foreign (shell) como
//     understanding fail (abort path documentado; shell nunca executado).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TED = path.join(HERE, '..');
const BOOT = path.join(TED, 'bootstrap');

process.env.TED_HOME_ROOT = process.env.TED_HOME_ROOT || TED;

describe('spike-04r tool surface (deterministic, no inference)', () => {
  let turn03b;
  let journey04;
  let oracles;
  let transport;
  let tools;
  let plugin;
  before(async () => {
    turn03b = await import(pathToFileURL(path.join(BOOT, 'run-03b-turn.mjs')).href);
    journey04 = await import(pathToFileURL(path.join(BOOT, 'run-04-journey.mjs')).href);
    oracles = await import(pathToFileURL(path.join(BOOT, 'spike-04-oracles.mjs')).href);
    transport = await import(pathToFileURL(path.join(BOOT, 'finance-transport.mjs')).href);
    tools = await import(pathToFileURL(path.join(BOOT, 'ted-finance-tools.mjs')).href);
    plugin = await import(pathToFileURL(path.join(BOOT, 'plugins', 'ted-finance', 'index.mjs')).href);
  });

  it('(a) allowed finance tools execute via REAL executors with host-bound context and match oracles', async () => {
    const executors = tools.createToolExecutors(transport.callFinance);
    const hostA = { ...oracles.HOST_A };
    const hostB = { ...oracles.HOST_B };

    const summary = await executors.get_month_summary(
      { yearMonth: '2026-06' },
      hostA,
      { intentionId: 'test-04r-summary-a', timeoutMs: 120000 },
    );
    const sCheck = oracles.matchSummary(summary, oracles.oracleSummary('A', '2026-06'));
    assert.equal(sCheck.ok, true, `A/2026-06 summary oracle match: ${JSON.stringify(sCheck.details)}`);

    const accA = await executors.list_accounts({}, hostA, { intentionId: 'test-04r-accounts-a', timeoutMs: 120000 });
    const aCheck = oracles.matchAccounts(accA, oracles.oracleAccounts('A'), oracles.HOUSEHOLD_IDS.A);
    assert.equal(aCheck.ok, true, `A accounts oracle match: ${JSON.stringify(aCheck.details)}`);

    const accB = await executors.list_accounts({}, hostB, { intentionId: 'test-04r-accounts-b', timeoutMs: 120000 });
    const bCheck = oracles.matchAccounts(accB, oracles.oracleAccounts('B'), oracles.HOUSEHOLD_IDS.B);
    assert.equal(bCheck.ok, true, `B accounts oracle match: ${JSON.stringify(bCheck.details)}`);
    // Isolation: A never sees Bradesco, B sees only Bradesco.
    const aNames = (Array.isArray(accA) ? accA : accA.items).map((r) => r.name);
    const bNames = (Array.isArray(accB) ? accB : accB.items).map((r) => r.name);
    assert.ok(!aNames.includes('Bradesco'), 'A must not see B accounts');
    assert.deepEqual(bNames, ['Bradesco']);
  });

  it('(b) effective policy: admin denies + single provider allow, finance tools never denied', () => {
    const cfg = turn03b.build03BConfig();
    // Effective policy registrada como evidência (serializada abaixo).
    const effectivePolicy = {
      allows: cfg.policies.filter((p) => p.effect === 'allow'),
      denies: cfg.policies.filter((p) => p.effect === 'deny').map((p) => `${p.action}:${p.resource}`),
      agentTed: cfg.agents.ted.permissions.map((p) => `${p.action}:${p.resource}:${p.effect}`),
    };
    // Single provider allow (modelo pinado).
    assert.equal(effectivePolicy.allows.length, 1, `exactly one allow expected: ${JSON.stringify(effectivePolicy)}`);
    assert.equal(effectivePolicy.allows[0].action, 'provider.use');
    assert.equal(effectivePolicy.allows[0].resource, 'opencode-go');
    // Admin denies (tool.use shell/edit/write/subagent + provider deny-all).
    for (const d of ['tool.use:shell:*', 'tool.use:edit:*', 'tool.use:write:*', 'tool.use:subagent:*', 'provider.use:*']) {
      assert.ok(effectivePolicy.denies.includes(d), `missing deny ${d} in ${JSON.stringify(effectivePolicy.denies)}`);
    }
    // Agent-level denies preservados.
    for (const d of ['shell:*:deny', 'edit:*:deny', 'subagent:*:deny']) {
      assert.ok(effectivePolicy.agentTed.includes(d), `missing agent deny ${d}`);
    }
    // Finance tools NUNCA negadas (nem mencionadas) — falha se negar.
    const flat = JSON.stringify(cfg);
    assert.ok(!flat.includes('list_accounts'), 'config must not deny list_accounts');
    assert.ok(!flat.includes('get_month_summary'), 'config must not deny get_month_summary');
    // Evidência serializável (sem segredos).
    assert.equal(/dev-token-\d/.test(JSON.stringify(effectivePolicy)), false);
  });

  it('(c) identity smuggling rejected in args; hostless buildExecute fails host_context_required (mechanism proof)', () => {
    // Smuggling de identidade via args — rejeitado ANTES de qualquer transporte.
    for (const k of ['actorId', 'token', 'deviceId', 'intentionId', 'workspaceId', 'householdId', 'device_token', 'sessionId']) {
      assert.throws(
        () => tools.validateToolArgs('get_month_summary', { yearMonth: '2026-06', [k]: 'smuggled' }),
        /forbidden|host-bound/,
        `identity key '${k}' must be rejected`,
      );
      assert.throws(
        () => tools.validateToolArgs('list_accounts', { [k]: 'smuggled' }),
        /forbidden|host-bound/,
        `identity key '${k}' must be rejected (list_accounts)`,
      );
    }
    // Controles positivos: args válidos passam.
    assert.deepEqual(tools.validateToolArgs('get_month_summary', { yearMonth: '2026-06' }), { yearMonth: '2026-06' });
    assert.deepEqual(tools.validateToolArgs('list_accounts', {}), {});
    // Prova por mecanismo (não por ausência em jornada): buildExecute sem
    // sessionID falha host_context_required — o executor nunca é alcançado.
    assert.equal(typeof plugin.buildExecute, 'function', 'execute-closure contract preserved');
    const run = async () => { throw new Error('executor must not run hostless'); };
    const exec = plugin.buildExecute({ name: 'get_month_summary' }, run);
    const attempt = exec({ yearMonth: '2026-06' }, {}, {});
    return assert.rejects(attempt, (e) => {
      const blob = JSON.stringify(e && e.metadata ? { metadata: e.metadata, message: String(e.message || e) } : String((e && e.message) || e));
      assert.match(blob, /host_context_required/, `expected host_context_required, got ${blob.slice(0, 300)}`);
      return true;
    });
  });

  it('(d) foreign selection (e.g. shell) grades understanding fail — abort path, shell never executed', () => {
    // Classificação 03B (seleção): shell é foreign, mesmo com financeira junto.
    const calls = [
      { name: 'get_month_summary', args: { yearMonth: '2026-06' }, status: 'success', via: 'direct' },
      { name: 'shell', args: { command: 'echo NEVER-RUN' }, status: 'observed', via: 'direct' },
    ];
    const sel = turn03b.summarizeSelection(calls);
    assert.deepEqual(sel.foreign, ['shell'], 'shell must be classified foreign');
    assert.equal(sel.perTool.get_month_summary.observed, true);
    // Classificação 04 (veredito): foreign => understanding fail ruidoso.
    const v = journey04.gradeTurn({
      observedNames: ['get_month_summary', 'shell'],
      expectedTools: ['get_month_summary'],
      foreign: sel.foreign,
      executedOk: false,
      executedReason: 'aborted: foreign tool observed — journey abort (post-observation)',
      respondedOk: false,
      respondedReason: 'aborted: foreign tool observed — journey abort (post-observation)',
    });
    assert.equal(v.understanding.status, 'fail', 'foreign selection must fail understanding');
    assert.match(v.understanding.reason, /shell/);
    // Abort path documentado no runner: fail-closed pré-prompt + abort
    // pós-observação (nenhum shell foi executado — só classificação acima).
    assert.match(journey04.PRE_EXECUTION_ENFORCEMENT.runner, /abort on first foreign observation/);
    assert.match(journey04.PRE_EXECUTION_ENFORCEMENT.limitation, /post-observation/);
    assert.match(journey04.PRE_EXECUTION_ENFORCEMENT.limitation, /known limitation/);
    // Pré-prompt fail-closed: expectTools nunca carrega admin (prova estática).
    assert.throws(
      () => journey04.buildTurnRecord({ index: 0, text: 't', host: 'A', sessionSlot: 0, model: { providerID: 'p', id: 'm' }, expectTools: ['shell'] }),
      /non-readonly/,
    );
    assert.equal(journey04.isReadOnlyTool('shell'), false);
    assert.equal(journey04.isReadOnlyTool('get_month_summary'), true);
    assert.equal(journey04.isReadOnlyTool('list_accounts'), true);
  });
});
