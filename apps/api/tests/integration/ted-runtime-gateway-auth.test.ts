/**
 * TED runtime gateway auth (TEST-ONLY, synthetic loopback, no inference).
 *
 * Proves the local TED gateway uses real Better-Auth session +
 * device/workspace agreement, and workspace/private visibility stays
 * enforced on gateway routes — without invoking any prompt/provider.
 *
 * - API: in-memory `buildTestApp` composition over loopback HTTP only.
 * - Auth: synthetic `memoryAdapter` users; session cookies + device tokens
 *   are synthetic and never logged (opaque here, asserted only by shape).
 * - Gateway: REAL `resolveGatewayIdentity` + REAL `createGatewayServer`;
 *   `promptHost.chat` throws if ever called (history path never prompts).
 * - No `/rpc/chat`, no model/provider, no financial writes, no migrations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createBetterAuth } from '../../src/auth/better-auth.js';
import { buildTestApp } from '../test-app.js';
import { resolveGatewayIdentity } from '../../../ted-runtime/src/gateway.mjs';
import { createGatewayServer } from '../../../ted-runtime/src/server.mjs';
import { createConversationStore } from '../../../ted-runtime/src/conversations.mjs';

const SYNTH_WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '33333333-3333-4333-8333-333333333333';
const SECRET = 'test-secret-that-is-at-least-32-characters';

type Memberships = Map<string, 'owner' | 'member'>;

const memberships: Memberships = new Map();
const workspaceAccess = {
  resolve: async (authUserId: string, householdId: string) => {
    if (householdId !== SYNTH_WS) return undefined;
    const role = memberships.get(authUserId);
    if (!role) return undefined;
    return { userId: authUserId, householdId, role, kind: 'shared' as const };
  },
};

const auth = createBetterAuth({
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  disableSignUp: false,
  transaction: false,
  secret: SECRET,
  baseURL: 'http://localhost:3001',
  trustedOrigins: ['http://localhost:3000'],
});

const built = buildTestApp({}, auth, workspaceAccess, false);
const apiApp = built.app;

let apiBase = '';
let cookieA = '';
let cookieB = '';
let userA = '';
let userB = '';
let deviceTokenA = '';
let deviceTokenB = '';
let deviceIdA = '';
let deviceIdB = '';

const firstCookieSegment = (setCookie: string | null): string => {
  const raw = String(setCookie ?? '');
  const first = raw.split(',').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  return first.split(';')[0]?.trim() ?? '';
};

const registerDevice = async (cookie: string, name: string): Promise<{ token: string; deviceId: string; householdId: string }> => {
  const res = await fetch(`${apiBase}/auth/devices/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-workspace-id': SYNTH_WS,
    },
    body: JSON.stringify({ deviceName: name }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; deviceId: string; householdId: string };
  expect(typeof body.token).toBe('string');
  expect(typeof body.deviceId).toBe('string');
  expect(body.householdId).toBe(SYNTH_WS);
  return body;
};

beforeAll(async () => {
  await apiApp.listen({ port: 0, host: '127.0.0.1' });
  const addr = apiApp.server.address() as { port: number };
  apiBase = `http://127.0.0.1:${addr.port}`;

  const signUpA = await auth.api.signUpEmail({
    body: { email: 'ted-a@example.test', password: 'test-password-123', name: 'Ted A' },
    headers: new Headers({ origin: 'http://localhost:3000' }),
    asResponse: true,
  });
  expect(signUpA.status).toBe(200);
  cookieA = firstCookieSegment(signUpA.headers.get('set-cookie'));
  expect(cookieA.length).toBeGreaterThan(0);

  const signUpB = await auth.api.signUpEmail({
    body: { email: 'ted-b@example.test', password: 'test-password-123', name: 'Ted B' },
    headers: new Headers({ origin: 'http://localhost:3000' }),
    asResponse: true,
  });
  expect(signUpB.status).toBe(200);
  cookieB = firstCookieSegment(signUpB.headers.get('set-cookie'));
  expect(cookieB.length).toBeGreaterThan(0);

  const sessionA = await auth.api.getSession({ headers: new Headers({ cookie: cookieA }) });
  const sessionB = await auth.api.getSession({ headers: new Headers({ cookie: cookieB }) });
  userA = String(sessionA?.user.id ?? '');
  userB = String(sessionB?.user.id ?? '');
  expect(userA.length).toBeGreaterThan(0);
  expect(userB.length).toBeGreaterThan(0);
  expect(userB).not.toBe(userA);

  memberships.set(userA, 'owner');
  memberships.set(userB, 'member');

  const regA = await registerDevice(cookieA, 'synth device a');
  const regB = await registerDevice(cookieB, 'synth device b');
  deviceTokenA = regA.token;
  deviceIdA = regA.deviceId;
  deviceTokenB = regB.token;
  deviceIdB = regB.deviceId;
  expect(deviceIdB).not.toBe(deviceIdA);
}, 30000);

afterAll(async () => {
  await apiApp.close().catch(() => {});
  await auth.close().catch(() => {});
});

describe('ted-runtime gateway auth over real Better-Auth session (synthetic loopback)', () => {
  it('resolves canonical workspace/actor/device from API outputs, rejects mismatch closed', async () => {
    const idA = await resolveGatewayIdentity({
      apiBaseUrl: apiBase,
      cookie: cookieA,
      deviceToken: deviceTokenA,
      workspaceId: SYNTH_WS,
    });
    expect(idA.workspace).toBe(SYNTH_WS);
    expect(idA.actorId).toBe(userA);
    expect(idA.deviceId).toBe(deviceIdA);
    expect(idA.deviceHousehold).toBe(SYNTH_WS);

    const idB = await resolveGatewayIdentity({
      apiBaseUrl: apiBase,
      cookie: cookieB,
      deviceToken: deviceTokenB,
      workspaceId: SYNTH_WS,
    });
    expect(idB.workspace).toBe(SYNTH_WS);
    expect(idB.actorId).toBe(userB);
    expect(idB.deviceId).toBe(deviceIdB);

    // Cross-workspace hint must fail closed (never empty data).
    const crossErr = await resolveGatewayIdentity({
      apiBaseUrl: apiBase,
      cookie: cookieA,
      deviceToken: deviceTokenA,
      workspaceId: OTHER_WS,
    }).then(
      () => null,
      (e) => e as { code?: string; statusCode?: number },
    );
    expect(crossErr).not.toBeNull();
    expect(['auth.workspace_forbidden', 'auth.session_required', 'gateway.upstream_error']).toContain(crossErr?.code);

    // Bogus device must fail closed as unauthorized (never empty data).
    const bogusErr = await resolveGatewayIdentity({
      apiBaseUrl: apiBase,
      cookie: cookieA,
      deviceToken: 'bogus-device-token',
      workspaceId: SYNTH_WS,
    }).then(
      () => null,
      (e) => e as { code?: string; statusCode?: number },
    );
    expect(bogusErr).not.toBeNull();
    expect(['auth.device_required', 'auth.session_required', 'gateway.upstream_error']).toContain(bogusErr?.code);
  });

  it('history bootstraps one workspace-visible pin, survives restart, enforces visibility + revoke', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ted-gw-auth-'));
    const events: string[] = [];
    let chatCalls = 0;
    let createCalls = 0;
    let bindCalls = 0;
    let readCalls = 0;

    // Seeded native rows for the viewer-relative isOwn check (ids only,
    // no prompt text asserted beyond the canned content marker).
    let nativeRows: Array<Record<string, unknown>> = [];

    const store = createConversationStore({ persistDir });
    const promptHost = {
      chat: async () => {
        chatCalls += 1;
        throw Object.assign(new Error('prompt must not be called on history path'), { code: 'prompt.forbidden_in_test' });
      },
      readHistory: async ({ ownerActor, userMeta, viewerActor }: { ownerActor: string; userMeta: Record<string, { intentionId?: string; actorId?: string }>; viewerActor: string }) => {
        readCalls += 1;
        events.push('read');
        const items: Array<Record<string, unknown>> = [];
        for (const row of nativeRows) {
          if (row['type'] === 'user') {
            const meta = (userMeta as Record<string, { intentionId?: string; actorId?: string }>)[String(row['id'])] ?? {};
            const author = meta.actorId ?? ownerActor;
            items.push({
              id: String(row['id']),
              actorId: author,
              role: 'user',
              content: String(row['text'] ?? ''),
              isOwn: author === viewerActor,
              ...(meta.intentionId ? { intentionId: meta.intentionId } : {}),
            });
          } else if (row['type'] === 'assistant') {
            items.push({
              id: String(row['id']),
              actorId: 'ted',
              role: 'assistant',
              content: String(row['text'] ?? ''),
              isOwn: false,
            });
          }
        }
        return items;
      },
    };
    const createRuntimeSession = async () => {
      createCalls += 1;
      events.push('create');
      return { runtimeSessionId: `rt-${createCalls}-${Date.now()}` };
    };
    const withAuthenticatedSession = async (_sessionID: string, _host: unknown, fn: () => Promise<unknown>) => {
      bindCalls += 1;
      events.push('bind');
      return await fn();
    };
    const resolveIdentity = async ({ cookie, deviceToken, workspaceId, signal }: { cookie: string; deviceToken: string; workspaceId: string; signal?: AbortSignal }) => {
      events.push('identity');
      return resolveGatewayIdentity({ apiBaseUrl: apiBase, cookie, deviceToken, workspaceId, signal });
    };

    const gw1 = createGatewayServer({ resolveIdentity, store, promptHost, createRuntimeSession, withAuthenticatedSession });
    const addr1 = await gw1.listen({ port: 0, host: '127.0.0.1' });
    const gwBase1 = `http://127.0.0.1:${addr1.port}`;
    const historyPath = `/agents/finance-chat-agent/${encodeURIComponent(SYNTH_WS)}/rpc/history`;

    try {
      // Bootstrap: no B pin — one workspace-visible conversation + opaque cookie, no prompt.
      const boot = await fetch(`${gwBase1}${historyPath}`, {
        method: 'GET',
        headers: { cookie: cookieA, 'x-device-token': deviceTokenA },
      });
      expect(boot.status).toBe(200);
      expect(chatCalls).toBe(0);
      expect(createCalls).toBe(1);
      // Bootstrap performs no native use: the safe wrapper binds per native
      // use and revokes on exit, so no wrapper call here (no bind, no read).
      expect(bindCalls).toBe(0);
      const bootBody = (await boot.json()) as { items: unknown[] };
      expect(Array.isArray(bootBody.items)).toBe(true);
      expect(bootBody.items).toHaveLength(0);
      const bootSetCookie = boot.headers.get('set-cookie') ?? '';
      const bootMatch = /ted-runtime-conversation=opencode\.([0-9a-f-]{36})/i.exec(bootSetCookie);
      expect(bootMatch?.[1]).toMatch(/^[0-9a-f-]{36}$/i);
      const convId = String(bootMatch?.[1]);
      const pinCookie = `ted-runtime-conversation=opencode.${convId}`;
      const cookieAWithPin = `${cookieA}; ${pinCookie}`;
      const cookieBWithPin = `${cookieB}; ${pinCookie}`;

      // Restart only the gateway/store interface (API production untouched):
      // same pin must still resolve after reload, binding after identity.
      await gw1.close();
      events.length = 0;
      const readsBeforeRestart = readCalls;
      const bindsBeforeRestart = bindCalls;
      const store2 = createConversationStore({ persistDir });
      const gw2 = createGatewayServer({ resolveIdentity, store: store2, promptHost, createRuntimeSession, withAuthenticatedSession });
      const addr2 = await gw2.listen({ port: 0, host: '127.0.0.1' });
      const gwBase2 = `http://127.0.0.1:${addr2.port}`;
      try {
        const again = await fetch(`${gwBase2}${historyPath}`, {
          method: 'GET',
          headers: { cookie: cookieAWithPin, 'x-device-token': deviceTokenA },
        });
        expect(again.status).toBe(200);
        expect(chatCalls).toBe(0);
        expect(bindCalls).toBe(bindsBeforeRestart + 1);
        expect(readCalls).toBe(readsBeforeRestart + 1);
        expect(events[0]).toBe('identity');
        expect(events).toContain('bind');
        expect(events).toContain('read');
        expect(events.indexOf('identity')).toBeLessThan(events.indexOf('bind'));

        // Seed native history metadata: one A-authored turn.
        store2.claimIntention(convId, 'int-seed-1');
        store2.settleIntention(convId, 'int-seed-1', {
          status: 'completed',
          userMessageId: 'u-seed-1',
          actorId: userA,
          turnId: 't-seed-1',
        });
        nativeRows = [
          { id: 'u-seed-1', type: 'user', text: 'seeded history marker' },
          { id: 't-seed-1', type: 'assistant', text: 'seeded reply marker' },
        ];

        // Member B reads the same workspace-visible pin: viewer-relative isOwn.
        const bindsBeforeB = bindCalls;
        const readsBeforeB = readCalls;
        const asB = await fetch(`${gwBase2}${historyPath}`, {
          method: 'GET',
          headers: { cookie: cookieBWithPin, 'x-device-token': deviceTokenB },
        });
        expect(asB.status).toBe(200);
        expect(chatCalls).toBe(0);
        expect(bindCalls).toBe(bindsBeforeB + 1);
        expect(readCalls).toBe(readsBeforeB + 1);
        const bBody = (await asB.json()) as { items: Array<{ id: string; actorId: string; role: string; isOwn: boolean }> };
        expect(bBody.items).toHaveLength(2);
        const bUser = bBody.items.find((i) => i.role === 'user');
        expect(bUser?.actorId).toBe(userA);
        expect(bUser?.isOwn).toBe(false);

        // Same pin as A: author sees own message.
        const asA = await fetch(`${gwBase2}${historyPath}`, {
          method: 'GET',
          headers: { cookie: cookieAWithPin, 'x-device-token': deviceTokenA },
        });
        expect(asA.status).toBe(200);
        const aBody = (await asA.json()) as { items: Array<{ role: string; isOwn: boolean }> };
        expect(aBody.items.find((i) => i.role === 'user')?.isOwn).toBe(true);

        // A-private pin: B receives 404 before any native read/bind.
        const priv = store2.create({ workspace: SYNTH_WS, ownerActor: userA, deviceId: deviceIdA, visibility: 'private' });
        store2.attachRuntime(priv.conversationId, 'rt-private-seed', userA);
        const privPin = `ted-runtime-conversation=opencode.${priv.conversationId}`;
        const bindsBeforePriv = bindCalls;
        const readsBeforePriv = readCalls;
        const privAttempt = await fetch(`${gwBase2}${historyPath}`, {
          method: 'GET',
          headers: { cookie: `${cookieB}; ${privPin}`, 'x-device-token': deviceTokenB },
        });
        expect(privAttempt.status).toBe(404);
        expect(bindCalls).toBe(bindsBeforePriv);
        expect(readCalls).toBe(readsBeforePriv);
        expect(chatCalls).toBe(0);

        // Revoke B membership: same workspace-visible pin now 403 before native read.
        memberships.delete(userB);
        const bindsBeforeRevoke = bindCalls;
        const readsBeforeRevoke = readCalls;
        const revoked = await fetch(`${gwBase2}${historyPath}`, {
          method: 'GET',
          headers: { cookie: cookieBWithPin, 'x-device-token': deviceTokenB },
        });
        expect(revoked.status).toBe(403);
        expect(bindCalls).toBe(bindsBeforeRevoke);
        expect(readCalls).toBe(readsBeforeRevoke);
        expect(chatCalls).toBe(0);
        memberships.set(userB, 'member');
      } finally {
        await gw2.close().catch(() => {});
      }
    } finally {
      try {
        await gw1.close().catch(() => {});
      } catch {
        // Already closed after restart path.
      }
      fs.rmSync(persistDir, { recursive: true, force: true });
    }
  });
});
