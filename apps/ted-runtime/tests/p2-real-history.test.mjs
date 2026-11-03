// P2 real-history proof — local persistence/recovery of REAL OpenCode
// messages (SDK 2.2.4) across two OS processes, with zero inference.
//
// This test pins the real 2.2.4 cursor contract: a cursor carries its
// order/direction, so continuation requests omit the separate `order` field.
// Seed and recovery use official SDK history/import interfaces; no SQLite
// internals or prompt/provider calls are used.
//
// Phase 1 (seed subprocess): real SDK boot, synthetic sanitized transcript
// (60 user/assistant pairs, stable ids, ordered timestamps)
// imported via the OFFICIAL operation oc.experimental.session.import
// (transfer.import on the server), read back via oc.message.list, natural
// close. No direct sqlite writes; session.prompt never invoked.
// Phase 2 (recover subprocess): the SAME base reopened through the REAL
// path (createTedEnvironment + real conversation store + real loopback
// gateway + real createPromptHost + real withAuthenticatedSession), with
// conversation metadata persisted by phase 1. session.prompt on the real SDK
// object is wrapped to count and throw BEFORE delegating; the run asserts
// the counter stays 0. Controlled identity seam (synthetic cookie/device)
// and readHistory-frontier fault injection are the only seams — declared in
// the probe header and in the assertions below.
//
// LIMITS: the transcript is synthetic (fixed texts in the probe — never
// model output, never financial data). Proven real: cross-process SQLite
// persistence of imported messages, registry persistence, gateway DTO,
// binding lifecycle, and the history-error boundary. No PWA E2E is claimed.
//
// Temp dirs come from the approved folder and are NEVER deleted here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'helpers', 'p2-real-history-probe.mjs');
const CHILD_TIMEOUT_MS = 180000;

function runProbe(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, CHILD_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String((e && e.message) || e), json: null }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let json = null;
      try {
        const last = stdout.trim().split('\n').filter(Boolean).pop();
        json = last ? JSON.parse(last) : null;
      } catch { /* keep null */ }
      resolve({ code: signal ? `signal:${signal}` : code, stdout, stderr, json });
    });
  });
}

function requireOk(label, r) {
  if (r.code !== 0 || !r.json || r.json.ok !== true) {
    const step = (r.json && r.json.step) || `exit=${r.code}`;
    const detail = (r.json && r.json.detail) || r.stderr.slice(-400);
    const childErr = r.stderr.trim().split('\n').filter(Boolean).slice(-8).join(' | ').slice(-600);
    assert.fail(`${label} BLOQUEADA/REPROVADA (${step}): ${detail} — child-stderr: ${childErr} — sem afirmação de funcionamento real`);
  }
  return r.json;
}

describe('P2 real-history: imported transcript persists across processes; recovery reads it with zero prompts', () => {
  it('seed importa via official transfer.import; recover reabre a mesma base pelo caminho real (gateway + binding + 503 boundary)', { timeout: 300000 }, async () => {
    const root = approvedTmpRoot('ted-p2hist');
    const seeded = requireOk('fase seed', await runProbe(['seed', root]));
    assert.equal(seeded.phase, 'seed');
    assert.ok(typeof seeded.sessionId === 'string' && seeded.sessionId.length > 0, 'seed retorna sessionId');
    assert.ok(typeof seeded.conversationId === 'string' && seeded.conversationId.length > 0, 'seed retorna conversationId');
    assert.equal(seeded.messageCount, 120, 'seed persiste várias páginas de histórico');
    assert.equal(seeded.promptCalls, 0, 'seed sem session.prompt (sem inferência)');
    assert.deepEqual(seeded.checks, {
      importInterface: true, messageListRead: true, contextArray: true, registryAttached: true,
    });

    const recovered = requireOk(
      'fase recover',
      await runProbe(['recover', root, seeded.sessionId, seeded.conversationId, seeded.userMessageId, seeded.assistantMessageId]),
    );
    assert.equal(recovered.phase, 'recover');
    assert.equal(recovered.promptCalls, 0, 'recover com zero session.prompt (guard nunca disparou — sem inferência)');
    assert.equal(recovered.transportCalls, 0, 'history path sem transporte financeiro/API externa');
    assert.equal(recovered.insideBinding, 'bound:test-actor-p2-history', 'leitura válida executou dentro do binding server-side');
    assert.equal(recovered.afterBindingRevoked, true, 'binding revogado após a janela guardada');
    assert.deepEqual(recovered.checks, {
      healthyDto: true, orderDedup: true, bindingInside: true, bindingRevoked: true,
      negativesFailClosed: true, failureIs503: true, fixedMessage: true,
      recoverySameIds: true, zeroPrompt: true, zeroTransport: true,
    });
    // Same session/conversation, ids/content/order/dedup against the seed.
    assert.equal(recovered.sessionId, seeded.sessionId);
    assert.equal(recovered.conversationId, seeded.conversationId);
    assert.equal(recovered.items.length, seeded.messageCount);
    assert.equal(recovered.items[0].id, seeded.userMessageId);
    assert.equal(recovered.items[1].id, seeded.assistantMessageId);
    assert.equal(recovered.items[0].content, seeded.userText);
    assert.equal(recovered.items[1].content, seeded.assistantText);
    assert.equal(recovered.items.at(-1).id, seeded.lastMessageId);
    assert.equal(new Set(recovered.items.map((item) => item.id)).size, recovered.items.length, 'ids sem duplicação após paginação');
    for (let i = 1; i < recovered.items.length; i++) {
      assert.ok(Date.parse(recovered.items[i].createdAt) > Date.parse(recovered.items[i - 1].createdAt), `mensagem ${i} permanece em ordem cronológica`);
    }
  });
});
