// Prova de seleção nativa de modelo — SDK real @opencode/sdk 2.2.4, zero
// inferência, zero rede, zero custo.
//
// O que este teste prova, de forma determinística e sem nenhum
// `session.prompt` (chamada proibida aqui — um guard que lança protege
// isso), sem listener HTTP, com fetch interceptado e registrado (qualquer
// request ao provider da fixture falha o teste) e sem chamada a API
// financeira (nenhum transport existe neste teste):
//
// 1. O seletor nativo de config `model` ("testloop/test-alpha") é carregado
//    ao vivo: `oc.config.get()` devolve o documento teste com o seletor
//    decodificado pelo próprio SDK em `{ providerID, model }`, mais
//    `default_agent: 'ted'`, agente `ted` e provider `testloop`.
// 2. O SDK RESOLVE o default nativo para o modelo fixture:
//    `oc.model.default()` devolve `{ id, modelID, providerID }` de
//    test-alpha, e `oc.model.list()` contém EXATAMENTE os dois modelos da
//    fixture (nenhum modelo externo vaza para o catálogo).
// 3. A MESMA sessão nativa muda de modelo via `session.switchModel`
//    (test-alpha→test-beta e volta test-beta→test-alpha), com
//    `session.get` devolvendo sempre o mesmo session ID e o ref
//    `{ providerID, id }` esperado.
// 4. As permissões por sessão (deny shell/edit/subagent) sobrevivem
//    intactas a cada troca — seleção de modelo não amplia ferramentas.
// 5. A fixture permite SOMENTE o provider local: policy test-only com
//    `provider.use` allow para `testloop` POR ÚLTIMO (findLast vence o
//    deny `*`), mantendo todos os tool.use denies do TED e o deny
//    `provider.use *` para qualquer outro provider.
//
// Fixture: provider `testloop` OpenAI-compatible nativo
// (`package: '@opencode/ai/providers/openai-compatible'` — spec embutido,
// sem download), `baseURL` loopback sem servidor (127.0.0.1:9, nunca
// discado — nenhum prompt é executado), `apiKey` dummy não secreta, dois
// modelos explícitos com `modelID`, `capabilities` e `limit`. Nada sai
// deste processo. Temporários vêm de approvedTmpRoot e NUNCA são apagados.
//
// Por que o allow é necessário: o plugin `opencode.config.policy` REMOVE
// do estado todo provider com `provider.use` deny — com o deny-all do
// produto, nem a fixture aparece no catálogo. O allow test-only restrito
// ao `testloop` (NUNCA em `tedConfig()` de produto) é o que materializa o
// catálogo local sem abrir nenhum provider real.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupIsolation, tedConfig, assertNoRedirectedComponents, resolveRuntimeProfile } from '../src/bootstrap.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const FIXTURE_PROVIDER = 'testloop';
const FIXTURE_ALPHA = 'test-alpha';
const FIXTURE_BETA = 'test-beta';
const FIXTURE_PACKAGE = '@opencode/ai/providers/openai-compatible';
const FIXTURE_BASE_URL = 'http://127.0.0.1:9/v1';

const SESSION_DENIES = [
  { action: 'shell', resource: '*', effect: 'deny' },
  { action: 'edit', resource: '*', effect: 'deny' },
  { action: 'subagent', resource: '*', effect: 'deny' },
];

function fixtureModel(id, name) {
  return {
    name,
    modelID: id,
    capabilities: { input: ['text'], output: ['text'] },
    limit: { context: 8000, output: 2000 },
  };
}

describe('native model selection (real SDK 2.2.4, zero inference)', () => {
  it('default resolves to fixture; same session switches models; denies unchanged; zero prompts/fetch', { timeout: 120000 }, async () => {
    const root = approvedTmpRoot('ted-modelsel');
    const iso = setupIsolation(root, 'modelsel');

    // opencode.json SÓ de teste: base do produto + seletor nativo `model`
    // (forma string "provider/model") + provider fixture local + policy
    // test-only que permite SOMENTE a fixture (allow por último — findLast
    // vence o deny `*`). Escrito direto (nunca writeTedConfig — ele grava a
    // config do produto sem `model` e recusa sobrescrever; tedConfig() de
    // produto NÃO é alterado).
    const cfg = {
      ...tedConfig(),
      policies: [
        ...(tedConfig().policies || []),
        { action: 'provider.use', resource: FIXTURE_PROVIDER, effect: 'allow' },
      ],
      model: `${FIXTURE_PROVIDER}/${FIXTURE_ALPHA}`,
      providers: {
        [FIXTURE_PROVIDER]: {
          name: 'Test loopback fixture (never dialed: loopback baseURL, dummy apiKey)',
          package: FIXTURE_PACKAGE,
          settings: { baseURL: FIXTURE_BASE_URL, apiKey: 'test-fixture-not-a-secret' },
          models: {
            [FIXTURE_ALPHA]: fixtureModel(FIXTURE_ALPHA, 'Test Alpha'),
            [FIXTURE_BETA]: fixtureModel(FIXTURE_BETA, 'Test Beta'),
          },
        },
      },
    };
    assertNoRedirectedComponents([iso.dirs.config]);
    fs.mkdirSync(iso.dirs.config, { recursive: true });
    const file = path.join(iso.dirs.config, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    // Fixture carrega a política do produto + allow restrito (nível arquivo).
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const resource of ['shell:*', 'edit:*', 'write:*', 'subagent:*']) {
      assert.ok(
        (written.policies || []).some((p) => p && p.action === 'tool.use' && p.resource === resource && p.effect === 'deny'),
        `fixture preserva tool.use deny para ${resource}`,
      );
    }
    const providerPolicies = (written.policies || []).filter((p) => p && p.action === 'provider.use');
    assert.ok(
      providerPolicies.some((p) => p.resource === '*' && p.effect === 'deny'),
      'fixture preserva provider.use deny-all para qualquer outro provider',
    );
    const allowIdx = providerPolicies.findIndex((p) => p.resource === FIXTURE_PROVIDER && p.effect === 'allow');
    const denyIdx = providerPolicies.findIndex((p) => p.resource === '*' && p.effect === 'deny');
    assert.ok(allowIdx !== -1 && allowIdx > denyIdx, 'allow do provider local vem após o deny-all (findLast vence)');
    assert.equal(written.default_agent, 'ted');
    assert.ok(written.agents && written.agents.ted, 'fixture preserva o agente ted');
    assert.equal(written.providers?.[FIXTURE_PROVIDER]?.package, FIXTURE_PACKAGE);
    assert.equal(
      new URL(written.providers?.[FIXTURE_PROVIDER]?.settings?.baseURL).hostname,
      '127.0.0.1',
      'baseURL da fixture é loopback (nunca externa)',
    );
    for (const id of [FIXTURE_ALPHA, FIXTURE_BETA]) {
      const m = written.providers?.[FIXTURE_PROVIDER]?.models?.[id];
      assert.ok(m && m.modelID === id && m.limit && m.capabilities, `modelo fixture ${id} com modelID/capabilities/limit`);
    }

    // Guard de rede zero ANTES de qualquer código do SDK: instalado antes
    // do import dinâmico e do boot, cobrindo também falhas no import/boot
    // (restore em finally externo). O SDK embutido faz housekeeping
    // best-effort via fetch (observado em 2.2.4: refresh do snapshot em
    // models.opencode.ai + sondas de well-known providers locais — LM
    // Studio :1234, Ollama :11434, :8000; todas GET, todas tolerantes a
    // falha). O guard registra e rejeita: igual ao comportamento offline,
    // e prova que NENHUM request atinge o provider da fixture
    // (127.0.0.1:9) — nem inferência (POST) nem catálogo (GET) — e que
    // nenhum prompt é executado.
    const realFetch = globalThis.fetch;
    const seenFetch = [];
    globalThis.fetch = (async (url, init) => {
      let u = url;
      try {
        u = String(url && url.url ? url.url : url);
      } catch { /* mantém original */ }
      seenFetch.push(`${(init && init.method) || 'GET'} ${String(u).slice(0, 220)}`);
      throw new Error('guard: no fetch may succeed in the native model-selection proof (zero-network fixture)');
    });
    let oc = null;
    try {
      // Import nu SÓ DEPOIS do isolamento (o SDK captura as raízes no import).
      const sdk = await import('@opencode/sdk');
      assert.equal(typeof sdk.OpenCode.create, 'function', 'SDK real expõe OpenCode.create');
      oc = await sdk.OpenCode.create({
        config: { directory: iso.dirs.config, project: false },
        database: { path: iso.dirs.db },
      });
      try {
      // Guard de inferência zero: qualquer tentativa de prompt (nossa ou do
      // SDK) falha o teste em vez de custar inferência.
      let promptCalls = 0;
      oc.session.prompt = (async () => {
        promptCalls++;
        throw new Error('guard: session.prompt must never run in the native model-selection proof (zero-inference fixture)');
      });

      // 1. Seletor default observado AO VIVO (decodificado pelo próprio SDK).
      const rawEntries = await oc.config.get();
      const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries.data;
      assert.ok(Array.isArray(entries), 'config.get devolve os documentos de config');
      const doc = entries.find((e) => e && e.type === 'document' && e.path === file);
      assert.ok(doc, 'opencode.json de teste está carregado ao vivo');
      assert.deepEqual(doc.info.model, { providerID: FIXTURE_PROVIDER, model: FIXTURE_ALPHA });
      assert.equal(doc.info.default_agent, 'ted');
      assert.ok(doc.info.agents && doc.info.agents.ted, 'agente ted carregado ao vivo');
      assert.deepEqual(Object.keys(doc.info.providers || {}), [FIXTURE_PROVIDER]);
      for (const resource of ['shell:*', 'edit:*', 'write:*', 'subagent:*']) {
        assert.ok(
          (doc.info.policies || []).some((p) => p && p.action === 'tool.use' && p.resource === resource && p.effect === 'deny'),
          `política ao vivo nega tool.use ${resource}`,
        );
      }

      // 2. Default RESOLVIDO para a fixture + catálogo só com a fixture.
      const rawProviders = await oc.provider.list();
      const providers = Array.isArray(rawProviders) ? rawProviders : rawProviders.data;
      assert.ok(Array.isArray(providers), 'provider.list devolve metadado local (array)');
      assert.deepEqual(
        providers.map((p) => p && p.id),
        [FIXTURE_PROVIDER],
        'só o provider local da fixture está disponível (policy remove o resto)',
      );
      const rawListed = await oc.model.list();
      const listed = Array.isArray(rawListed) ? rawListed : rawListed.data;
      assert.ok(Array.isArray(listed), 'model.list devolve metadado local (array)');
      assert.deepEqual(
        listed.map((m) => m && m.id).sort(),
        [FIXTURE_ALPHA, FIXTURE_BETA],
        'catálogo contém exatamente os dois modelos da fixture',
      );
      for (const m of listed) {
        assert.equal(m.providerID, FIXTURE_PROVIDER);
        assert.equal(m.enabled, true);
      }
      const rawDefault = await oc.model.default();
      const resolved = rawDefault && rawDefault.data !== undefined ? rawDefault.data : rawDefault;
      assert.deepEqual(
        resolved && { id: resolved.id, modelID: resolved.modelID, providerID: resolved.providerID },
        { id: FIXTURE_ALPHA, modelID: FIXTURE_ALPHA, providerID: FIXTURE_PROVIDER },
        'default nativo resolve para o modelo fixture (test-alpha)',
      );

      // 3+4. Mesma sessão nativa troca de modelo; denies por sessão intactos.
      // Nenhum transport financeiro existe neste teste: zero chamadas a API.
      const created = await oc.session.create({ title: 'ted-model-selection', agent: 'ted', permissions: SESSION_DENIES });
      assert.ok(typeof created.id === 'string' && created.id.length > 0, 'sessão criada com id');
      assert.equal(created.agent, 'ted', 'sessão usa o agente ted');
      assert.ok(created.model == null, 'sessão nasce sem modelo (create não herda default)');

      const checkSession = async (expected) => {
        const got = await oc.session.get({ sessionID: created.id });
        assert.equal(got.id, created.id, 'mesma sessão nativa do início ao fim');
        assert.equal(got.agent, 'ted', 'agente ted preservado na troca');
        if (expected === null) {
          assert.ok(got.model == null, 'sem modelo antes da primeira troca');
        } else {
          assert.equal(got.model.id, expected.id);
          assert.equal(got.model.providerID, expected.providerID);
        }
        assert.deepEqual(got.permissions, SESSION_DENIES, 'denies por sessão sobrevivem à seleção de modelo');
      };

      await checkSession(null);
      await oc.session.switchModel({ sessionID: created.id, model: { id: FIXTURE_BETA, providerID: FIXTURE_PROVIDER } });
      await checkSession({ id: FIXTURE_BETA, providerID: FIXTURE_PROVIDER });
      await oc.session.switchModel({ sessionID: created.id, model: { id: FIXTURE_ALPHA, providerID: FIXTURE_PROVIDER } });
      await checkSession({ id: FIXTURE_ALPHA, providerID: FIXTURE_PROVIDER });

      assert.equal(promptCalls, 0, 'zero chamadas a session.prompt (sem inferência, sem custo)');
      assert.deepEqual(
        seenFetch.filter((u) => u.includes('127.0.0.1:9')),
        [],
        'zero requests ao provider da fixture (nem inferência POST, nem catálogo GET)',
      );
      assert.ok(
        seenFetch.every((u) => u.startsWith('GET ')),
        `só housekeeping GET do próprio SDK (sem POST de inferência): ${JSON.stringify(seenFetch)}`,
      );
      } finally {
        if (oc) await oc.close().catch(() => {});
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('product profiles: test default has no model; live appends specific opencode-go provider allow after deny-all', () => {
    // Puro (sem setupIsolation: o processo já está isolado pelo teste acima).
    const base = tedConfig();
    assert.ok(!('model' in base), 'perfil test (default) não seleciona modelo');
    assert.ok(!('providers' in base), 'perfil test não injeta catálogo customizado');
    assert.equal(resolveRuntimeProfile(undefined), 'test', 'ausência de TED_RUNTIME_PROFILE resolve para test');
    assert.deepEqual(
      (base.policies || []).filter((p) => p && p.action === 'provider.use'),
      [{ action: 'provider.use', resource: '*', effect: 'deny' }],
      'test permanece deny-all de provider.use (sem allow)',
    );
    const live = tedConfig('live');
    assert.equal(live.model, 'opencode-go/deepseek-v4.1-flash', 'live usa SOMENTE o modelo nativo do catálogo');
    assert.ok(!('providers' in live), 'live não injeta catálogo customizado (resolve do SDK)');
    assert.deepEqual(
      (live.policies || []).filter((p) => p && p.action === 'tool.use'),
      (base.policies || []).filter((p) => p && p.action === 'tool.use'),
      'live retém todos os tool.use denies do produto',
    );
    const providerPolicies = (live.policies || []).filter((p) => p && p.action === 'provider.use');
    assert.deepEqual(
      providerPolicies,
      [
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: 'opencode-go', effect: 'allow' },
      ],
      'live é exatamente deny-all seguido de allow específico de opencode-go (só o provider opencode-go isolado)',
    );
    const denyIdx = providerPolicies.findIndex((p) => p.resource === '*' && p.effect === 'deny');
    const allowIdx = providerPolicies.findIndex((p) => p.resource === 'opencode-go' && p.effect === 'allow');
    assert.ok(denyIdx !== -1 && allowIdx !== -1 && allowIdx > denyIdx, 'live mantém deny-all e anexa allow específico de opencode-go POR ÚLTIMO (findLast vence)');
    assert.ok(
      !providerPolicies.some((p) => p.resource === '*' && p.effect === 'allow'),
      'live sem allow wildcard (allow é específico de opencode-go)',
    );
    for (const resource of ['openrouter', 'openai', 'anthropic', 'opencode-zen']) {
      assert.ok(
        !providerPolicies.some((p) => p.resource === resource && p.effect === 'allow'),
        `live sem allow específico para ${resource} (só opencode-go)`,
      );
    }
    assert.throws(() => tedConfig('canary'), /unknown TED_RUNTIME_PROFILE/, 'perfil desconhecido é rejeitado');
  });
});
