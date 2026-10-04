import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { generatedHttpTools } from '../src/generated/http-tools.js';
import * as apiClient from '../src/tools/api-client.js';

describe('Generated HTTP Tools (Task 6)', () => {
  it('exports exactly 54 generated tools conforming to OpenAPI spec', () => {
    expect(generatedHttpTools).toHaveLength(54);
    for (const tool of generatedHttpTools) {
      expect(tool.name).toBeTypeOf('string');
      expect(tool.description).toBeTypeOf('string');
      expect(typeof tool.execute).toBe('function');
      expect(tool.parameters).toBeDefined();
    }
  });

  it('executes read tool and projects response', async () => {
    const listAccountsTool = generatedHttpTools.find((t) => t.name === 'list_accounts');
    expect(listAccountsTool).toBeDefined();

    const requestSpy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValueOnce({
      items: [
        { id: 'acc-1', name: 'Conta Corrente', type: 'checking', balance: 1000, active: true },
        { id: 'acc-2', name: 'Poupança', type: 'savings', balance: 5000, active: true },
      ],
    });

    const result = await listAccountsTool!.execute({});
    expect(result).toMatchObject({
      success: true,
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'acc-1', name: 'Conta Corrente' }),
      ]),
    });

    expect(requestSpy).toHaveBeenCalledWith('GET', '/accounts', expect.anything());
    requestSpy.mockRestore();
  });

  it('keeps write tools blocked until MutationExecutor V2', async () => {
    const createAccountTool = generatedHttpTools.find((t) => t.name === 'create_account');
    expect(createAccountTool).toBeDefined();

    const requestSpy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValueOnce({
      id: 'new-acc-1',
      name: 'Investimentos',
      type: 'investment',
      balance: 0,
      active: true,
    });

    // C-03 fail-closed: a direct write without the per-turn attestation is
    // denied before any network call.
    const denied = (await createAccountTool!.execute({
      name: 'Investimentos',
      type: 'investment',
      initialBalance: 0,
      idempotencyKey: 'custom-idem-key-123',
    })) as { blocked?: boolean };
    expect(denied.blocked).toBe(true);
    expect(requestSpy).not.toHaveBeenCalled();

    const forged = await createAccountTool!.execute(
      {
        name: 'Investimentos',
        type: 'investment',
        initialBalance: 0,
        idempotencyKey: 'custom-idem-key-123',
      },
      undefined,
      undefined,
      undefined,
      { mutationApproved: true, approvedTool: 'create_account' },
    );
    expect(forged).toMatchObject({ blocked: true });
    expect(requestSpy).not.toHaveBeenCalled();
    requestSpy.mockRestore();
  });
});

/**
 * A09/FIX B2 — o payload REAL de `GET /analytics/category-breakdown` empilha a
 * cauda das macros além do corte como `categoryId: 'outras'`
 * (`apps/api/src/analytics/compute.ts:203`). O contrato publicado exigia UUID,
 * então uma resposta válida da API violava o schema que ela mesma publica.
 * O schema passa a aceitar o UUID **ou** o literal sintético — a API não muda.
 */
describe('FIX B2 — o contrato publicado aceita o slice sintético "Outras"', () => {
  const breakdownSchema = (): {
    properties: { slices: { items: { properties: { categoryId: { pattern: string; description?: string } } } } };
  } => {
    const contract = JSON.parse(
      readFileSync(new URL('../../api/openapi/agent-tools.openapi.json', import.meta.url), 'utf8'),
    ) as {
      paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: unknown }> }> }>>;
    };
    const operation = contract.paths['/analytics/category-breakdown']!['get']!;
    return operation.responses['200']!.content['application/json']!.schema as ReturnType<typeof breakdownSchema>;
  };

  it('RED: slices[].categoryId aceita um UUID OU o literal "outras" — e nada mais', () => {
    const { categoryId } = breakdownSchema().properties.slices.items.properties;
    expect(categoryId.pattern).toBeTypeOf('string');
    const pattern = new RegExp(categoryId.pattern!);
    expect(pattern.test('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(pattern.test('outras')).toBe(true);
    // O slice sintético é declarado, não um uuid qualquer.
    expect(pattern.test('Outras')).toBe(false);
    expect(pattern.test('outras-uuid')).toBe(false);
    expect(categoryId.description).toMatch(/outras/i);
  });

  it('RED: a 6ª categoria (cauda) chega ao modelo como "Outras" sem rejeição', async () => {
    const tool = generatedHttpTools.find((candidate) => candidate.name === 'analytics_category_breakdown');
    expect(tool).toBeDefined();
    const requestSpy = vi.spyOn(apiClient, 'requestPiApiJson').mockResolvedValueOnce({
      period: { from: '2026-01-01', to: '2026-01-31' },
      kind: 'expense',
      totalCents: 210000,
      slices: [
        { categoryId: '00000000-0000-4000-8000-000000000001', name: 'Alimentação', totalCents: 50000, pct: 23.8, color: '#0E8C5A' },
        { categoryId: '00000000-0000-4000-8000-000000000002', name: 'Moradia', totalCents: 40000, pct: 19, color: '#0E8C5A' },
        { categoryId: '00000000-0000-4000-8000-000000000003', name: 'Transporte', totalCents: 30000, pct: 14.3, color: '#0E8C5A' },
        { categoryId: '00000000-0000-4000-8000-000000000004', name: 'Saúde', totalCents: 30000, pct: 14.3, color: '#0E8C5A' },
        { categoryId: '00000000-0000-4000-8000-000000000005', name: 'Lazer', totalCents: 40000, pct: 19, color: '#0E8C5A' },
        { categoryId: 'outras', name: 'Outras', totalCents: 20000, pct: 9.5, color: '#9AA5A0' },
      ],
    });

    const result = (await tool!.execute({ period: 'custom', from: '2026-01-01', to: '2026-01-31', kind: 'expense' })) as {
      success?: boolean;
      slices?: Array<Record<string, unknown>>;
    };
    expect(result.success).toBe(true);
    expect(result.slices).toHaveLength(6);
    expect(result.slices?.[5]).toMatchObject({ categoryId: 'outras', name: 'Outras', totalCents: 20000 });
    requestSpy.mockRestore();
  });
});
