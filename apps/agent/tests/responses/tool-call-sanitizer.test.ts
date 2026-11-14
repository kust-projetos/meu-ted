/**
 * TEDV3-003 deterministic defense tests.
 *
 * Finding (evals/reports/ted-v3-real-model-evals-2026-09-15.md): in
 * ambiguous grounded reads with ok-but-non-renderable evidence, small
 * models (glm-5.3-flash, deepseek-flash) answer by printing tool-call
 * markup (`<tool_call>…</tool_call>` and variants) trying to invoke tools
 * that are NOT bound on the read path. Grounding contains the numeric
 * damage, but the raw markup reached the user as the reply.
 *
 * Covers: the deterministic sanitizer, its integration into the grounded
 * response pipeline, and the orchestrator message pipeline.
 */

import { describe, expect, it, vi } from 'vitest';
import { stripToolCallMarkup } from '../../src/responses/tool-call-sanitizer.js';
import { createGroundedResponseWithRetry } from '../../src/responses/grounded-response.js';
import { renderClarificationFallback } from '../../src/responses/deterministic-responses.js';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

const envelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'budgets.summary', retrievedAt: new Date().toISOString(), status: 'ok', data }],
});

const silent = (): void => undefined;

const identity: AuthenticatedIdentity = { actorId: 'actor-1', workspaceId: 'ws-1', role: 'owner', deviceId: 'dev-1' };
const turn = (text: string, intentionId: string) =>
  normalizeRestTurn({ text, intentionId, traceId: intentionId }, identity);

describe('stripToolCallMarkup (TEDV3-003 deterministic defense)', () => {
  it('removes consecutive tool_call pairs that are the entire message (real eval finding)', () => {
    const result = stripToolCallMarkup('<tool_call>check_budgets</tool_call><tool_call>budget_trends</tool_call>');
    expect(result.text).toBe('');
    expect(result.removedBlocks).toBe(2);
    expect(result.changed).toBe(true);
  });

  it('removes a tool_call pair carrying JSON arguments', () => {
    const result = stripToolCallMarkup('<tool_call>\n{"name": "list_transactions", "arguments": {"limit": 5}}\n</tool_call>');
    expect(result.text).toBe('');
    expect(result.removedBlocks).toBe(1);
  });

  it('removes special-token variants with and without a JSON payload', () => {
    expect(stripToolCallMarkup('<|tool_call|>{"name": "budget_trends", "arguments": {}}<|end|>').text).toBe('');
    expect(stripToolCallMarkup('<|tool_call|>check_budgets<|end|>').text).toBe('');
    expect(stripToolCallMarkup('<|tool▁call|>{"name": "check_budgets"}').text).toBe('');
    expect(stripToolCallMarkup('<|tool_call|>').removedBlocks).toBe(1);
  });

  it('removes a fenced invocation-shaped JSON block at the message boundary', () => {
    const result = stripToolCallMarkup('```json\n{"name": "check_budgets", "arguments": {}}\n```');
    expect(result.text).toBe('');
    expect(result.removedBlocks).toBe(1);
  });

  it('preserves literal tool_call markup in a fenced citation, including at the boundary', () => {
    const quote = '```text\n<tool_call>check_budgets</tool_call>\n```';
    expect(stripToolCallMarkup(quote).text).toBe(quote);
  });

  it('keeps a fenced code block that is NOT a tool-call payload', () => {
    const code = 'Aqui está o resumo:\n```json\n{"totals": {"month": "2026-09"}}\n```';
    const result = stripToolCallMarkup(code);
    expect(result.text).toBe(code);
    expect(result.removedBlocks).toBe(0);
    expect(result.changed).toBe(false);
  });

  it('removes a trailing tool_call pair and keeps the prose', () => {
    const result = stripToolCallMarkup('Seu orçamento de setembro está em revisão.\n<tool_call>check_budgets</tool_call>');
    expect(result.text).toBe('Seu orçamento de setembro está em revisão.');
    expect(result.removedBlocks).toBe(1);
  });

  it('removes boundary markup on both sides and keeps the middle prose', () => {
    const result = stripToolCallMarkup('<tool_call>a</tool_call>\nOrçamento em revisão.\n<tool_call>b</tool_call>');
    expect(result.text).toBe('Orçamento em revisão.');
    expect(result.removedBlocks).toBe(2);
  });

  it('neutralizes mid-prose markers', () => {
    const quoted = 'Você escreveu "<tool_call>" — isso não é um comando que eu execute.';
    expect(stripToolCallMarkup(quoted).text).toBe(quoted.replace('<tool_call>', ''));

    const explained = 'Para consultar orçamentos o sistema usaria <tool_call>check_budgets</tool_call> internamente.';
    expect(stripToolCallMarkup(explained).text).toBe(explained.replace('<tool_call>', '').replace('</tool_call>', ''));
    const fenced = '```text\n<tool_call>x</tool_call>\n```';
    expect(stripToolCallMarkup(fenced).text).toBe(fenced);
  });

  it('removes a truncated leading <tool_call> with no closing tag', () => {
    const result = stripToolCallMarkup('<tool_call>check_budgets');
    expect(result.text).toBe('');
    expect(result.removedBlocks).toBe(1);
  });

  it('passes plain text through untouched', () => {
    expect(stripToolCallMarkup('Nubank: R$ 345,67.')).toEqual({ text: 'Nubank: R$ 345,67.', removedBlocks: 0, changed: false });
    expect(stripToolCallMarkup('Como está o meu orçamento?').changed).toBe(false);
  });

  it('is safe on empty and whitespace-only input', () => {
    expect(stripToolCallMarkup('')).toEqual({ text: '', removedBlocks: 0, changed: false });
    expect(stripToolCallMarkup('   \n\t ')).toEqual({ text: '', removedBlocks: 0, changed: false });
  });
});

describe('grounded response pipeline with the sanitizer (TEDV3-003)', () => {
  it('a markup-only reply becomes the deterministic clarification fallback — never empty, never markup', async () => {
    const result = await createGroundedResponseWithRetry(
      '<tool_call>check_budgets</tool_call><tool_call>budget_trends</tool_call>',
      envelope({ yearMonth: '2026-09', plannedCents: 300000 }),
      { fallbackSubject: 'budgets' },
    );
    expect(result.grounded).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.text).toBe(renderClarificationFallback('budgets'));
    expect(result.text).toContain('?');
    expect(result.text).not.toContain('tool_call');
  });

  it('emits agent.response.tool_call_sanitized with counts only (no raw markup in fields)', async () => {
    const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const result = await createGroundedResponseWithRetry(
      '<tool_call>check_budgets</tool_call><tool_call>budget_trends</tool_call>',
      envelope({ plannedCents: 300000 }),
      {
        sink: (type, fields) => events.push({ type, fields }),
        intentionId: 'intent-3',
        traceId: 'trace-3',
      },
    );
    expect(result.text).toContain('?');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('agent.response.tool_call_sanitized');
    expect(events[0]!.fields.removedBlocks).toBe(2);
    expect(JSON.stringify(events[0]!.fields)).not.toContain('check_budgets');
    expect(JSON.stringify(events[0]!.fields)).not.toContain('tool_call');
  });

  it('grounded prose with a trailing markup block stays grounded and drops the block', async () => {
    const env = envelope({ accountName: 'Conta principal', note: 'orçamento em revisão' });
    const result = await createGroundedResponseWithRetry(
      'Orçamento em revisão na Conta principal.\n<tool_call>check_budgets</tool_call>',
      env,
    );
    expect(result.grounded).toBe(true);
    expect(result.rejected).toBe(false);
    expect(result.text).toBe('Orçamento em revisão na Conta principal.');
  });

  it('mid-prose quoted markup still flows through grounding untouched', async () => {
    const env = envelope({ accountName: 'Conta principal' });
    const text = 'Você tentou escrever <tool_call> como comando — isso não é algo que eu execute.';
    const result = await createGroundedResponseWithRetry(text, env);
    expect(result.grounded).toBe(true);
    expect(result.text).toBe(text.replace('<tool_call>', ''));
  });

  it('a correction retry that returns markup-only still falls back safe', async () => {
    const env = envelope({ balanceCents: 12345, accountName: 'Conta principal' });
    const retry = vi.fn(async () => '<tool_call>get_balance</tool_call>');
    const result = await createGroundedResponseWithRetry('Seu saldo é R$ 999,99 na Conta principal.', env, { retry });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.grounded).toBe(false);
    expect(result.text).toMatch(/Não foi possível consultar/);
    expect(result.text).not.toContain('tool_call');
  });
});

describe('orchestrator message pipeline (TEDV3-003 replica)', () => {
  it('ambiguous read with markup-only model output answers the deterministic clarification', async () => {
    const orchestrator = new ConversationOrchestrator({
      evidenceProvider: async () =>
        envelope({ yearMonth: '2026-09', plannedCents: 300000, spentCents: 187540 }),
      responseProvider: async () => '<tool_call>check_budgets</tool_call><tool_call>budget_trends</tool_call>',
      events: silent,
    });
    const result = await orchestrator.runTurn(turn('Como está o meu orçamento?', 'intent-tedv3-003'));
    expect(result.plan.mode).toBe('read');
    expect(result.response?.text).toContain('?');
    expect(result.response?.text).not.toContain('tool_call');
    expect(result.mutation).toBeUndefined();
  });

  it('the generic provider path never publishes markup-only output', async () => {
    const orchestrator = new ConversationOrchestrator({
      responseProvider: async () => '<|tool_call|>{"name": "list_accounts"}',
      events: silent,
    });
    const result = await orchestrator.runTurn(turn('oi, tudo bem?', 'intent-generic-1'));
    const text = result.response?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('tool_call');
  });

  it('the generic provider path keeps prose and drops boundary markup', async () => {
    const orchestrator = new ConversationOrchestrator({
      responseProvider: async () => 'Posso ajudar com consultas e orientações financeiras. <tool_call>list_accounts</tool_call>',
      events: silent,
    });
    const result = await orchestrator.runTurn(turn('oi, tudo bem?', 'intent-generic-2'));
    expect(result.response?.text).toBe('Posso ajudar com consultas e orientações financeiras.');
  });
});
