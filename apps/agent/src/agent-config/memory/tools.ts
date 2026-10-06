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
  forgetMemory,
  listForgetCandidates,
  recallMemories,
  rememberFact,
  selectRelevantForgetCandidates,
  type MemorySql,
} from './store.js';

export type MemoryToolContext = {
  sql: MemorySql;
  workspaceId: string;
  actorId: string;
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
   * A19 — "esqueça isso". The forget path is SCOPED BY RESOLUTION: candidates
   * come from `listForgetCandidates` (the caller's workspace + actor + visible
   * shared layer, exactly the recall visibility), so another actor's PRIVATE
   * memory is indistinguishable from a nonexistent one (no existence oracle),
   * and another workspace is out of reach structurally. Forgetting applies
   * invalidate + derivedFrom cascade + a tombstone the learning job consults
   * (AC26b). Responses never carry internal ids.
   *
   * Ranking is NOT authorization (post-merge closure, issue #91): recall is a
   * context ranking that returns unrelated items when nothing better exists, so
   * `selectRelevantForgetCandidates` decides which candidates are PLAUSIBLE
   * TARGETS. Zero relevant ⇒ nothing is touched (an irrelevant lone memory
   * must never be deleted just for ranking first); two or more ⇒ the ambiguity
   * count is the number of RELEVANT memories, not of ranked candidates.
   *
   * Ranking is also NOT the candidate set (review round 2, P1-1): recall
   * truncates to a context budget BEFORE relevance, so a plausible target below
   * the cut makes a real ambiguity look unique — and a unique-looking request
   * deletes. Uniqueness for a destructive operation is proven over the whole
   * visible scope, never over the top-N.
   */
  forget_memory: tool({
    description:
      'Esquece uma memória específica a pedido da pessoa ("esqueça isso", "não lembre mais disso"). Busca pela consulta; se houver mais de uma memória possível, peça para a pessoa especificar melhor. Nunca use para saldos ou valores atuais (isso não é memória).',
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
      // Candidates come from the DESTUCTIVE resolution, not from recall: same
      // visibility (workspace + actor + visible shared layer), but no ranking and
      // no `limit` — the ambiguity that authorizes a deletion must be counted
      // over every visible memory, not over a truncated context slice (issue
      // #91 review round 2). No `last_seen_at` bookkeeping either.
      const candidates = listForgetCandidates(ctx.sql, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actorId,
      });
      const relevant = selectRelevantForgetCandidates(candidates, query);
      if (relevant.length === 0) {
        return { forgot: false, message: 'Não encontrei uma memória claramente correspondente.' };
      }
      if (relevant.length > 1) {
        return {
          forgot: false,
          ambiguous: true,
          message: `Encontrei ${relevant.length} memórias parecidas com isso. Especifique melhor qual devo esquecer.`,
        };
      }
      const target = relevant[0]!;
      const { invalidated, cascaded } = forgetMemory(ctx.sql, {
        workspaceId: ctx.workspaceId,
        id: target.id,
      });
      if (invalidated.length === 0) {
        return { forgot: false, message: 'Não consegui esquecer isso agora. Tente de novo.' };
      }
      return {
        forgot: true,
        cascaded: cascaded.length,
        message: cascaded.length > 0
          ? 'Esquecido — e também o que dependia disso.'
          : 'Esquecido. Não vou lembrar mais disso.',
      };
    },
  }),
});

export const MEMORY_TOOL_NAMES: readonly string[] = ['remember_fact', 'recall', 'list_past_sessions', 'get_session_summary', 'forget_memory'];
