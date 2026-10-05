/**
 * Issue #86 — ONE `DecisionProvider` instance per Durable Object.
 *
 * The per-turn budget and the breaker are STATE, so they only mean something if
 * they live in an instance that survives across turns. The Durable Object is the
 * scope: one provider per workspace, never a module singleton (that would leak a
 * workspace's budget into another) and never a per-call factory (that would
 * renew the budget every turn and forget an open circuit — the exact failure A16
 * was re-opened for).
 *
 * The `FinanceChatAgent` accessor is covered here too, because the accessor is
 * the seam production actually uses: `orchestratorForChannel()` wires it into
 * every channel.
 */
import { describe, expect, it, vi } from 'vitest';

import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { decisionProviderForDo, type DecisionEnv, type DecisionProvider } from '../src/decision/provider.js';

const enabledEnv: DecisionEnv = {
  TED_DECISION_PROVIDER: 'strands',
  TED_DECISION_STRANDS_URL: 'http://127.0.0.1:8000',
};

const fetchStub = () => vi.fn() as unknown as typeof fetch;

describe('issue #86 — one decision provider instance per Durable Object', () => {
  it('returns the SAME instance for the same scope', () => {
    const scope = {};
    const first = decisionProviderForDo(scope, { env: enabledEnv, fetchImpl: fetchStub() });
    const second = decisionProviderForDo(scope, { env: enabledEnv, fetchImpl: fetchStub() });
    expect(first).toBe(second);
  });

  it('gives each DO its OWN instance, so budgets never cross workspaces', () => {
    const deps = { env: enabledEnv, fetchImpl: fetchStub() };
    const first = decisionProviderForDo({}, deps);
    const second = decisionProviderForDo({}, deps);
    expect(first).not.toBe(second);
  });

  it('pins the env on the FIRST call, like any other Worker runtime config', () => {
    const scope = {};
    const first = decisionProviderForDo(scope, { env: enabledEnv, fetchImpl: fetchStub() });
    // A later call with a DIFFERENT env must not reconfigure the live instance.
    expect(decisionProviderForDo(scope, { env: {} })).toBe(first);
    expect(first.available).toBe(true);
  });
});

describe('issue #86 — the DO accessor (the seam production wires)', () => {
  const createTestAgent = (env: Record<string, unknown> = { API_ORIGIN: 'https://api.test.local' }) => {
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    Object.defineProperty(agent, 'state', { value: { storage: {} }, writable: true, configurable: true });
    Object.defineProperty(agent, 'env', { value: env, writable: true, configurable: true });
    return agent;
  };

  const providerOf = (agent: FinanceChatAgent): DecisionProvider =>
    (agent as unknown as { decisionProvider: () => DecisionProvider }).decisionProvider();

  it('exposes ONE provider, stable across turns, and unavailable by default', () => {
    const agent = createTestAgent();
    const first = providerOf(agent);
    const second = providerOf(agent);
    expect(first).toBe(second);
    // Default-off: no selector in the env ⇒ unavailable, and no call goes out.
    expect(first.available).toBe(false);
    expect(first.provider).toBe('none');
  });

  it('gives each DO its OWN instance', () => {
    expect(providerOf(createTestAgent())).not.toBe(providerOf(createTestAgent()));
  });

  it('reads the operator env once and respects it', () => {
    const agent = createTestAgent({ ...enabledEnv });
    expect(providerOf(agent).available).toBe(true);
  });
});
