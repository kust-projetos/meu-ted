// SPIKE 05 — CLI experimental de confirmação (isolado, sintético, in-memory).
//
// TEST-DOUBLE NÃO-AUTORITATIVO: o store deste arquivo (createStore) NÃO é a
// autoridade Pending V2 — é um double sintético apenas para isolar a UX de
// confirmação neste spike (ação explícita obrigatória; texto livre "sim"
// nunca confirma). NENHUMA asserção comportamental de idempotência,
// persistência, recibo ou efeito contra este store vale como prova da
// fronteira confirmada: a autoridade é o Pending V2 real de
// pi-financeiro (apps/api/src/approvals/pending-v2.ts), exercido via
// bootstrap/finance-bridge.ts (runPropose + store in-memory real
// compartilhado no mesmo processo bridge). Prova contra o v2Store real em
// ted-local é follow-up OBRIGATÓRIO antes de qualquer conclusão sobre a
// fronteira confirmada. Não ler este CLI como autoridade.
//
// SCOPE: experiments/ted-runtime/spike-05 only. Nenhum import de bootstrap,
// plugins, ted-finance-tools, apps/*, .env, Postgres, containers, PWA ou
// Cloudflare. Loja 100% in-memory; --origin é apenas demonstração de chamada
// HTTP explícita (nunca acionada pelo harness).
//
// Contrato real de referência (somente leitura, verificado no spike):
//   POST /pending-operations/v2/:id/confirm  (confirmação)
//   GET  /pending-operations/v2/:id/outcome  (recibo/efeito)
// A tarefa cita "POST .../confirm + :id/outcome"; o outcome no servidor é GET
// — a CLI usa POST-confirm + GET-outcome quando --origin é passado.
//
// Regra dura: texto livre ("sim", "pode confirmar", etc.) NUNCA confirma.
// Só `--action confirm` + identidade sintética explícita confirma.
//
// Uso sintético (padrão, sem rede):
//   node scripts/confirm-cli.mjs --list
//   node scripts/confirm-cli.mjs --show --proposal-id <id>
//   node scripts/confirm-cli.mjs --action confirm --proposal-id <id> --actor synth-actor-s05-01 --workspace 00000000-0000-4000-8000-00000000000a
//   node scripts/confirm-cli.mjs --action cancel  --proposal-id <id> --actor synth-actor-s05-01 --workspace 00000000-0000-4000-8000-00000000000a
//
// Com origem experimental explícita (NUNCA produção; exige confirmação de
// variável de ambiente SPIKE05_ALLOW_HTTP=1):
//   SPIKE05_ALLOW_HTTP=1 node scripts/confirm-cli.mjs --action confirm --proposal-id <id> --actor <a> --workspace <w> --origin http://127.0.0.1:3001
//
// Harness importa: createStore, yesterdayUTC, KNOWN_*.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, '..', 'fixtures', 'synthetic-case-35-mercado.json');

export const KNOWN = {
  householdId: '00000000-0000-4000-8000-00000000000a',
  accountNubank: '11111111-1111-4111-8111-111111111112',
  accountItau: '11111111-1111-4111-8111-111111111111',
  categoryMercado: '22222222-2222-4222-8222-222222222221',
  actor: 'synth-actor-s05-01',
  device: 'synth-device-s05-01',
};

export function yesterdayUTC(nowMs = Date.now()) {
  return new Date(nowMs - 24 * 3600 * 1000).toISOString().slice(0, 10);
}

export function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

let seq = 0;

export function createStore() {
  const proposals = new Map(); // id -> proposal
  const byIntention = new Map(); // intentionId -> id
  const ledger = []; // efeitos sintéticos (máx 1 por proposta confirmada)

  function resolveAccount({ accountId, accountName }) {
    if (accountId) {
      if (accountId === KNOWN.accountNubank) return { id: KNOWN.accountNubank, name: 'Nubank' };
      if (accountId === KNOWN.accountItau) return { id: KNOWN.accountItau, name: 'Itaú' };
      const err = new Error(`unknown account ${accountId}`);
      err.code = 'account.not_found';
      throw err;
    }
    if (accountName) {
      const q = String(accountName).toLowerCase();
      if (q === 'nubank') return { id: KNOWN.accountNubank, name: 'Nubank' };
      if (q === 'itaú' || q === 'itau') return { id: KNOWN.accountItau, name: 'Itaú' };
      if (q === 'banco') {
        const err = new Error("ambiguous account 'banco': matches Itaú + Nubank — disambiguation required");
        err.code = 'account.ambiguous';
        throw err;
      }
      const err = new Error(`unknown account name ${accountName}`);
      err.code = 'account.not_found';
      throw err;
    }
    const err = new Error('account required');
    err.code = 'account.required';
    throw err;
  }

  function propose(input = {}) {
    if (input.simulateTransportFailure) {
      const err = new Error('transport failed before proposal — fail-closed, 0 effects');
      err.code = 'transport.failed';
      throw err;
    }
    const {
      workspaceId, actorId, amountCents, accountId, accountName, categoryId,
      description, date, intentionId, expiresInMs = 10 * 60 * 1000,
    } = input;
    if (!workspaceId) throw Object.assign(new Error('workspaceId required'), { code: 'workspace.required' });
    if (!actorId) throw Object.assign(new Error('actorId required'), { code: 'actor.required' });
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw Object.assign(new Error(`invalid amountCents ${String(amountCents)}`), { code: 'amount.invalid' });
    }
    if (categoryId && categoryId !== KNOWN.categoryMercado) {
      throw Object.assign(new Error(`unknown category ${categoryId}`), { code: 'category.not_found' });
    }
    const account = resolveAccount({ accountId, accountName });
    if (intentionId && byIntention.has(intentionId)) {
      return proposals.get(byIntention.get(intentionId)); // repetição LLM: mesma intenção, mesma proposta
    }
    seq += 1;
    const id = `s05-prop-${String(seq).padStart(3, '0')}`;
    const now = Date.now();
    const proposal = {
      id,
      workspaceId,
      actorId,
      amountCents,
      accountId: account.id,
      accountName: account.name,
      categoryId: categoryId || KNOWN.categoryMercado,
      description: description || 'mercado',
      date: date || yesterdayUTC(now),
      kind: 'expense',
      status: 'proposed',
      intentionId: intentionId || null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
      effects: 0,
      receipt: null,
    };
    proposals.set(id, proposal);
    if (intentionId) byIntention.set(intentionId, id);
    return proposal;
  }

  function confirm({ id, actorId, workspaceId, action }) {
    if (action !== 'confirm') {
      throw Object.assign(new Error("explicit action 'confirm' required — free text never confirms"), { code: 'action.required' });
    }
    const p = proposals.get(id);
    if (!p) throw Object.assign(new Error(`proposal ${id} not found`), { code: 'proposal.not_found' });
    if (workspaceId !== p.workspaceId) {
      throw Object.assign(new Error('workspace mismatch — confirmation denied'), { code: 'workspace.mismatch' });
    }
    if (actorId !== p.actorId) {
      throw Object.assign(new Error('confirmation by another user denied without delegation'), { code: 'actor.forbidden' });
    }
    if (Date.now() > Date.parse(p.expiresAt)) {
      p.status = 'expired';
      throw Object.assign(new Error('proposal expired — confirmation denied'), { code: 'proposal.expired' });
    }
    if (p.status === 'cancelled') {
      throw Object.assign(new Error('proposal cancelled — confirmation denied'), { code: 'proposal.cancelled' });
    }
    if (p.status === 'confirmed') {
      return p; // duplicada: idempotente, sem novo efeito
    }
    p.status = 'confirmed';
    p.effects = 1;
    p.receipt = {
      operationId: p.id,
      entityId: `synth-tx-${p.id}`,
      confirmedBy: actorId,
      confirmedAt: new Date(Date.now()).toISOString(),
      amountCents: p.amountCents,
    };
    ledger.push({ proposalId: p.id, amountCents: p.amountCents, entityId: p.receipt.entityId });
    return p;
  }

  function cancel({ id, actorId, workspaceId }) {
    const p = proposals.get(id);
    if (!p) throw Object.assign(new Error(`proposal ${id} not found`), { code: 'proposal.not_found' });
    if (workspaceId !== p.workspaceId) throw Object.assign(new Error('workspace mismatch'), { code: 'workspace.mismatch' });
    if (actorId !== p.actorId) throw Object.assign(new Error('forbidden'), { code: 'actor.forbidden' });
    if (p.status !== 'proposed') throw Object.assign(new Error(`cannot cancel from ${p.status}`), { code: 'proposal.not_cancellable' });
    p.status = 'cancelled';
    return p;
  }

  function outcome(id) {
    const p = proposals.get(id);
    if (!p) throw Object.assign(new Error(`proposal ${id} not found`), { code: 'proposal.not_found' });
    if (p.status === 'confirmed' && !p.receipt) return { status: 'unverified', effects: p.effects, receipt: null };
    return { status: p.status, effects: p.effects, receipt: p.receipt };
  }

  function executeDirect() {
    throw Object.assign(new Error('direct execution by the LLM denied — confirm first via explicit action'), { code: 'execution.requires_confirmation' });
  }

  function save() {
    return JSON.stringify({ proposals: [...proposals.values()], byIntention: [...byIntention.entries()], ledger });
  }

  function load(json) {
    const data = JSON.parse(json);
    proposals.clear();
    byIntention.clear();
    ledger.length = 0;
    for (const p of data.proposals) proposals.set(p.id, p);
    for (const [k, v] of data.byIntention) byIntention.set(k, v);
    for (const e of data.ledger) ledger.push(e);
    const max = [...proposals.keys()]
      .map((k) => Number(String(k).split('-').pop()))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), seq);
    seq = Math.max(seq, max);
  }

  return { propose, confirm, cancel, outcome, executeDirect, save, load, ledger, _proposals: proposals };
}

// ---- CLI (executado apenas quando arquivo é entrypoint) ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const out = { _: [] };
  const takesValue = new Set(['action', 'proposal-id', 'actor', 'workspace', 'origin', 'text', 'say']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        const key = a.slice(2);
        if (takesValue.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          out[key] = argv[i + 1];
          i += 1;
        } else {
          out[key] = true; // flag booleano (--list, --show, --help)
        }
      } else {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function validateExperimentalOrigin(raw) {
  const hint = 'expected http://127.0.0.1:<port>, http://localhost:<port> or http://[::1]:<port>';
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`refused: --origin must be an explicit http loopback origin (${hint})`);
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`refused: invalid --origin ${JSON.stringify(raw)} — ${hint}`);
  }
  if (u.protocol !== 'http:') {
    throw new Error(`refused: --origin must use http (loopback experiment only), got ${JSON.stringify(u.protocol)} — ${hint}`);
  }
  if (u.username || u.password) {
    throw new Error(`refused: --origin must not contain credentials — ${hint}`);
  }
  const host = u.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!isLoopback) {
    throw new Error(`refused: --origin host ${JSON.stringify(u.hostname)} is not loopback-only — ${hint}`);
  }
  if (!u.port) {
    throw new Error(`refused: --origin must include an explicit port — ${hint}`);
  }
  const portNum = Number(u.port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(`refused: --origin port ${JSON.stringify(u.port)} is invalid — ${hint}`);
  }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    throw new Error(`refused: --origin must be a bare origin without path/query/fragment — ${hint}`);
  }
  const normalizedHost = host === '::1' || host === '[::1]' ? '[::1]' : host;
  return `http://${normalizedHost}:${portNum}`;
}

async function httpConfirmOutcome({ origin, id, actor, workspace, action }) {
  if (action !== undefined && action !== 'confirm') {
    // P2: cancelamento HTTP NÃO é simulado via confirm. A rota real de
    // cancelamento no Pending V2 é POST /pending-operations/v2/:id/cancel
    // (ou /reject) com capability financial.approval.cancel — o bridge
    // one-shot deste spike só allowlista propose, logo --origin + cancel é
    // explicitamente recusado até haver superfície real exposta.
    throw new Error('HTTP cancellation not supported: --origin only supports --action confirm (POST confirm + GET outcome); cancellation requires the real POST /pending-operations/v2/:id/cancel surface, which this one-shot bridge does not expose — refusing instead of simulating cancel via confirm');
  }
  if (process.env.SPIKE05_ALLOW_HTTP !== '1') {
    throw new Error('refused: --origin requires SPIKE05_ALLOW_HTTP=1 and an explicit http loopback origin (http://127.0.0.1:<port>, http://localhost:<port> or http://[::1]:<port>)');
  }
  const safeOrigin = validateExperimentalOrigin(origin);
  const cRes = await fetch(`${safeOrigin}/pending-operations/v2/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-synth-actor': actor, 'x-synth-workspace': workspace },
    body: JSON.stringify({ action, actorId: actor, workspaceId: workspace }),
    redirect: 'manual',
  });
  if (cRes.status >= 300 && cRes.status < 400) {
    throw new Error(`refused: confirm endpoint redirected (${cRes.status} location=${JSON.stringify(cRes.headers.get('location'))}) — refusing to follow redirect outside loopback`);
  }
  const cBody = await cRes.text();
  const oRes = await fetch(`${safeOrigin}/pending-operations/v2/${encodeURIComponent(id)}/outcome`, {
    headers: { 'x-synth-actor': actor, 'x-synth-workspace': workspace },
    redirect: 'manual',
  });
  if (oRes.status >= 300 && oRes.status < 400) {
    throw new Error(`refused: outcome endpoint redirected (${oRes.status} location=${JSON.stringify(oRes.headers.get('location'))}) — refusing to follow redirect outside loopback`);
  }
  const oBody = await oRes.text();
  return { confirmStatus: cRes.status, confirmBody: cBody, outcomeStatus: oRes.status, outcomeBody: oBody };
}

if (isMain) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h) {
      console.log(`spike-05 confirm-cli (synthetic, in-memory)\n\n  --list | --show --proposal-id <id> | --action confirm|cancel --proposal-id <id> --actor <a> --workspace <w>\n  Free text ("sim") never confirms. --origin requires SPIKE05_ALLOW_HTTP=1 and a loopback-only origin (http://127.0.0.1:<port> | http://localhost:<port> | http://[::1]:<port>).`);
      process.exit(0);
    }
    // Texto livre nunca confirma: qualquer posicional vira erro explícito.
    if (args._.length > 0) {
      console.error(`refused: free text ${JSON.stringify(args._)} is never confirmation — use --action confirm`);
      process.exit(2);
    }
    if (args.text || args.say) {
      console.error(`refused: --text/--say is never confirmation — use --action confirm`);
      process.exit(2);
    }
    const store = createStore();
    const fixture = loadFixture();
    const demo = store.propose({
      workspaceId: KNOWN.householdId,
      actorId: KNOWN.actor,
      amountCents: fixture.expected.amountCents,
      accountId: fixture.expected.accountId,
      categoryId: fixture.expected.categoryId,
      description: fixture.expected.description,
      date: yesterdayUTC(),
      intentionId: 'int-synth-s05-demo-01',
    });
    if (args.list) {
      console.log(JSON.stringify({ proposals: [demo] }, null, 2));
      process.exit(0);
    }
    const pid = args['proposal-id'] || demo.id;
    if (args.show) {
      const p = pid === demo.id ? demo : null;
      if (!p) { console.error(`proposal ${pid} not found in synthetic demo store`); process.exit(1); }
      console.log(JSON.stringify(p, null, 2));
      process.exit(0);
    }
    const action = args.action;
    if (!action) {
      console.error('refused: --action confirm|cancel is required (proposal is listed, nothing was executed)');
      console.error(`proposal: ${JSON.stringify(demo, null, 2)}`);
      process.exit(2);
    }
    if (args.origin) {
      if (action === 'cancel') {
        // P2: sem simulação de cancel via confirm em origem HTTP. A rota real
        // é POST /pending-operations/v2/:id/cancel (ou /reject) no Pending V2
        // — não exposta por este bridge one-shot (só propose allowlisted).
        console.error('HTTP cancellation not supported: --origin + --action cancel refused; cancellation requires the real POST /pending-operations/v2/:id/cancel surface');
        process.exit(2);
      }
      try {
        const r = await httpConfirmOutcome({ origin: args.origin, id: pid, actor: args.actor, workspace: args.workspace, action });
        console.log(JSON.stringify(r, null, 2));
        process.exit(0);
      } catch (err) {
        console.error(String(err && err.message ? err.message : err));
        process.exit(2);
      }
    }
    try {
      // Local (sem --origin): opera SOMENTE o double sintético deste arquivo —
      // correlação de UX, sem valor de autoridade Pending V2.
      const out = action === 'cancel'
        ? store.cancel({ id: pid, actorId: args.actor, workspaceId: args.workspace })
        : store.confirm({ id: pid, actorId: args.actor, workspaceId: args.workspace, action });
      console.log(JSON.stringify({ proposal: out, outcome: store.outcome(pid) }, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`denied [${err.code || 'error'}]: ${err.message}`);
      process.exit(3);
    }
  })();
}
