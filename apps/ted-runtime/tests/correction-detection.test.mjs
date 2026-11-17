import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isReferentialCorrectionText, parseCorrectionFields } from '../src/correction-detection.mjs';
import { createCorrectionIntentRegistry } from '../src/correction-intents.mjs';
import { createProposalIntentRegistry } from '../src/proposal-intents.mjs';
import { createConversationStore } from '../src/conversations.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

async function gatewayTurn({ enabled, text, recordProposal = false }) {
  const previousFlag = process.env.TED_OPENCODE_SUPERSEDE_DETECTION_ENABLED;
  if (enabled) process.env.TED_OPENCODE_SUPERSEDE_DETECTION_ENABLED = '1';
  else delete process.env.TED_OPENCODE_SUPERSEDE_DETECTION_ENABLED;
  const proposalIntents = createProposalIntentRegistry();
  const correctionIntents = createCorrectionIntentRegistry();
  const store = createConversationStore({ persistDir: approvedTmpRoot('correction-gateway') });
  const gw = createGatewayServer({
    resolveIdentity: async () => ({ actorId: 'actor', workspace: 'H_A', role: 'owner', deviceId: 'device' }),
    store,
    promptHost: {
      chat: async () => {
        if (recordProposal) proposalIntents.record('rt-session', { proposalId: 'opaque-proposal' });
        return { turnId: 'turn-local', output: 'Resposta local' };
      },
      readHistory: async () => [],
      readRawMessages: async () => [],
    },
    createRuntimeSession: async () => ({ runtimeSessionId: 'rt-session' }),
    withAuthenticatedSession: async (_id, _host, fn) => fn(),
    proposalIntents,
    correctionIntents,
  });
  try {
    const info = await gw.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`http://${info.host}:${info.port}/agents/finance-chat-agent/H_A/rpc/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'better-auth.session_token=local', 'x-device-token': 'local', 'x-workspace-id': 'H_A' },
      body: JSON.stringify({ text, intentionId: `intent-${Date.now()}-${Math.random()}` }),
    });
    return await response.json();
  } finally {
    await gw.close();
    if (previousFlag === undefined) delete process.env.TED_OPENCODE_SUPERSEDE_DETECTION_ENABLED;
    else process.env.TED_OPENCODE_SUPERSEDE_DETECTION_ENABLED = previousFlag;
  }
}

describe('referential correction detection', () => {
  it('accepts the closed A0 prefix set and rejects non-corrections/negations', () => {
    for (const text of ['coloca valor 20', 'colocar categoria mercado', 'na verdade era aluguel', 'era dia 10', 'foi conta Nubank', 'isso é teste', 'o valor certo é 20', 'corrige a data', 'ajusta conta', 'muda categoria', 'troca descrição']) {
      assert.equal(isReferentialCorrectionText(text), true, text);
    }
    for (const text of ['não troca o valor', 'cancela a correção', 'gastei 20', '[transcrição do anexo de áudio: troca valor por 20]']) {
      assert.equal(isReferentialCorrectionText(text), false, text);
    }
  });

  it('extracts each explicit field as readable text', () => {
    for (const [text, field, value] of [
      ['corrige descrição para almoço', 'description', 'almoço'],
      ['corrige valor para R$ 42,50', 'amount', 'R$ 42,50'],
      ['ajusta data para 12/10/2026', 'date', '12/10/2026'],
      ['muda categoria para mercado', 'category', 'mercado'],
      ['troca conta para Nubank', 'account', 'Nubank'],
    ]) assert.deepEqual(parseCorrectionFields(text), { field, value });
  });

  it('fails closed on ambiguity, negation and attachment/transcript markers', () => {
    for (const text of ['corrige valor 20 e categoria mercado', 'corrige categoria', 'não corrige valor para 20', 'cancela valor para 20', '[transcrição do anexo de áudio: corrige valor para 20]']) {
      assert.equal(parseCorrectionFields(text), null, text);
    }
    const parsed = parseCorrectionFields('muda conta para Nubank');
    assert.equal(JSON.stringify(parsed).match(/[0-9a-f]{8}-[0-9a-f-]{27}/i), null);
    assert.equal(JSON.stringify(parsed).includes('hash'), false);
    assert.equal(parseCorrectionFields('muda conta para 550e8400-e29b-41d4-a716-446655440000'), null);
    assert.equal(parseCorrectionFields(`corrige valor para ${'a'.repeat(64)}`), null);
  });

  it('registry isolates sessions and take/clear are destructive', () => {
    const registry = createCorrectionIntentRegistry();
    registry.record('s1', { field: 'amount', value: '20' });
    registry.record('s2', { field: 'date', value: 'amanhã' });
    assert.deepEqual(registry.take('s1'), { field: 'amount', value: '20' });
    assert.equal(registry.take('s1'), null);
    registry.clear('s2');
    assert.equal(registry.take('s2'), null);
  });

  it('gateway keeps correction payload gated and gives correction precedence over proposal', async () => {
    const off = await gatewayTurn({ enabled: false, text: 'corrige valor para R$ 42,50' });
    assert.equal(Object.hasOwn(off, 'correction'), false);

    const corrected = await gatewayTurn({
      enabled: true,
      text: 'corrige valor para R$ 42,50',
      recordProposal: true,
    });
    assert.deepEqual(corrected.correction, { field: 'amount', value: 'R$ 42,50' });
    assert.equal(Object.hasOwn(corrected, 'proposal'), false);
    assert.doesNotMatch(JSON.stringify(corrected), /operationId|proposalHash|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    const normal = await gatewayTurn({ enabled: true, text: 'Quais contas?', recordProposal: true });
    assert.deepEqual(normal.proposal, { proposalId: 'opaque-proposal' });
    assert.equal(Object.hasOwn(normal, 'correction'), false);
  });
});
