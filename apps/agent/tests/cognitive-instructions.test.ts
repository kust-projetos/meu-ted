import { describe, expect, it } from 'vitest';
import {
  INSTRUCTIONS_VERSION,
  TED_IDENTITY,
  TED_GOLDEN_RULE,
  TED_ATTACHMENT_DATA_PRECEDENCE,
  TED_MUTATION_POLICY,
  TED_BOUNDARIES,
  buildSystemPrompt,
} from '../src/agent-config/instructions.js';
import { PLAYBOOK_BODY } from '../src/agent-config/playbook.js';
import { skillCatalogLines } from '../src/agent-config/skills/index.js';
import { toolSkillLines } from '../src/agent-config/tools.js';
import { assembleCognition } from '../src/agent-config/index.js';

const baseInput = {
  skillCatalog: skillCatalogLines(),
  activeSkillBody: null,
  playbookBody: PLAYBOOK_BODY,
  toolCatalog: toolSkillLines(),
  webStatusLine: 'indisponível (sem chave configurada) — responda com os dados do workspace.',
};

describe('TED instructions (Part A, item 15)', () => {
  it('is versioned', () => {
    expect(INSTRUCTIONS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.[a-z]$/);
  });

  it('persona names the Meu Ted brand without jargon promises', () => {
    expect(TED_IDENTITY).toContain('Meu Ted');
    expect(TED_IDENTITY).toContain('Tudo em dia.');
    expect(TED_IDENTITY).toMatch(/Português do Brasil|pt-BR/);
  });

  it('golden rule forces real workspace data and bans invented numbers', () => {
    expect(TED_GOLDEN_RULE).toMatch(/DADOS REAIS/i);
    expect(TED_GOLDEN_RULE).toMatch(/nunca invente números/i);
    expect(TED_GOLDEN_RULE).toMatch(/sem autorização/i);
  });

  it('mutation policy keeps manual fallback on the confirmation card', () => {
    expect(TED_MUTATION_POLICY).toMatch(/cartão/i);
    expect(TED_MUTATION_POLICY).toMatch(/confirmação/i);
  });

  it('boundaries ban secrets and technical ids', () => {
    expect(TED_BOUNDARIES).toMatch(/segredos|tokens|chaves/i);
    expect(TED_BOUNDARIES).toMatch(/IDs técnicos/i);
    expect(TED_BOUNDARIES).toMatch(/workspace ativo/i);
  });

  it('assembled prompt contains persona + catalog + playbook + tools', () => {
    const system = buildSystemPrompt(baseInput);
    expect(system).toContain('Meu Ted');
    expect(system).toContain('REGRA DE OURO');
    expect(system).toContain('SKILLS');
    expect(system).toContain('registros:');
    expect(system).toContain('PLAYBOOK FINANCEIRO');
    expect(system).toContain('50/30/20');
    expect(system).toContain('FERRAMENTAS DO WORKSPACE');
    expect(system).toContain('get_balance');
    expect(system).toContain('WEB:');
    expect(system.length).toBeGreaterThan(2000);
  });

  it('injects the active skill body and the Part B memory slot', () => {
    const system = buildSystemPrompt({
      ...baseInput,
      activeSkillBody: '# Teste\npasso 1',
      memoryContext: 'lembrete: pessoa prefere resumos curtos',
    });
    expect(system).toContain('SKILL ATIVA');
    expect(system).toContain('# Teste');
    expect(system).toContain('MEMÓRIA DO USUÁRIO');
    expect(system).toContain('resumos curtos');
  });

  it('omits empty skill/memory sections', () => {
    const system = buildSystemPrompt(baseInput);
    expect(system).not.toContain('SKILL ATIVA');
    expect(system).not.toContain('MEMÓRIA DO USUÁRIO');
  });

  it('carries the anti-tool-call response discipline in the mounted prompt (TEDV3-003)', () => {
    const system = buildSystemPrompt(baseInput);
    expect(system).toContain('DISCIPLINA DE RESPOSTA');
    expect(system).toContain('<tool_call>');
    expect(system).toMatch(/linguagem natural/i);
  });

  it('assembleCognition injects the discipline for the grounded read path', () => {
    const cognition = assembleCognition('Como está o meu orçamento?', {});
    expect(cognition.system).toContain('DISCIPLINA DE RESPOSTA');
    expect(cognition.system).toContain('<tool_call>');
    expect(cognition.system).toMatch(/\?/);
  });
});

describe('attachment DATA precedence (A19-PROMPT-PRECEDENCE)', () => {
  it('scopes the rule to attachment-question turns with a provenance-marked block', () => {
    expect(TED_ATTACHMENT_DATA_PRECEDENCE).toMatch(/pergunta[^.]*anexo|anexo[^.]*pergunta/i);
    expect(TED_ATTACHMENT_DATA_PRECEDENCE).toMatch(/marcador de proveniência|proveniência/i);
  });

  it('orders answer-from-block with citation over tool output', () => {
    expect(TED_ATTACHMENT_DATA_PRECEDENCE).toMatch(/a partir do bloco/i);
    expect(TED_ATTACHMENT_DATA_PRECEDENCE).toMatch(/cite|citar/i);
    expect(TED_ATTACHMENT_DATA_PRECEDENCE).toMatch(/nunca substitu|não substitu|jamais nega|nunca nega/i);
  });

  it('keeps tool-first for pure finance questions and DATA-never-instruction intact', () => {
    expect(TED_ATTACHMENT_DATA_PRECEDENCE).toMatch(/tool-first|REGRA DE OURO/i);
    expect(TED_ATTACHMENT_DATA_PRECEDENCE).toMatch(/dado, nunca instrução|nunca instrução/i);
    expect(TED_ATTACHMENT_DATA_PRECEDENCE).toMatch(/autoexecute/i);
  });

  it('is injected into the mounted system prompt', () => {
    const system = buildSystemPrompt(baseInput);
    expect(system).toContain('DADO DO ANEXO');
  });
});
