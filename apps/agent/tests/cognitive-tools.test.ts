import { describe, expect, it, vi } from 'vitest';
import {
  CORE_READ_TOOLS,
  MAX_EXPOSED_TOOLS,
  buildApprovalRequest,
  buildExposedTools,
  isExplicitConfirmation,
  selectToolsFor,
  toolSkillLines,
  toolSkillMap,
} from '../src/agent-config/tools.js';

const baseCtx = {
  delegatedToken: 'delegated-test-token',
  apiOrigin: 'https://api.example.test',
  workspaceId: 'ws-1',
  actorId: 'actor-1',
  intentionId: 'intent-1',
  lastUserMessage: 'qual o meu saldo?',
};

describe('tool subset + skill map', () => {
  it('always includes core reads and caps the set', () => {
    const names = selectToolsFor(['registros', 'relatorios']);
    for (const read of CORE_READ_TOOLS) expect(names).toContain(read);
    expect(names.length).toBeLessThanOrEqual(MAX_EXPOSED_TOOLS);
    expect(names).toContain('create_expense');
    expect(names).toContain('get_month_summary');
  });

  it('caps large selections at MAX_EXPOSED_TOOLS keeping core reads', () => {
    const names = selectToolsFor(['registros', 'relatorios', 'contas-cartoes', 'compromissos', 'orcamentos-metas']);
    expect(names.length).toBeLessThanOrEqual(MAX_EXPOSED_TOOLS);
    for (const read of CORE_READ_TOOLS) expect(names).toContain(read);
  });

  it('exposes only real generated tools (no invented names)', async () => {
    const { generatedHttpTools } = await import('../src/generated/http-tools.js');
    const { MEMORY_TOOL_NAMES } = await import('../src/agent-config/memory/tools.js');
    const real = new Set<string>(generatedHttpTools.map((t) => t.name));
    const workerLocal = new Set<string>([...MEMORY_TOOL_NAMES, 'web_search', 'web_fetch']);
    for (const name of selectToolsFor(['registros', 'relatorios', 'contas-cartoes'])) {
      if (workerLocal.has(name)) continue;
      expect(real.has(name), name).toBe(true);
    }
  });

  it('maps every curated tool to a skill', () => {
    const map = toolSkillMap();
    // R7-F7: category mutations are conversational-only (pending drafts);
    // update/deactivate are unsupported and create_category never rides as a
    // direct model tool (manual-only via approval) — hence deliberately
    // unmapped from every skill.
    const conversationalOnly = new Set(['create_category', 'update_category', 'deactivate_category']);
    for (const line of toolSkillLines()) {
      const name = line.split(' ')[0]!;
      if (conversationalOnly.has(name)) continue;
      expect(map[name], name).toBeDefined();
    }
    expect(map['create_expense']).toBe('registros');
    expect(map['get_balance']).toBe('saldo-extrato');
    expect(map['web_search']).toBe('web-search');
  });
});

describe('mutation gating (first enforcement of safety utils)', () => {
  it('blocks mutating calls on read-only turns without executing', async () => {
    const fetchMock = vi.fn();
    const tools = buildExposedTools(['create_expense'], { ...baseCtx, fetchImpl: fetchMock as unknown as typeof fetch });
    const result = (await (tools['create_expense'] as { execute: (p: unknown) => Promise<unknown> }).execute({})) as {
      blocked?: boolean;
    };
    expect(result.blocked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks approval tools until MutationExecutor V2 exists', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const pending = buildExposedTools(['pay_statement'], {
        ...baseCtx,
        lastUserMessage: 'quero pagar a fatura',
      });
      const asked = (await (pending['pay_statement'] as { execute: (p: unknown) => Promise<unknown> }).execute({})) as {
        blocked?: boolean;
      };
      expect(asked.blocked).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      const confirmed = buildExposedTools(['pay_statement'], {
        ...baseCtx,
        lastUserMessage: 'sim, pode pagar a fatura',
      });
      const result = await (confirmed['pay_statement'] as { execute: (p: unknown) => Promise<unknown> }).execute({
        statementId: '00000000-0000-4000-8000-000000000001',
      });
      expect(result).toMatchObject({ blocked: true });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(buildApprovalRequest('pay_statement').needsApproval).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('recognizes explicit confirmations', () => {
    expect(isExplicitConfirmation('sim, pode fazer')).toBe(true);
    expect(isExplicitConfirmation('confirmo o pagamento')).toBe(true);
    expect(isExplicitConfirmation('qual o meu saldo?')).toBe(false);
  });
});
