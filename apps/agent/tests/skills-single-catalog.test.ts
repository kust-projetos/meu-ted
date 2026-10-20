/**
 * CODER-A-SKILLS — single skill→tool catalog (TDD RED).
 *
 * - `toolSkillLines()` (agent-config/tools.ts, derived from ALL_SKILLS) is the
 *   ONLY skill→tool source; `routeIntent` plans must name canonical skills and
 *   derive `requestedTools` via `selectToolsFor` (never the legacy
 *   `skill-inventory.ts` names/tools).
 * - V1 retired tools must never leak to `buildExposedTools` (SDK surface) or
 *   to the assembled prompt (system/tool catalog).
 */
import { describe, expect, it } from 'vitest';
import { routeIntent } from '../src/orchestration/intent-router.js';
import { ALL_SKILLS } from '../src/agent-config/skills/index.js';
import {
  RETIRED_MODEL_TOOLS,
  buildExposedTools,
  selectToolsFor,
  toolSkillLines,
} from '../src/agent-config/tools.js';
import { assembleCognition } from '../src/agent-config/index.js';

const V1_RETIRED = [
  'get_pending_operation',
  'confirm_pending_operation',
  'cancel_pending_operation',
  'undo_last_action',
] as const;

const CANONICAL = new Set(ALL_SKILLS.map((s) => s.name));
const LEGACY = ['financial-analysis', 'financial-mutations'];

describe('single skill catalog: routeIntent uses canonical skills + selectToolsFor', () => {
  it('read path names only canonical skills (never legacy inventory)', () => {
    for (const text of ['qual meu saldo?', 'Quanto gastei esse mês?', 'mostre o extrato', 'contas vencidas']) {
      const plan = routeIntent(text);
      for (const name of plan.skillNames) {
        expect(LEGACY, `${text}:${name}`).not.toContain(name);
        expect(name === 'conversation' || CANONICAL.has(name), `${text}:${name}`).toBe(true);
      }
    }
  });

  it('mutation path names only canonical skills', () => {
    const plan = routeIntent('gastei 50 no mercado');
    if (plan.mode === 'mutation-proposal') {
      for (const name of plan.skillNames) {
        expect(LEGACY, name).not.toContain(name);
        expect(name === 'conversation' || CANONICAL.has(name), name).toBe(true);
      }
    }
  });

  it('requestedTools priorizam as tools das operações do plano (presença, teto 8)', () => {
    const OPERATION_TOOL: Record<string, string> = {
      list_transactions: 'list_recent_transactions',
      list_payables: 'list_accounts_payable',
      list_accounts_payable: 'list_accounts_payable',
      check_payable_reminders: 'list_accounts_payable',
    };
    for (const text of ['qual meu saldo?', 'Quanto gastei esse mês?', 'gastei 50 no mercado', 'contas vencidas', 'Mostre minhas faturas']) {
      const plan = routeIntent(text);
      const tools = [...(plan.requestedTools ?? [])];
      expect(tools.length).toBeLessThanOrEqual(8);
      for (const operation of plan.requestedOperations) {
        if (operation.kind !== 'read') continue;
        const tool = OPERATION_TOOL[operation.name] ?? operation.name;
        expect(tools, `${text}:${operation.name}→${tool}`).toContain(tool);
      }
    }
    // Caso âncora P2b: "faturas" planeja list_statements e a tool viaja no plano.
    const faturas = routeIntent('Mostre minhas faturas');
    expect(faturas.requestedOperations.map((operation) => operation.name)).toContain('list_statements');
    expect([...(faturas.requestedTools ?? [])]).toContain('list_statements');
  });
});

describe('V1 surface contract: retired tools never reach SDK or prompt', () => {
  const baseCtx = {
    delegatedToken: 'delegated-test-token',
    apiOrigin: 'https://api.example.test',
    workspaceId: 'ws-1',
    actorId: 'actor-1',
    intentionId: 'intent-1',
    lastUserMessage: 'tenho uma aprovação pendente?',
  };

  it('selectToolsFor never emits retired tools for any skill (incl. unknown/legacy names)', () => {
    const probes: string[][] = [
      [...CANONICAL],
      ['registros'],
      ['relatorios'],
      ['contas-cartoes'],
      ['compromissos'],
      ['unknown-skill'],
      [...LEGACY],
    ];
    for (const probe of probes) {
      const names = selectToolsFor(probe);
      for (const retired of V1_RETIRED) {
        expect(names, `${probe.join(',')}:${retired}`).not.toContain(retired);
      }
    }
    for (const retired of V1_RETIRED) {
      expect(RETIRED_MODEL_TOOLS.has(retired), retired).toBe(true);
    }
  });

  it('buildExposedTools drops retired tools even when explicitly requested (SDK surface)', () => {
    const exposed = buildExposedTools([...V1_RETIRED], baseCtx);
    for (const retired of V1_RETIRED) {
      expect(exposed[retired], retired).toBeUndefined();
    }
    const exposedAll = buildExposedTools([...selectToolsFor([...CANONICAL]), ...V1_RETIRED], baseCtx);
    for (const retired of V1_RETIRED) {
      expect(exposedAll[retired], retired).toBeUndefined();
    }
  });

  it('prompt surface (tool catalog + assembled system) never mentions retired tools', () => {
    const catalog = toolSkillLines().join('\n');
    for (const retired of V1_RETIRED) {
      expect(catalog, retired).not.toContain(retired);
    }
    for (const text of ['qual meu saldo?', 'tenho uma aprovação pendente?', 'desfazer lançamento']) {
      const cognition = assembleCognition(text, {});
      const haystack = `${cognition.system}\n${cognition.toolNames.join(' ')}`;
      for (const retired of V1_RETIRED) {
        expect(haystack, `${text}:${retired}`).not.toContain(retired);
      }
      for (const name of cognition.toolNames) {
        expect(RETIRED_MODEL_TOOLS.has(name), name).toBe(false);
      }
    }
  });
});
