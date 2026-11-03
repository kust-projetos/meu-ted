// P1 conversation registry tests (doubles only — no SDK, no API).
// Proves: A/B workspace isolation, private vs collective visibility,
// opaque-cookie contract (agent sentinel, opencode.<uuid>, scoped clear),
// persistence + rebind across store reloads, and turn serialization.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATION_COOKIE,
  canAccessConversation,
  clearConversationCookie,
  createConversationStore,
  parseConversationCookie,
  scopedCookiePath,
  serializeConversationCookie,
} from '../src/conversations.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const idA = { actorId: 'actor-A', workspace: 'H_A', deviceId: 'dev-A' };
const idB = { actorId: 'actor-B', workspace: 'H_B', deviceId: 'dev-B' };
const idA2 = { actorId: 'actor-A2', workspace: 'H_A', deviceId: 'dev-A2' };

describe('conversation cookie contract (proxy pin)', () => {
  it("exact sentinel 'agent' is A0; opencode.<uuid> is B; raw ids never surface", () => {
    assert.deepEqual(parseConversationCookie(`${CONVERSATION_COOKIE}=agent`), { pin: 'a0' });
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    assert.deepEqual(
      parseConversationCookie(`${CONVERSATION_COOKIE}=opencode.${uuid}; other=1`),
      { pin: 'b', conversationId: uuid },
    );
    assert.deepEqual(parseConversationCookie(''), { pin: 'none' });
    assert.deepEqual(parseConversationCookie('other=1'), { pin: 'none' });
    // Native runtime session ids must never parse as B pins.
    const bad = parseConversationCookie(`${CONVERSATION_COOKIE}=opencode.ses_abc123`);
    assert.equal(bad.pin, 'invalid');
    assert.ok(!('conversationId' in bad) && !JSON.stringify(bad).includes('ses_abc123'), 'value never echoed');
    const rawSession = parseConversationCookie(`${CONVERSATION_COOKIE}=ses_raw_native_id`);
    assert.equal(rawSession.pin, 'invalid');
  });

  it('B cookie is scoped per workspace path, HttpOnly + Lax, 30d; Secure only on https', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const plain = serializeConversationCookie('H_A', uuid, { secure: false });
    assert.ok(plain.includes(`${CONVERSATION_COOKIE}=opencode.${uuid}`));
    assert.ok(plain.includes(`Path=${scopedCookiePath('H_A')}`));
    assert.ok(plain.includes('HttpOnly') && plain.includes('SameSite=Lax') && plain.includes('Max-Age=2592000'));
    assert.ok(!plain.includes('Secure'));
    assert.ok(scopedCookiePath('H_A').startsWith('/api/agent/agents/finance-chat-agent/'));
    const secure = serializeConversationCookie('H_A', uuid, { secure: true });
    assert.ok(secure.includes('Secure'));
    // Clearing expires exactly the scoped cookie (same Path).
    const cleared = clearConversationCookie('H_A');
    assert.ok(cleared.includes('Max-Age=0') && cleared.includes(`Path=${scopedCookiePath('H_A')}`));
    assert.ok(!cleared.includes('opencode.'));
  });
});

describe('conversation visibility + isolation', () => {
  it('workspace default: same-workspace member reads, other workspace refused', () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-conv-vis') });
    const rec = store.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    assert.equal(rec.visibility, 'workspace');
    assert.ok(canAccessConversation(rec, idA));
    assert.ok(canAccessConversation(rec, idA2), 'collective default: second member of H_A');
    assert.ok(!canAccessConversation(rec, idB), 'H_B never sees H_A rows');
    assert.throws(() => store.get(rec.conversationId, idB), /another workspace|forbidden/);
  });

  it('private: owner only — second member gets not_found (no oracle)', () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-conv-priv') });
    const rec = store.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A', visibility: 'private' });
    assert.ok(canAccessConversation(rec, idA));
    assert.ok(!canAccessConversation(rec, idA2));
    assert.throws(() => store.get(rec.conversationId, idA2), /not found/);
    assert.throws(() => store.get(rec.conversationId, idB), /another workspace|forbidden/);
  });

  it('metadata persists across reloads; runtime rebind is explicit, never from the cookie', () => {
    const dir = approvedTmpRoot('ted-conv-persist');
    const s1 = createConversationStore({ persistDir: dir });
    const rec = s1.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    assert.equal(rec.runtimeSessionId, null, 'no native session at creation');
    // Simulate restart: a FRESH store over the same dir recovers metadata…
    const s2 = createConversationStore({ persistDir: dir });
    const reloaded = s2.get(rec.conversationId, idA);
    assert.equal(reloaded.workspace, 'H_A');
    assert.equal(reloaded.runtimeSessionId, null, '…but the native binding is gone until explicit rebind');
    // …and the rebind is a server-side attach, not a cookie claim.
    const bound = s2.attachRuntime(rec.conversationId, 'ses_native_1', 'actor-A');
    assert.equal(bound.runtimeSessionId, 'ses_native_1');
    assert.throws(
      () => s2.attachRuntime(rec.conversationId, 'ses_native_EVE', 'actor-EVE'),
      /already attached|conflict/,
      'takeover refused',
    );
  });

  it('intention registry: claim/get/settle persist across reloads (id+status only, never text)', async () => {
    const dir = approvedTmpRoot('ted-conv-intent');
    const s1 = createConversationStore({ persistDir: dir });
    const rec = s1.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    assert.equal(s1.getIntention(rec.conversationId, 'm-1'), null);
    const claimed = s1.claimIntention(rec.conversationId, 'm-1');
    assert.equal(claimed.status, 'pending');
    assert.throws(() => s1.claimIntention(rec.conversationId, 'm-1'), /intention_duplicate|already claimed/);
    // Reload in a FRESH store (process restart): the claim survives.
    const s2 = createConversationStore({ persistDir: dir });
    const reloaded = s2.getIntention(rec.conversationId, 'm-1');
    assert.equal(reloaded.status, 'pending');
    assert.ok(!('text' in reloaded) && !('output' in reloaded) && !('token' in reloaded), 'no text/output/token in persisted metadata');
    const settled = s2.settleIntention(rec.conversationId, 'm-1', { status: 'completed', userMessageId: 'u-1', turnId: 'a-1' });
    assert.equal(settled.status, 'completed');
    assert.equal(settled.turnId, 'a-1');
    // Third process sees the completed claim: retry must NOT issue a second prompt.
    const s3 = createConversationStore({ persistDir: dir });
    assert.equal(s3.getIntention(rec.conversationId, 'm-1').status, 'completed');
    assert.throws(() => s3.claimIntention(rec.conversationId, 'm-1'), /intention_duplicate|already claimed/);
    assert.throws(() => s3.settleIntention(rec.conversationId, 'nope', { status: 'completed' }), /intention_not_found|never claimed/);
  });

  it('intention metadata carries the author actor id (ids only; text rejected)', async () => {
    const dir = approvedTmpRoot('ted-conv-intent-actor');
    const s1 = createConversationStore({ persistDir: dir });
    const rec = s1.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    s1.claimIntention(rec.conversationId, 'm-a');
    const settled = s1.settleIntention(rec.conversationId, 'm-a', { status: 'completed', userMessageId: 'u-a', turnId: 'a-a', actorId: 'actor-A' });
    assert.equal(settled.actorId, 'actor-A');
    assert.throws(() => s1.settleIntention(rec.conversationId, 'm-a', { text: 'oi' }), /not metadata|invalid/);
    assert.throws(() => s1.settleIntention(rec.conversationId, 'm-a', { output: 'x' }), /not metadata|invalid/);
    const s2 = createConversationStore({ persistDir: dir });
    const reloaded = s2.getIntention(rec.conversationId, 'm-a');
    assert.equal(reloaded.actorId, 'actor-A', 'author actor survives reloads');
    assert.ok(!('text' in reloaded) && !('output' in reloaded) && !('token' in reloaded), 'no text/output/token in persisted metadata');
  });

  it('same-conversation turns serialize (binding cannot race)', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-conv-lock') });
    const rec = store.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    const order = [];
    const slow = (name, ms) => store.withTurnLock(rec.conversationId, async () => {
      order.push(`${name}:enter`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:exit`);
      return name;
    });
    const [r1, r2] = await Promise.all([slow('turn-1', 60), slow('turn-2', 10)]);
    assert.deepEqual([r1, r2], ['turn-1', 'turn-2']);
    assert.deepEqual(order, ['turn-1:enter', 'turn-1:exit', 'turn-2:enter', 'turn-2:exit']);
  });

  it('turn lock entries release after success AND failure (no leak, queue never wedges)', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-conv-lockleak') });
    const rec = store.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    assert.equal(store.lockCount(), 0);
    await store.withTurnLock(rec.conversationId, async () => 'ok-1');
    assert.equal(store.lockCount(), 0, 'success releases the lock entry');
    await store.withTurnLock(rec.conversationId, async () => { throw Object.assign(new Error('boom'), { code: 'prompt.failed' }); }).catch((e) => e);
    assert.equal(store.lockCount(), 0, 'failure releases the lock entry');
    // Queue still drains after a failure: next turn runs.
    const after = await store.withTurnLock(rec.conversationId, async () => 'ok-after-failure');
    assert.equal(after, 'ok-after-failure');
    assert.equal(store.lockCount(), 0);
  });

  it('lost-cookie retry index is first-writer-wins (ids only, survives reload)', async () => {
    const dir = approvedTmpRoot('ted-conv-retryidx');
    const s1 = createConversationStore({ persistDir: dir });
    const rec = s1.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    assert.equal(s1.findConversationForRetry({ workspace: 'H_A', ownerActor: 'actor-A', intentionId: 'm-lost' }), null);
    const first = s1.recordIntentionOwner({ workspace: 'H_A', ownerActor: 'actor-A', intentionId: 'm-lost', conversationId: rec.conversationId });
    assert.equal(first.created, true);
    assert.equal(first.conversationId, rec.conversationId);
    const s2 = createConversationStore({ persistDir: dir });
    assert.equal(s2.findConversationForRetry({ workspace: 'H_A', ownerActor: 'actor-A', intentionId: 'm-lost' }), rec.conversationId);
    // Second writer never overwrites: first conversation wins.
    const rec2 = s2.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    const second = s2.recordIntentionOwner({ workspace: 'H_A', ownerActor: 'actor-A', intentionId: 'm-lost', conversationId: rec2.conversationId });
    assert.equal(second.created, false);
    assert.equal(second.conversationId, rec.conversationId, 'first writer wins');
    // Different actor/intention do not collide.
    assert.equal(s2.findConversationForRetry({ workspace: 'H_A', ownerActor: 'actor-B', intentionId: 'm-lost' }), null);
    assert.equal(s2.findConversationForRetry({ workspace: 'H_A', ownerActor: 'actor-A', intentionId: 'other' }), null);
  });

  it('corrupt store fails closed (never silently reset)', async () => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = approvedTmpRoot('ted-conv-corrupt');
    writeFileSync(join(dir, 'conversations.json'), '{not-json', 'utf8');
    const store = createConversationStore({ persistDir: dir });
    assert.throws(() => store.create({ workspace: 'H_A', ownerActor: 'a', deviceId: 'd' }), /corrupt/);
  });

  it('tampered intention index (record workspace/owner disagrees with key) fails closed on load', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = approvedTmpRoot('ted-conv-tamper');
    const s1 = createConversationStore({ persistDir: dir });
    const recA = s1.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    s1.recordIntentionOwner({ workspace: 'H_A', ownerActor: 'actor-A', intentionId: 'm-tamper', conversationId: recA.conversationId });
    // Tamper the persisted index: re-point the key at a DIFFERENT workspace record.
    const recB = s1.create({ workspace: 'H_B', ownerActor: 'actor-B', deviceId: 'dev-B' });
    const raw = JSON.parse(readFileSync(join(dir, 'conversations.json'), 'utf8'));
    const tamperedKey = JSON.stringify(['H_A', 'actor-A', 'm-tamper']);
    raw.intentionIndex = { [tamperedKey]: recB.conversationId };
    writeFileSync(join(dir, 'conversations.json'), JSON.stringify(raw), 'utf8');
    const s2 = createConversationStore({ persistDir: dir });
    assert.throws(() => s2.create({ workspace: 'H_A', ownerActor: 'a', deviceId: 'd' }), /corrupt|mismatch|disagrees|unknown/i);
  });

  it('mismatched recordIntentionOwner (key workspace/owner vs record) fails closed with no routing', async () => {
    const store = createConversationStore({ persistDir: approvedTmpRoot('ted-conv-ownermismatch') });
    const rec = store.create({ workspace: 'H_A', ownerActor: 'actor-A', deviceId: 'dev-A' });
    assert.throws(
      () => store.recordIntentionOwner({ workspace: 'H_B', ownerActor: 'actor-A', intentionId: 'm-x', conversationId: rec.conversationId }),
      /mismatch|workspace|forbidden|invalid/i,
    );
    assert.throws(
      () => store.recordIntentionOwner({ workspace: 'H_A', ownerActor: 'actor-EVE', intentionId: 'm-y', conversationId: rec.conversationId }),
      /mismatch|owner|forbidden|invalid/i,
    );
    assert.equal(store.findConversationForRetry({ workspace: 'H_B', ownerActor: 'actor-A', intentionId: 'm-x' }), null);
    assert.equal(store.findConversationForRetry({ workspace: 'H_A', ownerActor: 'actor-EVE', intentionId: 'm-y' }), null);
  });
});
