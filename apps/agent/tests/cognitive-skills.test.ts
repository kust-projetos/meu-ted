import { describe, expect, it } from 'vitest';
import { ALL_SKILLS, skillCatalogLines } from '../src/agent-config/skills/index.js';
import { fitSkills, renderInjectedSkills } from '../src/agent-config/select-skill.js';
import { renderSkillBody } from '../src/agent-config/skills/types.js';

describe('skills catalog', () => {
  it('covers every required situation with one line each', () => {
    const lines = skillCatalogLines();
    expect(lines).toHaveLength(ALL_SKILLS.length);
    for (const line of lines) expect(line).toMatch(/^[a-z-]+: .+/);
    const names = ALL_SKILLS.map((s) => s.name);
    for (const expected of [
      'registros',
      'saldo-extrato',
      'categorias',
      'orcamentos-metas',
      'relatorios',
      'contas-cartoes',
      'compromissos',
      'workspace',
      'web-search',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('every skill has steps, pitfalls and tools', () => {
    for (const skill of ALL_SKILLS) {
      expect(skill.steps.length).toBeGreaterThanOrEqual(3);
      expect(skill.pitfalls.length).toBeGreaterThanOrEqual(1);
      expect(skill.keywords.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('relatorios forbids manual per-transaction sums', () => {
    const body = renderSkillBody(ALL_SKILLS.find((s) => s.name === 'relatorios')!);
    expect(body).toMatch(/NUNCA some/i);
    expect(body).toMatch(/agregação/i);
  });
});

describe('skill selection heuristic', () => {
  it.each([
    ['lancei um gasto no mercado hoje', 'registros'],
    ['qual o meu saldo?', 'saldo-extrato'],
    ['crie uma subcategoria em alimentação', 'categorias'],
    ['quero um orçamento para lazer', 'orcamentos-metas'],
    ['como estou este mês?', 'relatorios'],
    ['quando vence minha fatura?', 'contas-cartoes'],
    ['tenho contas a pagar atrasadas?', 'compromissos'],
    ['qual a cotação do dólar hoje?', 'web-search'],
  ])('selects %s for %s', (message, expected) => {
    // Force single-skill injection with a tiny budget.
    const fit = fitSkills(message, 100);
    expect(fit.selected?.name).toBe(expected);
    expect(fit.injected.map((s) => s.name)).toEqual([expected]);
    expect(fit.injectedAll).toBe(false);
  });

  it('returns no selection for an unrecognized message', () => {
    const fit = fitSkills('olá, bom dia', 100);
    expect(fit.selected).toBeNull();
    expect(renderInjectedSkills(fit)).toBeNull();
  });

  // A06/R06: the generative path reads the same informal language the
  // deterministic parser does, through the same abbreviation table.
  it('selects registros for the informal mutation utterance', () => {
    const fit = fitSkills('gstei 50 d carne hj no nubnk', 100);
    expect(fit.selected?.name).toBe('registros');
    expect(fit.injected.map((s) => s.name)).toEqual(['registros']);
  });

  it('injects everything when it fits the budget (size decision)', () => {
    const allBodies = ALL_SKILLS.map((s) => renderSkillBody(s)).join('\n\n');
    expect(allBodies.length).toBeGreaterThan(100); // sanity: realistic corpus
    const fits = fitSkills('qual o meu saldo?', allBodies.length);
    expect(fits.injectedAll).toBe(true);
    expect(fits.injected).toHaveLength(ALL_SKILLS.length);
    expect(fits.injectedChars).toBe(allBodies.length);
    // Winner still identified for relevance ordering.
    expect(fits.selected?.name).toBe('saldo-extrato');
    const tight = fitSkills('qual o meu saldo?', 100);
    expect(tight.injectedAll).toBe(false);
    expect(tight.injected.map((s) => s.name)).toEqual(['saldo-extrato']);
  });
});
