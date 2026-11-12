import { describe, expect, it, vi } from 'vitest';
import { bindingFromUpgradeHeaders, deliverFrameJson, type ConnectionBinding } from '../src/privacy/live-delivery.js';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';

const headers = (actor = 'A', workspace = 'ws', role = 'member', device?: string) => {
  const h = new Headers({ 'x-agent-actor': actor, 'x-agent-workspace': workspace, 'x-agent-role': role });
  if (device) h.set('x-agent-device', device);
  return h;
};
const binding = (actorId: string, workspaceId = 'ws'): ConnectionBinding => ({ actorId, workspaceId, role: 'member', validatedAt: 123 });
const connection = (id: string, state: ConnectionBinding | null) => {
  const received: string[] = [];
  return { value: { id, state, send: (data: string) => { received.push(data); }, close: () => {}, setState: () => null }, received };
};

describe('live delivery filtering', () => {
  it('binds required upgrade headers and permits optional device id', () => {
    expect(bindingFromUpgradeHeaders(headers('A', 'ws', 'member', 'dev'), 44)).toEqual({ actorId: 'A', workspaceId: 'ws', role: 'member', deviceId: 'dev', validatedAt: 44 });
    for (const key of ['x-agent-actor', 'x-agent-workspace', 'x-agent-role']) {
      const h = headers(); h.delete(key);
      expect(bindingFromUpgradeHeaders(h)).toBeNull();
    }
    expect(bindingFromUpgradeHeaders(headers(' ', 'ws', 'member'))).toBeNull();
    expect(bindingFromUpgradeHeaders(headers())).toEqual({ actorId: 'A', workspaceId: 'ws', role: 'member', validatedAt: expect.any(Number) });
  });

  it('filters collective, private, mixed, unclassified, legacy and excluded frames', () => {
    const a = connection('a', binding('A'));
    const b = connection('b', binding('B'));
    const c = connection('c', binding('C', 'other'));
    const noState = connection('none', null);
    const all = [a.value, b.value, c.value, noState.value];
    const collective = JSON.stringify({ type: 'chat', messages: [{ metadata: { workspaceId: 'ws', visibility: 'workspace' } }] });
    expect(deliverFrameJson(all, collective)).toEqual({ delivered: 2, dropped: 2 });
    expect(a.received).toHaveLength(1); expect(b.received).toHaveLength(1);
    const privateFrame = JSON.stringify({ type: 'chat', messages: [{ metadata: { workspaceId: 'ws', visibility: 'private', ownerActorId: 'A' } }] });
    expect(deliverFrameJson(all, privateFrame)).toEqual({ delivered: 1, dropped: 3 });
    const mixed = JSON.stringify({ type: 'chat', messages: [
      { id: 'collective', metadata: { workspaceId: 'ws', visibility: 'workspace' } },
      { id: 'private', metadata: { workspaceId: 'ws', visibility: 'private', ownerActorId: 'A' } },
    ] });
    deliverFrameJson([a.value, b.value], mixed);
    expect(JSON.parse(a.received.at(-1)!).messages).toHaveLength(2);
    expect(JSON.parse(b.received.at(-1)!).messages).toHaveLength(1);
    expect(deliverFrameJson(all, JSON.stringify({ type: 'CF_AGENT_USE_CHAT_RESPONSE' }))).toEqual({ delivered: 0, dropped: 4 });
    expect(deliverFrameJson([a.value, b.value], JSON.stringify({ messages: [{ metadata: {} }] }))).toEqual({ delivered: 0, dropped: 2 });
    expect(deliverFrameJson([a.value, b.value], JSON.stringify({ messages: [{ metadata: { workspaceId: 'other', visibility: 'workspace' } }] }))).toEqual({ delivered: 0, dropped: 2 });
    expect(deliverFrameJson([a.value, b.value], JSON.stringify({ messages: [{ metadata: { workspaceId: 'ws', visibility: 'private' } }] }))).toEqual({ delivered: 0, dropped: 2 });
    const before = a.received.length;
    expect(deliverFrameJson([a.value, b.value], collective, ['a'])).toEqual({ delivered: 1, dropped: 0 });
    expect(a.received).toHaveLength(before);
    const privateBefore = b.received.length;
    expect(deliverFrameJson([a.value, b.value], privateFrame, ['a'])).toEqual({ delivered: 0, dropped: 1 });
    expect(b.received).toHaveLength(privateBefore);
    const secretFrame = JSON.stringify({ type: 'chat', secret: 'x', messages: [{ metadata: { workspaceId: 'ws', visibility: 'workspace' } }] });
    expect(deliverFrameJson([a.value], secretFrame)).toEqual({ delivered: 1, dropped: 0 });
    expect(JSON.parse(a.received.at(-1)!)).toEqual({ type: 'chat', messages: [{ metadata: { workspaceId: 'ws', visibility: 'workspace' } }] });
    expect(deliverFrameJson(all, '{bad json')).toEqual({ delivered: 0, dropped: 4 });
  });

  it('wires actor binding and broadcast to the filtering module', async () => {
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'name', { value: 'ws', configurable: true });
    const a = connection('a', null);
    Object.defineProperty(agent, 'getConnections', { value: () => [a.value] });
    agent.broadcast(JSON.stringify({ messages: [{ metadata: { workspaceId: 'ws', visibility: 'workspace' } }] }));
    expect(a.received).toHaveLength(0);
    agent.broadcast(new ArrayBuffer(4));
    expect(a.received).toHaveLength(0);
    let updater: ((prev: (ConnectionBinding & { internal?: boolean }) | null) => ConnectionBinding & { internal?: boolean }) | undefined;
    const setState = vi.fn((update: ConnectionBinding | ((prev: (ConnectionBinding & { internal?: boolean }) | null) => ConnectionBinding & { internal?: boolean }) | null) => { updater = typeof update === 'function' ? update : undefined; return null; });
    const close = vi.fn();
    await agent.onConnect({ setState, close }, { request: new Request('https://example.test', { headers: headers() }) });
    expect(typeof updater).toBe('function');
    expect(updater!({ internal: true, actorId: 'old', workspaceId: 'old', role: 'old', validatedAt: 0 })).toMatchObject({ actorId: 'A', workspaceId: 'ws', internal: true });
    const count = setState.mock.calls.length;
    Object.defineProperty(agent, 'name', { value: 'another-ws', configurable: true });
    await agent.onConnect({ setState, close }, { request: new Request('https://example.test', { headers: headers() }) });
    expect(close).toHaveBeenCalledWith(1008, 'workspace_binding_mismatch');
    expect(setState).toHaveBeenCalledTimes(count);
    await agent.onConnect({ setState, close }, { request: new Request('https://example.test') });
    expect(close).toHaveBeenCalledWith(1008, 'actor_binding_required');
    expect(setState).toHaveBeenCalledTimes(count);
  });
});
