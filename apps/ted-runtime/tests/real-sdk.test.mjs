// Prova de boot real — invoca a sonda em SUBPROCESSOS separados
// (tests/helpers/real-boot-probe.mjs): boot, depois restart em OUTRO
// processo (OS de verdade), TUDO DENTRO DE UM ÚNICO `it` sequencial — sem
// dependência via env entre casos (evita falha cascading).
// A sonda importa '@opencode/sdk' por especificador nu (dep declarada exata
// 2.2.4) e SOMENTE após setupIsolation. Sem SDK instalado a sonda falha
// EXPLICITAMENTE; este teste propaga a falha, nunca dá skip fingido.
// Timeout explícito do teste (300s) MAIOR que o timeout de cada subprocesso
// (180s): o default do node:test não pode estourar no meio da espera.
// Sem inferência em nenhuma fase: a fase catalog prova a fronteira — como
// o setup do plugin 2.2.4 só roda no prompt (a admissão seria uma tentativa
// de inferência, não autorizada), a prova ao vivo falha fechada como
// BLOCKED em vez de fabricar um catálogo.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'helpers', 'real-boot-probe.mjs');
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
    assert.fail(`${label} BLOQUEADA/REPROVADA (${step}): ${detail} — sem afirmação de funcionamento real`);
  }
  return r.json;
}

describe('real SDK 2.2.4 boot em subprocessos (sem inferência)', () => {
  it('boot isolado → restart em OUTRO processo (sqlite persiste, binding some, re-wire + re-bind recuperam)', { timeout: 300000 }, async () => {
    const root = approvedTmpRoot('ted-realsdk');
    const booted = requireOk('fase boot', await runProbe(['boot', root]));
    assert.equal(booted.phase, 'boot');
    assert.ok(typeof booted.sessionId === 'string' && booted.sessionId.length > 0, 'boot retorna sessionId');
    assert.equal(booted.promptCalled, false, 'nenhum prompt/inferência em nenhuma fase (sem provider, sem custo)');
    assert.deepEqual(booted.checks, {
      nativeMethods: true,
      sessionActiveProbe: true,
      messageListShape: true,
      abIsolation: true,
      toolDefs: ['list_accounts', 'get_month_summary'],
      denyPolicy: true,
      effectiveCatalogLive: 'pending-provider',
    });

    const restarted = requireOk('fase restart', await runProbe(['restart', root, booted.sessionId]));
    assert.equal(restarted.phase, 'restart');
    assert.deepEqual(restarted.checks, { preFailClosed: true, freshHasPlugin: false, rewired: true, reboundGet: true, reboundAuthenticated: false });
  });

  it('real application entrypoint boots the SDK gateway on loopback and closes cleanly (zero inference)', { timeout: 300000 }, async () => {
    // Proves the real src/main.mjs startup path (not a fake seam): actual
    // SDK boot under a unique isolated home, loopback API origin on an
    // unused port (never dialed — no request is made), ephemeral gateway
    // port, then clean close + natural subprocess exit. No /rpc/chat, no
    // provider calls, no Docker, no API data.
    const root = approvedTmpRoot('ted-realsdk-entry');
    const entry = requireOk('fase entrypoint', await runProbe(['entrypoint', root]));
    assert.equal(entry.phase, 'entrypoint');
    assert.equal(entry.host, '127.0.0.1', 'listener is always loopback, never from env');
    assert.ok(Number.isInteger(entry.port) && entry.port > 0 && entry.port <= 65535, 'ephemeral gateway port assigned');
    assert.equal(entry.promptCalls, 0, 'zero session.prompt calls (no inference, no provider work)');
    assert.equal(entry.apiCalls, 0, 'zero API/transport calls (origin never dialed)');
  });

  it('live tool-catalog proof: exact gated catalog with zero prompts, else fail-closed BLOCKED', { timeout: 300000 }, async () => {
    // Pinned 2.2.4 delays plugin setup until a prompt runs (proven: 20s
    // idle post-wire + session.create fire no setup). Triggering setup
    // requires session.prompt — an inference request attempt — and no
    // paid/real inference is authorized. The probe therefore either reports
    // the exact effective catalog with zero prompt calls (if setup ever
    // fires without one) or fails closed as catalog-blocked. Both are
    // honest; a fabricated catalog is never accepted.
    const root = approvedTmpRoot('ted-realsdk-cat');
    const r = await runProbe(['catalog', root]);
    assert.ok(r.json && typeof r.json === 'object', 'probe reports a structured outcome');
    assert.equal(r.json.phase, 'catalog');
    if (r.json.ok === true) {
      assert.equal(r.code, 0);
      assert.equal(r.json.promptCalls, 0, 'zero session.prompt calls for the exact-catalog claim');
      assert.equal(r.json.sessionAgent, 'ted', 'real sessions explicitly use agent ted');
      assert.ok(
        Array.isArray(r.json.observed)
        && r.json.observed.includes('list_accounts')
        && r.json.observed.includes('get_month_summary'),
        'final effective prompt-loop catalog (after transform) contains the two finance tools',
      );
      assert.ok(r.json.observed.includes('shell'), 'probe observed the real native catalog (built-ins present, gated by pinned denies)');
    } else {
      assert.notEqual(r.code, 0, 'BLOCKED proof exits non-zero');
      assert.equal(r.json.step, 'catalog-blocked', 'fail-closed BLOCKED, never a fabricated catalog');
      assert.match(String(r.json.detail || ''), /without a prompt|inference/i);
    }
  });
});
