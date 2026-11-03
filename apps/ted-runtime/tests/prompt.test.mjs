// P1 prompt adapter tests (doubles only — no SDK, no inference).
// Proves 2.2.4 semantics: prompt admits (no assistant output in return),
// output comes from re-read native history, intentionId is the native id,
// duplicates fail closed, abort maps to interrupt, provider gaps are typed
// errors (never fabricated output), and the effective catalog lives only
// inside plugin context.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assistantTextAfterAdmitted, classifyPromptFailure, createPromptHost, projectHistoryItems } from '../src/prompt.mjs';
import { getEffectiveToolNames } from '../src/plugin.mjs';

function assistantRows(text, id = 'msg_asst_1') {
  return {
    data: [
      { id, type: 'assistant', agent: 'ted', model: { id: 'm', providerID: 'p' }, content: [{ type: 'text', text }], time: { created: 1761870001000 } },
    ],
    cursor: { previous: null, next: null },
  };
}

// message.list double faithful to pinned 2.2.4 cursor semantics: order and
// direction are carried in the opaque cursor, so continuation omits `order`;
// a non-empty last page still has a cursor followed by an empty sentinel page.
function pagedList(allAsc, { onCall } = {}) {
  return async (args = {}) => {
    const { limit = 50, cursor } = args;
    const match = typeof cursor === 'string' ? /^(asc|desc):(\d+)$/.exec(cursor) : null;
    if (cursor !== undefined && !match) throw new Error('invalid test cursor');
    const order = match ? match[1] : (args.order ?? 'asc');
    if (onCall) onCall({ order: args.order, effectiveOrder: order, limit, cursor });
    const lim = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50;
    let slice;
    let next;
    if (order === 'desc') {
      const rawEnd = match ? Number(match[2]) : allAsc.length;
      const end = Number.isFinite(rawEnd) ? Math.min(Math.max(rawEnd, 0), allAsc.length) : allAsc.length;
      const start = Math.max(0, end - lim);
      slice = allAsc.slice(start, end).reverse();
      next = slice.length > 0 ? `desc:${start}` : null;
    } else {
      const rawStart = match ? Number(match[2]) : 0;
      const start = Number.isFinite(rawStart) ? Math.max(rawStart, 0) : 0;
      slice = allAsc.slice(start, start + lim);
      next = slice.length > 0 ? `asc:${start + slice.length}` : null;
    }
    return { data: slice, cursor: { previous: null, next } };
  };
}

function userRow(id, text, created) {
  return { id, type: 'user', text, time: { created } };
}

function assistantRow(id, text, created) {
  return { id, type: 'assistant', agent: 'ted', model: { id: 'm', providerID: 'p' }, content: [{ type: 'text', text }], time: { created } };
}

describe('prompt adapter (2.2.4 facts)', () => {
  it('admits via prompt with intentionId as native id; output from native history', async () => {
    const calls = [];
    const oc = {
      session: {
        prompt: async (args) => {
          calls.push(args);
          return { id: 'inbox_1', sessionID: 'ses_1', time: { created: 1761870000000 }, type: 'user', payload: { text: args.text }, delivery: 'steer' };
        },
      },
      message: {
        list: pagedList([
          userRow('inbox_1', 'contas?', 1761870000000),
          assistantRow('msg_asst_1', 'Grounded answer', 1761870001000),
        ]),
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 2000 });
    const out = await host.chat({ sessionID: 'ses_1', text: 'contas?', intentionId: 'msg_int-1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'msg_int-1', 'msg_-shaped stable PWA intentionId is reused as the native prompt id (native admission rejects anything else)');
    assert.equal(calls[0].sessionID, 'ses_1');
    assert.equal(out.output, 'Grounded answer');
    assert.equal(out.turnId, 'msg_asst_1');
  });

  it('non-msg_ intentionIds are admitted without a native id (receipt correlation, no validation failure)', async () => {
    const calls = [];
    const oc = {
      session: {
        prompt: async (args) => {
          calls.push(args);
          return { id: 'msg_admitted_9', sessionID: 'ses_1', time: { created: 1761870000000 }, type: 'user', payload: { text: args.text }, delivery: 'steer' };
        },
      },
      message: {
        list: pagedList([
          userRow('msg_admitted_9', 'contas?', 1761870000000),
          assistantRow('msg_ans_9', 'ok', 1761870001000),
        ]),
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 2000 });
    const out = await host.chat({ sessionID: 'ses_1', text: 'contas?', intentionId: 'pwa-legacy-1' });
    assert.equal(calls.length, 1);
    assert.ok(!('id' in calls[0]), 'native admission accepts only msg_ ids, so the host omits other PWA ids and correlates via the receipt');
    assert.equal(out.output, 'ok');
    assert.equal(out.userMessageId, 'msg_admitted_9');
  });

  it('duplicate intentionId fails closed — no second prompt issued', async () => {
    let prompts = 0;
    const oc = {
      session: { prompt: async () => { prompts++; return { id: 'inbox_1', sessionID: 'ses_1', time: { created: 1761870000000 }, type: 'user', payload: { text: 'a?' }, delivery: 'steer' }; } },
      message: {
        list: pagedList([
          userRow('inbox_1', 'a?', 1761870000000),
          assistantRow('msg_asst_1', 'ok', 1761870001000),
        ]),
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 2000 });
    await host.chat({ sessionID: 'ses_1', text: 'a?', intentionId: 'dup-1' });
    assert.ok(host.hasIntention('dup-1'));
    const err = await host.chat({ sessionID: 'ses_1', text: 'a?', intentionId: 'dup-1' }).catch((e) => e);
    assert.equal(err.code, 'prompt.duplicate');
    assert.equal(prompts, 1, 'native prompt issued exactly once');
  });

  it('aborted caller signal maps to session.interrupt (local cancel is not enough)', async () => {
    const interrupted = [];
    const oc = {
      session: {
        prompt: async () => { await new Promise((r) => setTimeout(r, 50)); return { id: 'inbox_9' }; },
        interrupt: async ({ sessionID }) => { interrupted.push(sessionID); return { ok: true }; },
      },
      message: { list: async () => assistantRows('late') },
    };
    const host = createPromptHost({ oc, timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = host.chat({ sessionID: 'ses_9', text: 'long?', intentionId: 'cancel-1', signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e) => e);
    assert.equal(err.code, 'prompt.cancelled');
    assert.deepEqual(interrupted, ['ses_9'], 'server run interrupted, not just locally dropped');
  });

  it('no assistant output is a typed failure — never an empty success', async () => {
    const oc = {
      session: { prompt: async () => ({ id: 'inbox_2' }) },
      message: { list: async () => ({ data: [], cursor: null }) },
    };
    const host = createPromptHost({ oc, timeoutMs: 300, pollIntervalMs: 50 });
    const err = await host.chat({ sessionID: 'ses_2', text: 'x?', intentionId: 'empty-1' }).catch((e) => e);
    assert.equal(err.code, 'prompt.no_output');
  });

  it('surfaces a persisted provider transport error instead of timing out as prompt.no_output', async () => {
    let promptCalls = 0;
    const admitted = userRow('inbox_transport', 'contas?', 1761870000000);
    const failed = {
      id: 'msg_transport_error',
      type: 'assistant',
      agent: 'ted',
      model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
      finish: 'error',
      error: { type: 'provider.transport' },
      content: [],
      time: { created: 1761870001000 },
    };
    const oc = {
      session: { prompt: async () => { promptCalls++; return { id: admitted.id }; } },
      message: { list: pagedList([admitted, failed]) },
    };
    const host = createPromptHost({ oc, timeoutMs: 300, pollIntervalMs: 10 });
    const err = await host.chat({ sessionID: 'ses_transport', text: 'contas?', intentionId: 'transport-1' }).catch((e) => e);
    assert.equal(err.code, 'provider.transport');
    assert.equal(promptCalls, 1, 'persisted terminal error must not trigger a second prompt');
  });

  it('provider gaps are typed errors, never fallback inference', async () => {
    const noPrompt = createPromptHost({ oc: { session: {} } });
    const e1 = await noPrompt.chat({ sessionID: 's', text: 'x', intentionId: 'i-1' }).catch((e) => e);
    assert.equal(e1.code, 'provider.unavailable');

    const denied = createPromptHost({
      oc: {
        session: { prompt: async () => { throw new Error('provider denied: quota exhausted'); } },
        message: { list: async () => assistantRows('x') },
      },
    });
    const e2 = await denied.chat({ sessionID: 's', text: 'x', intentionId: 'i-2' }).catch((e) => e);
    assert.equal(e2.code, 'provider.denied');

    assert.equal(classifyPromptFailure(new Error('no-route for model')).code, 'provider.unavailable');
  });

  it('history projects the EXACT 2.2.4 union (type/text+content/time.created number→ISO)', () => {
    const items = projectHistoryItems(
      {
        data: [
          userRow('u1', 'quanto gastei?', 1761870000000),
          { ...assistantRow('a1', 'R$ 42,50', 1761870001000), content: [{ type: 'text', text: 'R$ 42,50' }, { type: 'reasoning', text: 'hidden-chain' }] },
          { id: 's1', type: 'system', text: 'noise', time: { created: 1761870000500 } },
          { id: 'x1', role: 'assistant', parts: [{ type: 'text', text: 'LEGACY-SHAPE' }], createdAt: 't' },
          null,
          { id: 'a2', type: 'assistant', agent: 'ted', model: { id: 'm', providerID: 'p' }, content: [{ type: 'image', url: 'x' }], time: { created: 1761870002000 } },
        ],
        cursor: { previous: null, next: null },
      },
      { ownerActor: 'actor-A' },
    );
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      id: 'u1', actorId: 'actor-A', role: 'user', content: 'quanto gastei?',
      createdAt: new Date(1761870000000).toISOString(), isOwn: true,
    });
    assert.deepEqual(items[1], {
      id: 'a1', actorId: 'ted', role: 'assistant', content: 'R$ 42,50',
      createdAt: new Date(1761870001000).toISOString(), isOwn: false,
    });
  });

  it('output correlates to the admitted user id: old assistant answers are never returned', async () => {
    const oc = {
      session: {
        prompt: async (args) => ({
          id: 'inbox_new', sessionID: 'ses_corr', time: { created: 2000 },
          type: 'user', payload: { text: args.text }, delivery: 'steer',
        }),
      },
      message: {
        list: pagedList([
          userRow('u_old', 'old?', 1000),
          assistantRow('a_old', 'OLD ANSWER', 1001),
          userRow('inbox_new', 'contas?', 2000),
          assistantRow('a_new', 'NEW ANSWER', 2001),
        ]),
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 2000 });
    const out = await host.chat({ sessionID: 'ses_corr', text: 'contas?', intentionId: 'corr-1' });
    assert.equal(out.output, 'NEW ANSWER');
    assert.equal(out.turnId, 'a_new');
  });

  it('pre-prompt snapshot is excluded: polls until the admitted turn answers (never the old one)', async () => {
    let calls = 0;
    const base = () => (calls === 1
      ? [userRow('u_old', 'old?', 1000), assistantRow('a_old', 'OLD ANSWER', 1001)]
      : [
        userRow('u_old', 'old?', 1000),
        assistantRow('a_old', 'OLD ANSWER', 1001),
        userRow('inbox_snap', 'contas?', 2000),
        assistantRow('a_snap', 'SNAP ANSWER', 2001),
      ]);
    const oc = {
      session: {
        prompt: async (args) => ({
          id: 'inbox_snap', sessionID: 'ses_snap', time: { created: 2000 },
          type: 'user', payload: { text: args.text }, delivery: 'steer',
        }),
      },
      message: {
        list: async (args) => {
          calls++;
          return pagedList(base())(args);
        },
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 3000, pollIntervalMs: 20 });
    const out = await host.chat({ sessionID: 'ses_snap', text: 'contas?', intentionId: 'snap-1' });
    assert.equal(out.output, 'SNAP ANSWER');
    assert.ok(calls >= 2, 're-read native history until the admitted turn answers');
  });

  it('history projects PWA items; unknown shapes skipped, never invented', () => {
    const items = projectHistoryItems(
      [
        { ...userRow('m1', 'oi', 1761870000000) },
        { ...assistantRow('m2', 'olá', 1761870001000) },
        { type: 'assistant', content: [] },
        null,
        { id: 'm3', type: 'assistant', agent: 'ted', model: { id: 'm', providerID: 'p' }, content: [{ type: 'image', url: 'x' }], time: { created: 1761870002000 } },
      ],
      { ownerActor: 'actor-A' },
    );
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      id: 'm1', actorId: 'actor-A', role: 'user', content: 'oi',
      createdAt: new Date(1761870000000).toISOString(), isOwn: true,
    });
    assert.equal(items[1].actorId, 'ted');
    assert.equal(items[1].isOwn, false);
  });

  it('history carries the PWA intentionId via persisted userMessageId mapping (native id differs)', () => {
    // PWA anchors its optimistic message by PWA intentionId, but the native
    // admitted id is a different `msg_*` id (non-msg PWA UUIDs are omitted
    // from native prompt input). The persisted intention registry maps the
    // admitted native id back to the PWA intention — projected, never stored
    // in a second transcript, and never the runtimeSessionId.
    const rows = [
      userRow('msg_native_9', 'quanto?', 1000),
      assistantRow('a9', 'R$ 1', 1001),
    ];
    const items = projectHistoryItems(rows, {
      ownerActor: 'actor-A',
      userMeta: { msg_native_9: { intentionId: 'pwa-9', actorId: 'actor-A' } },
    });
    assert.equal(items[0].id, 'msg_native_9');
    assert.notEqual(items[0].id, 'pwa-9', 'exact native id differs from the PWA id');
    assert.equal(items[0].intentionId, 'pwa-9', 'PWA reload correlates by identity, not text/time');
    assert.equal(items[0].actorId, 'actor-A');
    assert.ok(!('runtimeSessionId' in items[0]), 'no native session id leaks into history');
  });

  it('history attributes each user message to its own author; unmapped falls back to owner', () => {
    const rows = [
      userRow('uA', 'a?', 1000),
      assistantRow('aA', 'x', 1001),
      userRow('uB', 'b?', 1002),
      userRow('uLegacy', 'c?', 1003),
    ];
    const items = projectHistoryItems(rows, {
      ownerActor: 'actor-A',
      userMeta: {
        uA: { intentionId: 'm-A', actorId: 'actor-A' },
        uB: { intentionId: 'm-B', actorId: 'actor-B' },
      },
    });
    const byId = Object.fromEntries(items.map((it) => [it.id, it]));
    assert.equal(byId.uA.actorId, 'actor-A');
    assert.equal(byId.uA.intentionId, 'm-A');
    assert.equal(byId.uB.actorId, 'actor-B', 'second member keeps their own authorship (ADR-027 collective)');
    assert.equal(byId.uB.intentionId, 'm-B');
    assert.equal(byId.uLegacy.actorId, 'actor-A', 'rows without intention metadata fall back to the owner');
    assert.ok(!('intentionId' in byId.uLegacy));
    assert.equal(byId.aA.actorId, 'ted', 'assistant rows are unaffected by user metadata');
    assert.ok(!('intentionId' in byId.aA));
  });

  it('isOwn follows the verified viewer, not the owner (PWA "Você" label)', () => {
    const rows = [
      userRow('uA', 'a?', 1000),
      assistantRow('aA', 'x', 1001),
      userRow('uB', 'b?', 1002),
    ];
    const userMeta = {
      uA: { intentionId: 'm-A', actorId: 'actor-A' },
      uB: { intentionId: 'm-B', actorId: 'actor-B' },
    };
    const asA = projectHistoryItems(rows, { ownerActor: 'actor-A', userMeta, viewerActor: 'actor-A' });
    const byIdA = Object.fromEntries(asA.map((it) => [it.id, it]));
    assert.equal(byIdA.uA.isOwn, true, 'viewer sees their own row as own');
    assert.equal(byIdA.uB.isOwn, false, 'viewer does NOT see the other member as self');
    assert.equal(byIdA.aA.isOwn, false);
    const asB = projectHistoryItems(rows, { ownerActor: 'actor-A', userMeta, viewerActor: 'actor-B' });
    const byIdB = Object.fromEntries(asB.map((it) => [it.id, it]));
    assert.equal(byIdB.uB.isOwn, true, 'converse for the other member');
    assert.equal(byIdB.uA.isOwn, false);
  });

  it('isOwn falls back to owner-only semantics without a viewer (legacy records)', () => {
    const rows = [userRow('u1', 'oi', 1000), assistantRow('m2', 'olá', 1001)];
    const items = projectHistoryItems(rows, { ownerActor: 'actor-A' });
    assert.equal(items[0].isOwn, true, 'legacy path without viewerActor keeps prior behavior');
    assert.equal(items[1].isOwn, false);
  });

  it('effective tool list exists ONLY inside plugin context (no HTTP tool group)', async () => {
    const names = await getEffectiveToolNames({ tool: { list: async () => [{ name: 'get_month_summary' }, { name: 'list_accounts' }] } });
    assert.deepEqual(names, ['get_month_summary', 'list_accounts']);
    await assert.rejects(() => getEffectiveToolNames({}), /only inside plugin context/);
    await assert.rejects(() => getEffectiveToolNames({ tool: {} }), /only inside plugin context/);
  });

  it('turn boundary: replay stops at the NEXT user message (A excludes B)', () => {
    const rows = [
      userRow('uA', 'first?', 1000),
      assistantRow('aA', 'ANSWER-A', 1001),
      userRow('uB', 'second?', 2000),
      assistantRow('aB', 'ANSWER-B', 2001),
    ];
    const replayA = assistantTextAfterAdmitted(rows, 'uA');
    assert.equal(replayA.text, 'ANSWER-A', 'retrying an older intention never includes later unrelated turns');
    assert.equal(replayA.turnId, 'aA');
    const replayB = assistantTextAfterAdmitted(rows, 'uB');
    assert.equal(replayB.text, 'ANSWER-B');
    assert.equal(replayB.turnId, 'aB');
  });

  it('turn boundary keeps every assistant step of the admitted turn, then stops', () => {
    const rows = [
      userRow('uA', 'go?', 1000),
      assistantRow('aA1', 'PART-1', 1001),
      assistantRow('aA2', 'PART-2', 1002),
      userRow('uB', 'next?', 2000),
      assistantRow('aB1', 'UNRELATED', 2001),
    ];
    const replayA = assistantTextAfterAdmitted(rows, 'uA');
    assert.equal(replayA.text, 'PART-1PART-2');
    assert.equal(replayA.turnId, 'aA2', 'turnId is the last assistant message of the admitted turn');
  });

  it('history pages through >50 messages preserving ascending order', async () => {
    const allAsc = [];
    for (let i = 0; i < 60; i++) {
      allAsc.push(userRow(`u${i}`, `q${i}?`, 1000 + i * 2));
      allAsc.push(assistantRow(`a${i}`, `r${i}`, 1001 + i * 2));
    }
    const seen = [];
    const oc = { message: { list: pagedList(allAsc, { onCall: (a) => seen.push(a) }) } };
    const host = createPromptHost({ oc, timeoutMs: 2000 });
    const items = await host.readHistory({ sessionID: 'ses_big', ownerActor: 'actor-A' });
    assert.equal(items.length, 120, 'no silent truncation past the first 50-item page');
    assert.equal(items[0].id, 'u0');
    assert.equal(items[119].id, 'a59');
    assert.equal(items[119].content, 'r59');
    assert.ok(seen.length >= 3, `paged through cursors (got ${seen.length} fetches)`);
    assert.equal(seen[0].order, 'asc');
    assert.equal(seen[0].limit, 50);
    assert.ok(seen.slice(1).every((a) => typeof a.cursor === 'string'), 'later pages follow the opaque cursor');
  });

  it('chat polls a bounded recent window (desc) even with >50 prior messages', async () => {
    const priors = [];
    for (let i = 0; i < 60; i++) {
      priors.push(userRow(`old-u${i}`, `old${i}?`, i * 2));
      priors.push(assistantRow(`old-a${i}`, `OLD${i}`, i * 2 + 1));
    }
    const full = [
      ...priors,
      userRow('msg_new_u', 'contas?', 1000000),
      assistantRow('msg_new_a', 'FRESH ANSWER', 1000001),
    ];
    const seen = [];
    const oc = {
      session: {
        prompt: async (args) => ({
          id: 'msg_new_u', sessionID: 'ses_big', time: { created: 1000000 },
          type: 'user', payload: { text: args.text }, delivery: 'steer',
        }),
      },
      message: { list: pagedList(full, { onCall: (a) => seen.push(a) }) },
    };
    const host = createPromptHost({ oc, timeoutMs: 2000, pollIntervalMs: 20 });
    const out = await host.chat({ sessionID: 'ses_big', text: 'contas?', intentionId: 'msg_big-1' });
    assert.equal(out.output, 'FRESH ANSWER');
    assert.equal(out.turnId, 'msg_new_a');
    assert.equal(seen[0].order, 'desc', 'current-turn polling reads the recent window, not the whole transcript');
    assert.ok(seen.length <= 3, `bounded recent search per turn (got ${seen.length} fetches, not a full re-walk per poll)`);
  });

  it('cursor boundaries: bare arrays and null cursors are single-page reads', async () => {
    let calls = 0;
    const ocBare = { message: { list: async () => { calls++; return [userRow('u1', 'oi', 1), assistantRow('a1', 'olá', 2)]; } } };
    const bare = createPromptHost({ oc: ocBare, timeoutMs: 2000 });
    const items = await bare.readHistory({ sessionID: 's', ownerActor: 'actor-A' });
    assert.equal(items.length, 2);
    assert.equal(calls, 1, 'a cursorless envelope is one page, never re-fetched');
    const ocNull = { message: { list: async () => ({ data: [userRow('u1', 'oi', 1)], cursor: null }) } };
    const nulled = createPromptHost({ oc: ocNull, timeoutMs: 2000 });
    assert.equal((await nulled.readHistory({ sessionID: 's', ownerActor: 'actor-A' })).length, 1);
  });

  it('endless pagination fails closed with history_overflow (never silently truncate)', async () => {
    const oc = {
      message: {
        list: async () => ({
          data: [assistantRow('aX', 'x', 1)],
          cursor: { previous: null, next: 'more-forever' },
        }),
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 2000 });
    const err = await host.readHistory({ sessionID: 's', ownerActor: 'a' }).catch((e) => e);
    assert.equal(err.code, 'prompt.history_overflow');
  });

  it('exactly 500 messages (10 full pages) still read; 501 overflows', async () => {
    const fiveHundred = [];
    for (let i = 0; i < 250; i++) {
      fiveHundred.push(userRow(`u${i}`, `q${i}`, i * 2));
      fiveHundred.push(assistantRow(`a${i}`, `r${i}`, i * 2 + 1));
    }
    const ocOk = { message: { list: pagedList(fiveHundred) } };
    const okHost = createPromptHost({ oc: ocOk, timeoutMs: 5000 });
    assert.equal((await okHost.readHistory({ sessionID: 's', ownerActor: 'a' })).length, 500);
    const fiveOhOne = [...fiveHundred, userRow('uExtra', 'extra?', 999999)];
    const ocOver = { message: { list: pagedList(fiveOhOne) } };
    const overHost = createPromptHost({ oc: ocOver, timeoutMs: 5000 });
    const err = await overHost.readHistory({ sessionID: 's', ownerActor: 'a' }).catch((e) => e);
    assert.equal(err.code, 'prompt.history_overflow', 'one row past the documented bound fails closed');
  });

  it('repeated cursor across pages fails closed (cursor loop, never silent truncate)', async () => {
    let calls = 0;
    const oc = {
      message: {
        list: async () => {
          calls++;
          return {
            data: [assistantRow('aLoop', 'x', 1)],
            cursor: { previous: null, next: 'loop-forever' },
          };
        },
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 2000 });
    const err = await host.readHistory({ sessionID: 's', ownerActor: 'a' }).catch((e) => e);
    assert.equal(err.code, 'prompt.history_overflow');
    assert.ok(calls <= 3, `cursor loop must fail fast, not after 10 pages (got ${calls} fetches)`);
  });

  it('duplicate message IDs across cursor pages fail closed (never silently duplicated)', async () => {
    let calls = 0;
    const oc = {
      message: {
        list: async ({ cursor } = {}) => {
          calls++;
          if (cursor === undefined) {
            return { data: [userRow('uDUP', 'q?', 1), assistantRow('a1', 'r1', 2)], cursor: { previous: null, next: 'p2' } };
          }
          // Second page repeats uDUP with a new cursor — overlap/corruption.
          return { data: [userRow('uDUP', 'q?', 1), assistantRow('a2', 'r2', 3)], cursor: { previous: null, next: null } };
        },
      },
    };
    const host = createPromptHost({ oc, timeoutMs: 2000 });
    const err = await host.readHistory({ sessionID: 's', ownerActor: 'a' }).catch((e) => e);
    assert.equal(err.code, 'prompt.history_overflow');
    assert.ok(calls >= 2);
  });
});
