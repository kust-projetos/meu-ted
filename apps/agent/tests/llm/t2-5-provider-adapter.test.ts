import { describe, expect, it } from 'vitest';
import {
  adaptProviderOutput,
  validateProviderOutput,
  type ProviderOutput,
} from '../../src/orchestration/provider-adapter.js';
import { executeLlmAttempts } from '../../src/llm/attempts.js';

const plan = {
  version: '2' as const, mode: 'read' as const, domain: 'accounts' as const,
  skillNames: ['financial-analysis'],
  requestedOperations: [{ name: 'get_balance', kind: 'read' as const }],
  missingFields: [], ambiguity: null, confidence: 1,
};

describe('T2.5 provider adapters', () => {
  it('native tool calling and text-only converge without granting capability', () => {
    const native: ProviderOutput = { toolCalls: [{ name: 'plan', arguments: JSON.stringify({ plan }) }] };
    const text: ProviderOutput = { text: JSON.stringify({ plan }) };
    expect(adaptProviderOutput(native)).toMatchObject({ plan: adaptProviderOutput(text).plan, response: adaptProviderOutput(text).response, policy: adaptProviderOutput(text).policy });
    expect(adaptProviderOutput(native).policy).toEqual({ capability: 'financial.read', writeAuthorized: false, approvalRequired: true, authorizationMode: 'none' });
  });

  it('rejects invalid schema and authority fields', () => {
    expect(() => adaptProviderOutput({ text: JSON.stringify({ plan: { ...plan, version: '1' } }) })).toThrow('agent.invalid_provider_output');
    expect(() => adaptProviderOutput({ text: JSON.stringify({ plan, mutationApproved: true }) })).toThrow('agent.invalid_provider_output');
    expect(() => validateProviderOutput({ plan, capability: 'financial.write' } as unknown as ProviderOutput)).toThrow('agent.invalid_provider_output');
    for (const field of ['authorizationMode', 'authorizationReason', 'risk', 'decision', 'autoExecute']) {
      expect(() => adaptProviderOutput({ text: JSON.stringify({ plan, [field]: 'auto' }) })).toThrow('agent.invalid_provider_output');
    }
    expect(adaptProviderOutput({ text: JSON.stringify({ plan, response: { text: 'ok', reason: 'ordinary response metadata' } }) }).response.text).toBe('ok');
  });

  it('never returns provider-supplied authority fields', () => {
    const output = adaptProviderOutput({ text: JSON.stringify({ plan }) });
    expect(output).not.toHaveProperty('mutationApproved');
    expect(output.policy).toEqual({ capability: 'financial.read', writeAuthorized: false, approvalRequired: true, authorizationMode: 'none' });
  });

  it('accepts OpenAI-compatible Broker completion output but never executes it', () => {
    const output = adaptProviderOutput({ broker: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ plan }) }, finish_reason: 'stop' }] } });
    expect(output.plan).toEqual(plan);
    expect(output.policy.writeAuthorized).toBe(false);
  });

  it('rejects empty, malformed, and multiple native outputs', () => {
    expect(() => adaptProviderOutput({ text: '' })).toThrow('agent.invalid_provider_output');
    expect(() => adaptProviderOutput({ text: '{' })).toThrow('agent.invalid_provider_output');
    expect(() => adaptProviderOutput({ toolCalls: [{ name: 'plan', arguments: JSON.stringify({ plan }) }, { name: 'plan', arguments: JSON.stringify({ plan }) }] })).toThrow('agent.invalid_provider_output');
  });

  it('classifies structural provider output errors as retryable for uniform fallback', async () => {
    const seen: string[] = [];
    const result = await executeLlmAttempts({
      snapshot: {
        provider_id: 'primary', model_id: 'primary:model', model_name: null,
        fallback_provider_id: 'fallback', fallback_model_id: 'fallback:model', fallback_model_name: null,
      },
      intentionId: 'intent-structural',
      runLeg: async (target) => {
        seen.push(target.providerId);
        if (target.providerId === 'primary') throw Object.assign(new Error('invalid'), { code: 'agent.invalid_provider_output' });
        return 'fallback';
      },
    });
    expect(seen).toEqual(['primary', 'fallback']);
    expect(result.usedFallback).toBe(true);
  });
});
