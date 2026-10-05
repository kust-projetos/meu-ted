import { describe, expect, it } from 'vitest';
import { ALL_SKILLS, skillCatalogLines } from '../src/agent-config/skills/index.js';
import { fitSkills, renderInjectedSkills, SKILL_BUDGET_CHARS } from '../src/agent-config/select-skill.js';
import { renderSkillBody } from '../src/agent-config/skills/types.js';
import { CORE_READ_TOOLS, selectToolsFor } from '../src/agent-config/tools.js';
import { assembleCognition } from '../src/agent-config/index.js';
import type { UserSkillVersion } from '../src/agent-config/user-skills/store.js';
import { toSelectableSkills } from '../src/agent-config/user-skills/resolve.js';

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

// A18/R17: active user skills join the SAME keyword score and the SAME
// 6000-char budget. There is no second selection or budget mechanism, and the
// core catalog keeps its behavior when no user skill matches.
describe('user skills inside the existing selection budget', () => {
  const CATALOG = [{ id: 'cat_padarias', name: 'Padarias' }];

  const userVersion = (id: string, name: string, merchantPattern: string, categoryId: string): UserSkillVersion => ({
    id,
    workspaceId: 'ws-a18',
    name,
    version: 1,
    rule: { merchantPattern, categoryId },
    keywords: [],
    active: true,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    approvedBy: 'operator@pi',
    promotionEvidence: null,
    revokedAt: null,
  });

  const aliasSkill = (name = 'alias-padaria') =>
    toSelectableSkills([userVersion('us-1', name, 'padaria do bairro', 'cat_padarias')], CATALOG)[0]!;

  it('selects an active user skill by keyword inside the shared budget', () => {
    const userSkills = [aliasSkill()];
    // Same size decision as core: with a tight budget only the winner is
    // injected whole, exactly like `fitSkills(message, 100)` for core skills.
    const tight = fitSkills('gastei na padaria do bairro', 100, userSkills);
    expect(tight.selected?.name).toBe('alias-padaria');
    expect(tight.injected.map((s) => s.name)).toEqual(['alias-padaria']);
    expect(tight.injectedAll).toBe(false);
    // F5: the single winner is bounded by the SAME ceiling — the body is
    // truncated to the budget instead of being injected whole past it.
    expect(renderSkillBody(aliasSkill()).length).toBeGreaterThan(100);
    expect(tight.injectedChars).toBeLessThanOrEqual(100);
    expect(renderInjectedSkills(tight)!.length).toBeLessThanOrEqual(100);
    expect(renderInjectedSkills(tight)).toContain('Preferência do usuário');

    // With a budget that fits core + user skills, everything is injected.
    const bodies =
      [...ALL_SKILLS, ...userSkills].map((skill) => renderSkillBody(skill)).join('\n\n');
    const fits = fitSkills('gastei na padaria do bairro', bodies.length, userSkills);
    expect(fits.injectedAll).toBe(true);
    expect(fits.injected.map((s) => s.name)).toEqual(['alias-padaria', ...ALL_SKILLS.map((s) => s.name)]);
    expect(fits.injectedChars).toBe(bodies.length);
  });

  it('keeps core selection when no user skill matches', () => {
    const userSkills = [aliasSkill()];
    const withUser = fitSkills('qual o meu saldo?', 100, userSkills);
    const coreOnly = fitSkills('qual o meu saldo?', 100);
    expect(withUser.selected?.name).toBe('saldo-extrato');
    expect(withUser.injected.map((s) => s.name)).toEqual(['saldo-extrato']);
    // An unrelated active user skill changes nothing for a core message.
    const fullWithUser = fitSkills('qual o meu saldo?', SKILL_BUDGET_CHARS, userSkills);
    const fullCoreOnly = fitSkills('qual o meu saldo?', SKILL_BUDGET_CHARS);
    expect(fullWithUser.selected?.name).toBe(coreOnly.selected?.name);
    expect(fullWithUser.injectedAll).toBe(fullCoreOnly.injectedAll);
    expect(fullWithUser.injected.filter((s) => ALL_SKILLS.includes(s)).map((s) => s.name)).toEqual(
      fullCoreOnly.injected.map((s) => s.name),
    );
  });

  it('is byte identical to today when no user skill is supplied', () => {
    for (const message of ['qual o meu saldo?', 'olá, bom dia', 'lancei um gasto no mercado hoje']) {
      const baseline = fitSkills(message);
      expect(fitSkills(message, SKILL_BUDGET_CHARS, [])).toEqual(baseline);
    }
  });

  it('never widens the tool catalog through a user skill', () => {
    const alias = aliasSkill();
    const coreNames = ALL_SKILLS.map((skill) => skill.name);
    // An unknown (user) skill name resolves no tool beyond the core reads,
    // and adding it to the injected set changes nothing.
    expect(selectToolsFor([alias.name])).toEqual([...CORE_READ_TOOLS]);
    expect(selectToolsFor([...coreNames, alias.name])).toEqual(selectToolsFor(coreNames));
    const fit = fitSkills('gastei na padaria do bairro', SKILL_BUDGET_CHARS, [alias]);
    const injectedNames = fit.injected.map((s) => s.name);
    expect(injectedNames).toContain(alias.name);
    // Whatever the budget decided, the alias contributes zero tools.
    expect(selectToolsFor(injectedNames)).toEqual(selectToolsFor(injectedNames.filter((name) => name !== alias.name)));
  });

  it('assembleCognition keeps the same tool names with an active user skill', () => {
    const core = assembleCognition('qual o meu saldo?');
    const withUser = assembleCognition('qual o meu saldo?', { userSkills: [aliasSkill()] });
    expect(withUser.toolNames).toEqual(core.toolNames);
    expect(withUser.instructionsVersion).toBe(core.instructionsVersion);
    // The alias is data, not capability: it never appears in the tool catalog.
    expect(withUser.system).not.toMatch(/alias-padaria: /);
  });
});
