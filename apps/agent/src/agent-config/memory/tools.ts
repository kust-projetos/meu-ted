/**
 * Worker-local memory tools (Part B, item 15): remember_fact, recall,
 * list_past_sessions, get_session_summary. Unlike the generated HTTP tools,
 * these run against the DO SQLite database directly — same workspace/actor
 * isolation, no network. Wired into the model via `buildExposedTools`
 * `extraTools` (see agent-config/tools.ts).
 */

import { tool, jsonSchema } from 'ai';
import { listPastSessions, getSessionSummary } from './sessions.js';
import {
  recallMemories,
  rememberFact,
  type MemorySql,
} from './store.js';
import { proposeForgetMemory } from './forget-proposals.js';

export type MemoryToolContext = {
  sql: MemorySql;
  workspaceId: string;
  actorId: string;
  /** Proveniência da proposta (auditoria); ausente = proposta sem turno vinculado. */
  intentionId?: string;
  /** Relógio injetável (testes); ausente = Date.now(). */
  nowMs?: number;
};

export const buildMemoryTools = (ctx: MemoryToolContext): Record<string, ReturnType<typeof tool>> => ({
  remember_fact: tool({
    description: 'Guarda um fato, preferência ou aprendizado durável sobre a pessoa (com o consentimento implícito do pedido). Nunca use para saldos, valores atuais, faturas ou extratos — valores financeiros atuais nunca são duráveis e serão recusados.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 500 },
        kind: { type: 'string', enum: ['fact', 'preference', 'learning'] },
      },
      required: ['content'],
    }),
    execute: async (params: Record<string, unknown>) => {
      const result = rememberFact(ctx.sql, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actorId,
        kind: (params.kind as 'fact' | 'preference' | 'learning' | undefined) ?? 'fact',
        content: String(params.content ?? ''),
      });
      if (!result.stored) {
        return { stored: false, reason: result.reason, message: 'Não guardei isso (conteúdo vazio ou sensível).' };
      }
      return {
        stored: true,
        deduped: result.deduped,
        message: result.deduped ? 'Isso reforça algo que eu já sabia.' : 'Memorizado.',
      };
    },
  }),

  recall: tool({
    description: 'Busca na memória do workspace por fatos e aprendizados (palavras-chave, recência e relevância).',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 300 },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    }),
    execute: async (params: Record<string, unknown>) => {
      const items = recallMemories(ctx.sql, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actorId,
        query: String(params.query ?? ''),
        limit: typeof params.limit === 'number' ? params.limit : 5,
      });
      return {
        found: items.length,
        memories: items.map((item) => ({ kind: item.kind, content: item.content })),
      };
    },
  }),

  list_past_sessions: tool({
    description: 'Lista sessões de conversa anteriores encerradas deste workspace.',
    inputSchema: jsonSchema({ type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } } }),
    execute: async (params: Record<string, unknown>) => {
      const sessions = listPastSessions(
        ctx.sql,
        ctx.workspaceId,
        ctx.actorId,
        typeof params.limit === 'number' ? params.limit : 5,
      );
      return {
        found: sessions.length,
        sessions: sessions.map((session) => ({
          sessionId: session.id,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          messageCount: session.messageCount,
          summary: session.summary,
        })),
      };
    },
  }),

  get_session_summary: tool({
    description: 'Lê o resumo de uma sessão anterior específica (por sessionId).',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { sessionId: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['sessionId'],
    }),
    execute: async (params: Record<string, unknown>) => {
      const session = getSessionSummary(ctx.sql, ctx.workspaceId, ctx.actorId, String(params.sessionId ?? ''));
      if (!session) return { found: false, message: 'Sessão não encontrada neste workspace.' };
      return {
        found: true,
        sessionId: session.id,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        messageCount: session.messageCount,
        summary: session.summary,
      };
    },
  }),

  /**
   * Issue #99 — "esqueça isso" em DUAS etapas. Este tool só PROPÕE: resolve
   * candidatos dentro do escopo do chamador (workspace + ator + shared
   * visível, o MESMO filtro de visibilidade do recall — sem oráculo de
   * existência, cross-workspace inalcançável), persiste uma proposta pendente
   * com TTL e pergunta ao usuário. NENHUMA resolução automática exclui:
   * mesmo 1 candidato com 100% de match produz SÓ pending. A exclusão
   * acontece exclusivamente via confirmação explícita em turno posterior
   * (`confirmForgetMemory`, caminho determinístico do orquestrador).
   *
   * A busca continua automática (recall/ranking/discriminantes = discovery),
   * mas discovery NÃO é autorização. Respostas nunca carregam ids internos.
   */
  forget_memory: tool({
    description:
      'Propõe esquecer uma memória específica a pedido da pessoa ("esqueça isso", "não lembre mais disso"). Nunca apaga de imediato: se houver um alvo claro, pergunta antes de esquecer. Se houver mais de uma memória possível, peça para a pessoa especificar melhor. Nunca use para saldos ou valores atuais (isso não é memória).',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 300 } },
      required: ['query'],
    }),
    execute: async (params: Record<string, unknown>) => {
      const query = String(params.query ?? '').trim();
      if (query.length === 0) {
        return { forgot: false, message: 'Diga o que devo esquecer.' };
      }
      // Discovery, não autorização: a decisão de apagar vive na confirmação
      // posterior. Mesma visibilidade da resolução destrutiva antiga
      // (workspace + ator + shared visível), sem ranking truncado e sem
      // bookkeeping de `last_seen_at`.
      const outcome = proposeForgetMemory(ctx.sql, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        query,
        ...(ctx.intentionId ? { intentionId: ctx.intentionId } : {}),
        ...(ctx.nowMs !== undefined ? { nowMs: ctx.nowMs } : {}),
      });
      switch (outcome.outcome) {
        case 'proposed':
          return { forgot: false, proposed: true, message: outcome.message };
        case 'ambiguous':
          return { forgot: false, ambiguous: true, message: outcome.message };
        default:
          return { forgot: false, message: outcome.message };
      }
    },
  }),
});

export const MEMORY_TOOL_NAMES: readonly string[] = ['remember_fact', 'recall', 'list_past_sessions', 'get_session_summary', 'forget_memory'];
