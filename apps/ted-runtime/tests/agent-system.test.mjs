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
    ]) assert.match(TED_AGENT_SYSTEM_PROMPT, text);
    assert.doesNotMatch(TED_AGENT_SYSTEM_PROMPT, /\$\{|<[^>]+>|\{\{|\}\}/);
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
});
