/**
 * RED (categories-create-v2-endtoend — Agent): parser estrito + router split
 * + contexto esperado + receipt + copy.
 * - `crie categoria X [de despesa|de receita] [em/filha de PAI]` → isCreation
 * - kind nunca inferido sem marcador; pai nunca inferido por parcial ambígua
 * - update/delete continuam recusa específica, nunca forget
 * - expected context kind-only; receipt category vinculada; copy categoria
 */
import { describe, expect, it } from 'vitest';
import { hasCategoryCreateSignal, hasCategoryUpdateDeleteSignal, parseCategoryCreation, parseCategorySlotContribution } from '../src/mutations/category-creation.js';
import { routeIntent, UNSUPPORTED_CATEGORY_MUTATION_TEXT } from '../src/orchestration/intent-router.js';
import { resolveExpectedContext } from '../src/mutations/expected-context.js';
import { renderMutationResult } from '../src/responses/deterministic-responses.js';

describe('RED agent categories.create', () => {
  it('sinal create apenas para verbo de criação + categoria', () => {
    expect(hasCategoryCreateSignal('crie categoria Mercado de despesa')).toBe(true);
    expect(hasCategoryCreateSignal('criar categoria Salário de receita')).toBe(true);
    expect(hasCategoryCreateSignal('renomeie categoria Mercado')).toBe(false);
    expect(hasCategoryCreateSignal('exclua categoria Mercado')).toBe(false);
    expect(hasCategoryCreateSignal('liste minhas categorias')).toBe(false);
  });

  it('sinal update/delete específico para recusa', () => {
    expect(hasCategoryUpdateDeleteSignal('renomeie categoria Mercado')).toBe(true);
    expect(hasCategoryUpdateDeleteSignal('exclua categoria Mercado')).toBe(true);
    expect(hasCategoryUpdateDeleteSignal('crie categoria Mercado')).toBe(false);
    expect(UNSUPPORTED_CATEGORY_MUTATION_TEXT).toMatch(/renomear|excluir/i);
    expect(UNSUPPORTED_CATEGORY_MUTATION_TEXT).not.toMatch(/criar categoria.*suportad/i);
  });

  it('parser extrai nome/kind/pai sem inferir', () => {
    const full = parseCategoryCreation('crie categoria Mercado de despesa filha de Alimentação');
    expect(full.isCreation).toBe(true);
    expect(full.name).toBe('Mercado');
    expect(full.kind).toBe('expense');
    expect(full.parentQuery).toBe('Alimentação');
    const noKind = parseCategoryCreation('crie categoria Mercado');
    expect(noKind.isCreation).toBe(true);
    expect(noKind.kind).toBeUndefined();
    const noName = parseCategoryCreation('crie categoria de despesa');
    expect(noName.name).toBeUndefined();
  });

  it('router: create vira mutation-proposal categories.create; rename vira categories.update; delete recusa', () => {
    const create = routeIntent('crie categoria Mercado de despesa');
    expect(create.mode).toBe('mutation-proposal');
    expect(create.domain).toBe('categories');
    expect(create.requestedOperations.some((op) => op.name === 'categories.create')).toBe(true);
    // categories.update (nome-only, manual): o rename tem plano próprio.
    const upd = routeIntent('renomeie categoria Mercado para Feira');
    expect(upd.mode).toBe('mutation-proposal');
    expect(upd.domain).toBe('categories');
    expect(upd.requestedOperations.some((op) => op.name === 'categories.update')).toBe(true);
    const del = routeIntent('exclua categoria Mercado');
    expect(del.mode).toBe('unsupported');
    expect(del.ambiguity).toBe('unsupported_category_mutation');
  });

  it('expected context kind-only; receipt copy categoria', () => {
    const ctx = resolveExpectedContext({ tool: 'categories.create' } as never);
    expect(ctx).toEqual({ tool: 'categories.create' });
    expect(renderMutationResult('succeeded', 'operação', { mutationKind: 'categories.create' })).toBe(
      'Categoria criada com sucesso.',
    );
  });
});

describe('R7 findings 1-3: contribuição contextual + kind exato + sub exige pai', () => {
  it('F1: contribuição sem verbo preenche slots; detector fresh continua exigindo verbo', () => {
    expect(parseCategorySlotContribution('de despesa').kind).toBe('expense');
    expect(parseCategorySlotContribution('de receita').kind).toBe('income');
    expect(parseCategorySlotContribution('Viagem').name).toBe('Viagem');
    expect(parseCategorySlotContribution('em Alimentação').parentQuery).toBe('Alimentação');
    expect(parseCategorySlotContribution('sem pai').dropParent).toBe(true);
    expect(parseCategoryCreation('de despesa').isCreation).toBe(false);
    expect(parseCategoryCreation('Viagem').isCreation).toBe(false);
    expect(parseCategoryCreation('em Alimentação').isCreation).toBe(false);
  });

  it('F2: kind duplo ("despesa ou receita") não escolhe; kind dentro de nome/pai citado não conta', () => {
    expect(parseCategoryCreation('crie categoria Viagem de despesa ou receita').kind).toBeUndefined();
    expect(parseCategorySlotContribution('despesa ou receita').kind).toBeUndefined();
    const quoted = parseCategoryCreation('crie categoria "Receita"');
    expect(quoted.name).toBe('Receita');
    expect(quoted.kind).toBeUndefined();
    const parentQuoted = parseCategoryCreation('crie categoria Mercado filha de "Receita Federal"');
    expect(parentQuoted.name).toBe('Mercado');
    expect(parentQuoted.kind).toBeUndefined();
    expect(parentQuoted.parentQuery).toBe('Receita Federal');
  });

  it('F3: sub sem pai preserva intent (requiresParent), nunca macro silenciosa', () => {
    const sub = parseCategoryCreation('crie subcategoria Mercado de despesa');
    expect(sub.isCreation).toBe(true);
    expect(sub.requiresParent).toBe(true);
    expect(sub.parentQuery).toBeUndefined();
    const macro = parseCategoryCreation('crie categoria Mercado de despesa');
    expect(macro.requiresParent ?? false).toBe(false);
    const subComPai = parseCategoryCreation('crie subcategoria Mercado de despesa em Alimentação');
    expect(subComPai.requiresParent ?? false).toBe(false);
    expect(subComPai.parentQuery).toBe('Alimentação');
  });
});
