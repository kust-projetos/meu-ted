// P3 end-to-end (deterministic, local provider): the exact user message runs
// the REAL SDK 2.2.4 prompt loop against a scripted OpenAI-compatible stub on
// 127.0.0.1, the model calls `propose_expense`, and the tool records ONE
// proposal intent — with ZERO finance transport calls and ZERO writes.
//
// No paid/external inference: every request is loopback and scripted.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { setupIsolation, tedConfig, wirePlugin, assertNoRedirectedComponents } from '../src/bootstrap.mjs';
import { defineTedFinancePlugin } from '../src/plugin.mjs';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';
import { bindSession } from '../src/session-bindings.mjs';
import { createPromptHost } from '../src/prompt.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const FIXTURE_PROVIDER = 'testloop';
const FIXTURE_MODEL = 'test-alpha';
const FIXTURE_PACKAGE = '@opencode/ai/providers/openai-compatible';

const HOST = {
  label: 'p3loop',
  token: 'test-token-not-a-secret',
  household: 'H_P3LOOP',
  actorId: 'actor-p3loop',
  deviceId: 'dev-p3loop',
};

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '22222222-2222-4222-8222-222222222222';
const USER_MESSAGE = 'Registre uma despesa de R$ 50 no mercado, na conta Nubank.';
const EXPECTED_ARGS = {
  amountCents: 5000,
  description: 'mercado',
  date: '2026-11-06',
  accountId: ACCOUNT,
  categoryId: CATEGORY,
};
const INCOME_MESSAGE = 'Registre uma receita de R$ 2.500 de salário na conta Nubank.';
const INCOME_ARGS = {
  amountCents: 250000,
  description: 'salário',
  date: '2026-11-07',
  accountId: ACCOUNT,
  categoryId: CATEGORY,
};

function fixtureModel(id) {
  return {
    name: `Test ${id}`,
    modelID: id,
    capabilities: { input: ['text'], output: ['text'] },
    limit: { context: 8000, output: 2000 },
  };
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunkBase = () => ({
  id: 'chatcmpl-p3loop',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: FIXTURE_MODEL,
  error: null,
});

function toolCallEvents({ callId, name, args }) {
  const base = chunkBase();
  return (
    sse({
      ...base,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      }],
    })
    + sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    + 'data: [DONE]\n\n'
  );
}

function finalTextEvents(text) {
  const base = chunkBase();
  return (
    sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
    + sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + 'data: [DONE]\n\n'
  );
}

function offeredToolNames(req) {
  const tools = req && req.body && Array.isArray(req.body.tools) ? req.body.tools : [];
  return tools.map((t) => t && t.function && t.function.name).filter((n) => typeof n === 'string');
}

describe('P3 propose_expense — deterministic prompt-loop (scripted local provider)', () => {
  let iso;
  let oc = null;
  let stub = null;
  let stubUrl;
  let script = null;
  let realFetch;
  let transportCalls = 0;
  const chatRequests = [];
  const registry = createProposalIntentRegistry();

  before(async () => {
    iso = setupIsolation(approvedTmpRoot('ted-p3-propose-loop'), 'p3proposeloop');

    stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.method !== 'POST') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        let body = null;
        try { body = JSON.parse(raw); } catch { body = { _parseError: raw.slice(0, 200) }; }
        chatRequests.push({ url: req.url, body, remote: req.socket && req.socket.remoteAddress });
        const messages = body && Array.isArray(body.messages) ? body.messages : [];
        const hasToolMsg = messages.some((m) => m && m.role === 'tool');
        assert.ok(script, 'stub script must be set before the prompt loop runs');
        const payload = hasToolMsg ? finalTextEvents(script.finalText) : toolCallEvents(script);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.end(payload);
      });
    });
    await new Promise((resolve, reject) => {
      stub.once('error', reject);
      stub.listen(0, '127.0.0.1', resolve);
    });
    stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      let s = '';
      try { s = String(url && url.url ? url.url : url); } catch { s = String(url); }
      let hostname = '';
      try { hostname = new URL(s).hostname; } catch { hostname = ''; }
      if (hostname === '127.0.0.1') return realFetch(url, init);
      throw new Error('guard: non-loopback fetch blocked in the P3 proof (zero external inference)');
    };

    const base = tedConfig('test', { p3Writes: true });
    const cfg = {
      ...base,
      model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
      policies: [
        ...(base.policies || []),
        { action: 'provider.use', resource: FIXTURE_PROVIDER, effect: 'allow' },
      ],
      providers: {
        [FIXTURE_PROVIDER]: {
          name: 'Test loopback fixture (scripted stub, dummy apiKey)',
          package: FIXTURE_PACKAGE,
          settings: { baseURL: stubUrl, apiKey: 'test-fixture-not-a-secret' },
          models: { [FIXTURE_MODEL]: fixtureModel(FIXTURE_MODEL) },
        },
      },
    };
    const providerPolicies = (cfg.policies || []).filter((p) => p && p.action === 'provider.use');
    const allowIdx = providerPolicies.findIndex((p) => p.resource === FIXTURE_PROVIDER && p.effect === 'allow');
    const denyIdx = providerPolicies.findIndex((p) => p.resource === '*' && p.effect === 'deny');
    assert.ok(allowIdx !== -1 && allowIdx > denyIdx, 'test-only provider allow comes after deny-all');
    for (const resource of ['propose_card_purchase', 'propose_expense', 'propose_income']) {
      assert.ok(
        (cfg.agents.ted.permissions || []).some((p) => p.resource === resource && p.effect === 'allow'),
        `the P3 config allows exactly the ${resource} permission`,
      );
    }

    assertNoRedirectedComponents([iso.dirs.config]);
    fs.mkdirSync(iso.dirs.config, { recursive: true });
    fs.writeFileSync(path.join(iso.dirs.config, 'opencode.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const sdk = await import('@opencode/sdk');
    oc = await sdk.OpenCode.create({
      config: { directory: iso.dirs.config, project: false },
      database: { path: iso.dirs.db },
    });

    // Propose must never call the finance transport; counting proves it.
    const transport = async () => { transportCalls += 1; throw new Error('propose must not call the transport'); };
    await wirePlugin(oc, defineTedFinancePlugin(() => transport, {
      env: { TED_OPENCODE_P3_WRITES_ENABLED: '1', NODE_ENV: 'test' },
      proposalIntents: registry,
    }));
  });

  after(async () => {
    globalThis.fetch = realFetch;
    if (stub) await new Promise((resolve) => stub.close(resolve)).catch(() => {});
    if (oc) await oc.close().catch(() => {});
  });

  it('the exact message reaches propose_expense and records one intent (zero writes)', { timeout: 120000 }, async () => {
    script = { callId: 'call_p3_propose_1', name: 'propose_expense', args: EXPECTED_ARGS, finalText: 'FINAL-PROPOSED-OK' };
    transportCalls = 0;
    registry.clearAll();
    const mark = chatRequests.length;

    const created = await oc.session.create({ title: 'p3-propose', agent: 'ted' });
    assert.ok(created && typeof created.id === 'string' && created.id.length > 0, 'native session created');
    bindSession(created.id, { ...HOST });
    const promptHost = createPromptHost({ oc, timeoutMs: 90000, pollIntervalMs: 250 });
    const res = await promptHost.chat({ sessionID: created.id, text: USER_MESSAGE, intentionId: 'p3-propose-m1' });

    assert.equal(res.output, 'FINAL-PROPOSED-OK');
    assert.equal(transportCalls, 0, 'propose_expense performs no finance HTTP');

    const newReqs = chatRequests.slice(mark);
    assert.ok(newReqs.length >= 2, `stub saw tool-call and tool-result turns (got ${newReqs.length})`);
    const firstMessages = (newReqs[0].body && newReqs[0].body.messages) || [];
    assert.ok(
      firstMessages.some((m) => m && m.role === 'user' && String(m.content).includes(USER_MESSAGE)),
      'the exact user message reached the model loop',
    );
    const offered = offeredToolNames(newReqs[0]);
    for (const name of ['propose_expense', 'list_categories', 'list_accounts']) {
      assert.ok(offered.includes(name), `${name} is offered to the model (got ${JSON.stringify(offered)})`);
    }
    const toolTurn = newReqs.find((r) => ((r.body && r.body.messages) || []).some((m) => m && m.role === 'tool'));
    assert.ok(toolTurn, 'the tool result was fed back to the model');
    const toolMsg = (toolTurn.body.messages || []).find((m) => m && m.role === 'tool');
    assert.match(String(toolMsg.content ?? ''), /proposed/, 'tool result reports a proposal, never execution');
    assert.ok(!/succeeded/i.test(String(toolMsg.content ?? '')), 'never claims execution');

    const intent = registry.take(created.id);
    assert.ok(intent, 'exactly one proposal intent was recorded for the session');
    assert.equal(intent.tool, 'transactions.expense.create');
    assert.deepEqual(intent.normalizedArgs, EXPECTED_ARGS);
    assert.match(intent.intentionId, /^int-[0-9a-f]{32}$/);
    assert.match(intent.summary, /R\$\s?50,00/);
    assert.equal(registry.take(created.id), null, 'one handoff per turn');

    for (const r of newReqs) assert.equal(r.remote, '127.0.0.1', 'all stub requests are loopback');
  });

  it('the income message reaches propose_income and records one income intent (zero writes)', { timeout: 120000 }, async () => {
    script = { callId: 'call_p3_income_1', name: 'propose_income', args: INCOME_ARGS, finalText: 'FINAL-INCOME-PROPOSED-OK' };
    transportCalls = 0;
    registry.clearAll();
    const mark = chatRequests.length;

    const created = await oc.session.create({ title: 'p3-propose-income', agent: 'ted' });
    assert.ok(created && typeof created.id === 'string' && created.id.length > 0, 'native session created');
    bindSession(created.id, { ...HOST });
    const promptHost = createPromptHost({ oc, timeoutMs: 90000, pollIntervalMs: 250 });
    const res = await promptHost.chat({ sessionID: created.id, text: INCOME_MESSAGE, intentionId: 'p3-propose-income-m1' });

    assert.equal(res.output, 'FINAL-INCOME-PROPOSED-OK');
    assert.equal(transportCalls, 0, 'propose_income performs no finance HTTP');

    const newReqs = chatRequests.slice(mark);
    assert.ok(newReqs.length >= 2, `stub saw tool-call and tool-result turns (got ${newReqs.length})`);
    const firstMessages = (newReqs[0].body && newReqs[0].body.messages) || [];
    assert.ok(
      firstMessages.some((m) => m && m.role === 'user' && String(m.content).includes(INCOME_MESSAGE)),
      'the exact income message reached the model loop',
    );
    const offered = offeredToolNames(newReqs[0]);
    for (const name of ['propose_income', 'propose_expense', 'list_categories', 'list_accounts']) {
      assert.ok(offered.includes(name), `${name} is offered to the model (got ${JSON.stringify(offered)})`);
    }
    const toolTurn = newReqs.find((r) => ((r.body && r.body.messages) || []).some((m) => m && m.role === 'tool'));
    assert.ok(toolTurn, 'the tool result was fed back to the model');
    const toolMsg = (toolTurn.body.messages || []).find((m) => m && m.role === 'tool');
    assert.match(String(toolMsg.content ?? ''), /proposed/, 'tool result reports a proposal, never execution');
    assert.ok(!/succeeded/i.test(String(toolMsg.content ?? '')), 'never claims execution');

    const intent = registry.take(created.id);
    assert.ok(intent, 'exactly one proposal intent was recorded for the session');
    assert.equal(intent.tool, 'transactions.income.create');
    assert.deepEqual(intent.normalizedArgs, INCOME_ARGS);
    assert.match(intent.intentionId, /^int-[0-9a-f]{32}$/);
    assert.match(intent.summary, /Receita de R\$\s?2\.500,00/);
    assert.equal(registry.take(created.id), null, 'one handoff per turn');

    for (const r of newReqs) assert.equal(r.remote, '127.0.0.1', 'all stub requests are loopback');
  });
});
