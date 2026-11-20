import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TED_AGENT_SYSTEM_PROMPT } from '../src/agent-system.mjs';
import { tedConfig, writeTedConfig } from '../src/bootstrap.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

describe('TED product system prompt', () => {
  it('is a non-empty static product prompt with the required safeguards', () => {
    assert.equal(typeof TED_AGENT_SYSTEM_PROMPT, 'string');
    assert.ok(TED_AGENT_SYSTEM_PROMPT.trim());
    for (const text of [
      /REGRA DE OURO/i, /list_categories/, /propose_category_create/,
      /corrigem a proposta pendente/i, /não é correção/i,
      /Nunca invente números/i, /Nunca peça senhas/i, /Nunca mostre IDs técnicos/i,
      /primeira mensagem/i, /ambiguidade material/i,
      /receita, não despesa/i, /propose_card_purchase/i,
      /propose_statement_payment/i, /nunca é despesa/i,
      /propose_transfer/i, /sem categoria/i,
      /reutilize categorias existentes equivalentes/i,
      /13º salário/i, /cashback/i, /estorno/i,
      /NUNCA pergunte ao usuário/i, /decida você/i,
      /proponha a criação com propose_category_create/i,
      /recall_category_preference/i, /descrição completa do lançamento/i,
      /pergunte quando houver ambiguidade material/i,
      /duas contas homônimas/i, /ano indeterminável/i,
      /nunca confirma nem executa/i, /preservando os demais/i,
      /sem dado disponível/i, /nunca adivinhe/i,
    ]) assert.match(TED_AGENT_SYSTEM_PROMPT, text);
    assert.doesNotMatch(TED_AGENT_SYSTEM_PROMPT, /\$\{|<[^>]+>|\{\{|\}\}/);
    assert.doesNotMatch(TED_AGENT_SYSTEM_PROMPT, /(?:palavras-chave|palavras chave)/i);
    assert.doesNotMatch(TED_AGENT_SYSTEM_PROMPT, /(?:propose_category_(?:update|fix)|correct_category)/i);
  });

  it('gates system prompt injection without changing the default config', () => {
    const expected = tedConfig('test');
    assert.equal(JSON.stringify(tedConfig('test', { productPrompt: false })), JSON.stringify(expected));
    assert.equal(Object.hasOwn(tedConfig('test', { productPrompt: false }).agents.ted, 'system'), false);
    assert.equal(tedConfig('test', { productPrompt: true }).agents.ted.system, TED_AGENT_SYSTEM_PROMPT);
  });

  it('writes the unchanged default config when product prompt is disabled', () => {
    const dir = path.join(approvedTmpRoot('ted-agent-system'), 'config');
    fs.mkdirSync(dir, { recursive: true });
    const file = writeTedConfig(dir, 'test', { productPrompt: false });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(tedConfig('test'), null, 2) + '\n');
  });

  it('rewrites a previously generated config whose only difference is the system prompt', () => {
    const dir = path.join(approvedTmpRoot('ted-agent-system-prompt-upgrade'), 'config');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.json');
    const old = tedConfig('test', { productPrompt: true });
    old.agents.ted.system = 'prompt de uma versão anterior';
    fs.writeFileSync(file, JSON.stringify(old, null, 2) + '\n');
    writeTedConfig(dir, 'test', { productPrompt: true });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(tedConfig('test', { productPrompt: true }), null, 2) + '\n');
  });

  it('still refuses a config edited outside the system prompt', () => {
    const dir = path.join(approvedTmpRoot('ted-agent-system-user-edit'), 'config');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.json');
    const edited = tedConfig('test', { productPrompt: true });
    edited.agents.ted.system = 'outro prompt';
    edited.userKey = true;
    fs.writeFileSync(file, JSON.stringify(edited, null, 2) + '\n');
    assert.throws(() => writeTedConfig(dir, 'test', { productPrompt: true }), /refusing to overwrite/);
  });
});
