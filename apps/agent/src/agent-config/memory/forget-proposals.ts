/**
 * Issue #99 — `forget_memory` em duas etapas.
 *
 * Decisão arquitetural: NENHUMA heurística lexical autoriza exclusão. A
 * busca (recall/ranking/discriminantes) é só DISCOVERY; a AUTORIZAÇÃO é a
 * confirmação explícita do usuário em turno posterior, materializada como
 * proposta pendente (`agent_memory_forget_proposals`, ver store.ts).
 *
 * Fluxo:
 *   pedido → propose (discovery + persiste pending + pergunta) →
 *   turno posterior "sim" → revalida → forgetMemory() → valida → confirma.
 *
 * Este serviço é o ÚNICO caminho de decisão. O tool `forget_memory` exposto
 * ao modelo só PROPÕE (nunca deleta); confirmar/cancelar acontecem aqui,
 * chamados deterministicamente pelo orquestrador a partir do texto DIGITADO
 * (`decisionText`), nunca de dado derivado de anexo — a mesma barreira F1
 * das confirmações financeiras. Por isso NÃO existem tools de
 * confirm/cancel expostas ao modelo (SPEC §32: o requisito é o
 * comportamento, não o nome).
 *
 * Segurança (toda invariante testada):
 * - workspace-scoped + actor-scoped em TODA leitura/escrita/CAS;
 * - sem IDs internos na UX (só preview humano);
 * - TTL 10 min (convenção `undo_proposals`), expiração preguiçosa;
 * - idempotência por intentionId (redelivery) + CAS (concorrência: uma
 *   vencedora, as demais observam o estado final);
 * - revalidação pré-delete (status/TTL/vínculo + memória viva + hash);
 * - cancel/supersede terminais: "sim" posterior não reanima;
 * - learning: turnos de proposta/confirmação/cancel/falha NÃO ensinam
 *   (ver `isForgetManagementTurn`, consumido por learn.ts).
 */

import { randomUUID } from 'node:crypto';
import {
  casForgetProposalStatus,
  extractForgetQueryDiscriminators,
  findForgetDecision,
  forgetContentHash,
  FORGET_PROPOSAL_TTL_MS,
  forgetMemory,
  getForgetProposal,
  insertForgetProposal,
  isUnpublishedForgetExpiry,
  listActiveForgetProposals,
  listForgetCandidates,
  listForgetProposalsForActor,
  makeForgetPreview,
  markForgetProposalExpired,
  recordForgetDecision,
  selectRelevantForgetCandidates,
  supersedeActiveForgetProposals,
  type ForgetDecisionOutcome,
  type ForgetProposalRecord,
  type MemorySql,
} from './store.js';

export type ForgetAuditEmit = (eventType: string, fields: Record<string, unknown>) => void;
const noopAudit: ForgetAuditEmit = () => undefined;

const fold = (value: string): string =>
  (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Pedido de esquecimento: imperativo de esquecer SEM negação-lembrete. */
const FORGET_REQUEST_RE =
  /\b(esqueca|esquece|esquecer|apague|apagar|remova|remover|exclua|excluir|limpe|limpar|deslembre|forget)\b/;
/** "não esqueça" / "lembre-se" / "guarde" = pedido de LEMBRAR, nunca de esquecer. */
const REMEMBER_COUNTERPART_RE =
  /\b(n[aã]o|nunca|jamais)\s+(esque[cç]a|esquece|apague)\b|\b(lembre[\s-]*se|lembrete|guarde|memorize|n[aã]o\s+esque[cç]a)\b/;

export const isForgetRequestText = (typedText: string): boolean => {
  const text = fold(typedText);
  if (!text || text.length > 300) return false;
  if (REMEMBER_COUNTERPART_RE.test(text)) return false;
  return FORGET_REQUEST_RE.test(text);
};

/**
 * Confirmação explícita em turno posterior — SÓ afirmação fechada e curta.
 * Textos longos caem no fluxo LLM (que só pode propor, nunca deletar).
 *
 * O imperativo SOZINHO ("esqueça", "apague") é PEDIDO (mensagem fragmentada
 * §10: "esqueça" → pede o alvo), NUNCA confirmação. Curingas (`pode.*`)
 * são proibidos: "sim, pode não apagar" e "confirmado, pode cancelar" NÃO
 * confirmam (review #99: negação/cancelamento nunca autoriza exclusão).
 */
const FORGET_CONFIRM_RE =
  /^(sim|confirmo|confirmado|confirmar|pode esquecer|pode apagar|pode deletar|pode confirmar|pode sim|sim, (esqueca|esquece|apague|apaga|confirmo))$/;

/** Qualquer negação/cancelamento no texto veta a confirmação. */
const FORGET_NEGATION_RE = /\b(n[aã]o|nunca|jamais|cancel|desist|deixa|melhor n[aã]o)\b/;

export const isForgetConfirmationText = (typedText: string): boolean => {
  const text = fold(typedText);
  if (!text || text.length > 80) return false;
  if (FORGET_NEGATION_RE.test(text)) return false;
  return FORGET_CONFIRM_RE.test(text);
};

const FORGET_CANCEL_RE =
  /^(nao|não|n[aã]o quero|nao quero|cancela|cancelar|cancelado|deixa pra la|deixa pra lá|melhor nao|melhor não|n[aã]o esqueca|nao esqueca|n[aã]o apague|nao apague|esquece nao|esquece não|para|para ai|para aí|stop)$/;

export const isForgetCancellationText = (typedText: string): boolean => {
  const text = fold(typedText);
  if (!text || text.length > 80) return false;
  return FORGET_CANCEL_RE.test(text);
};

/** Copy curta e sem IDs — o usuário nunca vê memoryId/hash/workspace/actor. */
export const renderForgetProposalQuestion = (preview: string): string =>
  `Encontrei esta memória:\n"${preview}"\n\nQuer que eu a esqueça?`;

export const FORGET_COPY = {
  needsSpecifics:
    'Diga mais especificamente o que devo esquecer — por exemplo, o nome do banco, cartão ou categoria.',
  notFound: 'Não encontrei uma memória claramente correspondente.',
  executed: (cascaded: number): string =>
    cascaded > 0
      ? 'Pronto, esqueci essa memória — e também o que dependia dela.'
      : 'Pronto, esqueci essa memória.',
  cancelled: 'Tudo bem, não esqueci nada.',
  noPending: 'Não há nenhuma confirmação de esquecimento pendente.',
  multiplePending:
    'Há mais de uma proposta de esquecimento pendente. Diga exatamente qual memória devo esquecer.',
  expired: 'A proposta de esquecimento expirou. Se ainda quiser, peça de novo.',
  changed: 'Essa memória mudou ou não está mais disponível. Não apaguei nada.',
  alreadyDone: 'Isso já foi esquecido.',
  failed: 'Não consegui esquecer isso agora. Tente de novo.',
  ambiguous: (count: number): string =>
    `Encontrei ${count} memórias parecidas com isso. Especifique melhor qual devo esquecer.`,
} as const;

export type ProposeForgetOutcome =
  | Readonly<{ outcome: 'proposed'; proposal: ForgetProposalRecord; message: string }>
  | Readonly<{ outcome: 'needs_specifics'; message: string }>
  | Readonly<{ outcome: 'not_found'; message: string }>
  | Readonly<{ outcome: 'ambiguous'; count: number; message: string }>
  | Readonly<{ outcome: 'already_handled'; message: string }>;

export type ConfirmForgetOutcome =
  | Readonly<{ outcome: 'executed'; cascaded: number; message: string }>
  | Readonly<{ outcome: 'already_done'; message: string }>
  | Readonly<{ outcome: 'none'; message: string }>
  | Readonly<{ outcome: 'expired'; message: string }>
  | Readonly<{ outcome: 'ambiguous'; message: string }>
  | Readonly<{ outcome: 'revalidation_failed'; message: string }>
  | Readonly<{ outcome: 'failed'; message: string }>;

export type CancelForgetOutcome =
  | Readonly<{ outcome: 'cancelled'; message: string }>
  | Readonly<{ outcome: 'none'; message: string }>
  | Readonly<{ outcome: 'ambiguous'; message: string }>;

export type ForgetIdentity = Readonly<{ workspaceId: string; actorId: string }>;

const auditBase = (identity: ForgetIdentity, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: identity.workspaceId,
  actorId: identity.actorId,
  ...extra,
});

const readResultJson = (proposal: ForgetProposalRecord): Record<string, unknown> => {
  if (!proposal.resultJson) return {};
  try {
    return JSON.parse(proposal.resultJson) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Discovery (recall/ranking/discriminantes servem SÓ para localizar) +
 * persistência da proposta. NUNCA deleta. Nova solicitação substitui a
 * anterior (§22): pendings ativos do vínculo viram `superseded`.
 *
 * Dedupe por intenção (§7.7/§40): redelivery do MESMO pedido (mesmo
 * intentionId) nunca cria, renova ou supersede — reproduz o estado: pending
 * ativo da mesma intenção ⇒ mesma pergunta; terminal ⇒ mensagem honesta do
 * estado final. Registros publish_failed são invisíveis (o turno nunca foi
 * publicado: redelivery re-propõe do zero).
 */
export const proposeForgetMemory = (
  sql: MemorySql,
  input: ForgetIdentity & { query: string; intentionId?: string; nowMs?: number; emit?: ForgetAuditEmit },
): ProposeForgetOutcome => {
  const emit = input.emit ?? noopAudit;
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const query = (input.query ?? '').trim();
  if (!query) return { outcome: 'needs_specifics', message: FORGET_COPY.needsSpecifics };

  const intentionId = input.intentionId ?? '';
  if (intentionId) {
    const prior = listForgetProposalsForActor(sql, input).filter(
      (p) => p.sourceIntentionId === intentionId && !isUnpublishedForgetExpiry(p),
    );
    const activePrior = prior.find((p) => p.status === 'pending' && p.expiresAt > nowIso);
    if (activePrior) {
      return { outcome: 'proposed', proposal: activePrior, message: renderForgetProposalQuestion(activePrior.memoryPreview) };
    }
    if (prior.length > 0) {
      const executed = prior.some((p) => p.status === 'executed' || p.status === 'confirmed');
      return {
        outcome: 'already_handled',
        message: executed ? FORGET_COPY.alreadyDone : FORGET_COPY.noPending,
      };
    }
  }

  const candidates = listForgetCandidates(sql, { workspaceId: input.workspaceId, actor: input.actorId });
  const relevant = selectRelevantForgetCandidates(candidates, query);
  if (relevant.length === 0) {
    if (extractForgetQueryDiscriminators(query).size === 0) {
      return { outcome: 'needs_specifics', message: FORGET_COPY.needsSpecifics };
    }
    return { outcome: 'not_found', message: FORGET_COPY.notFound };
  }
  if (relevant.length > 1) {
    return { outcome: 'ambiguous', count: relevant.length, message: FORGET_COPY.ambiguous(relevant.length) };
  }

  const target = relevant[0]!;
  supersedeActiveForgetProposals(sql, input, nowIso);
  const record: ForgetProposalRecord = Object.freeze({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    memoryId: target.id,
    contentHash: forgetContentHash(target.content),
    memoryPreview: makeForgetPreview(target.content),
    sourceIntentionId: input.intentionId ?? '',
    status: 'pending' as const,
    createdAt: nowIso,
    expiresAt: new Date(nowMs + FORGET_PROPOSAL_TTL_MS).toISOString(),
  });
  insertForgetProposal(sql, record);
  emit('forget.proposed', auditBase(input, { memoryId: target.id, contentHash: record.contentHash }));
  return { outcome: 'proposed', proposal: record, message: renderForgetProposalQuestion(record.memoryPreview) };
};

const findTerminalByIntention = (
  sql: MemorySql,
  identity: ForgetIdentity,
  intentionId: string,
): ForgetProposalRecord | undefined => {
  if (!intentionId) return undefined;
  for (const proposal of listForgetProposalsForActor(sql, identity)) {
    // Só `executed` é evidência de efeito: `confirmed` sem execução é claim
    // intermediária — falha entre claim e delete libera o claim de volta
    // para `pending`, nunca vira sucesso em replay.
    if (proposal.status !== 'executed') continue;
    const result = readResultJson(proposal);
    if (result['intentionId'] === intentionId) return proposal;
  }
  return undefined;
};

const latestTerminal = (
  sql: MemorySql,
  identity: ForgetIdentity,
  nowMs: number,
  withinMs: number = 5 * 60 * 1000,
): ForgetProposalRecord | undefined => {
  const cutoff = new Date(nowMs - withinMs).toISOString();
  let latest: ForgetProposalRecord | undefined;
  for (const proposal of listForgetProposalsForActor(sql, identity)) {
    if (proposal.status !== 'executed') continue;
    if ((proposal.decidedAt ?? '') < cutoff) continue;
    if (!latest || (proposal.decidedAt ?? '') > (latest.decidedAt ?? '')) latest = proposal;
  }
  return latest;
};

/** Expiração por TTL recente (resposta honesta §21, nunca execução). */
const findRecentTtlExpiry = (
  sql: MemorySql,
  identity: ForgetIdentity,
  nowMs: number,
  withinMs: number = 15 * 60 * 1000,
): ForgetProposalRecord | undefined => {
  const cutoff = new Date(nowMs - withinMs).toISOString();
  let latest: ForgetProposalRecord | undefined;
  for (const proposal of listForgetProposalsForActor(sql, identity)) {
    if (proposal.status !== 'expired') continue;
    if (readResultJson(proposal)['reason'] !== 'ttl') continue;
    if ((proposal.decidedAt ?? '') < cutoff) continue;
    if (!latest || (proposal.decidedAt ?? '') > (latest.decidedAt ?? '')) latest = proposal;
  }
  return latest;
};

/**
 * Confirmação em turno posterior: exige EXATAMENTE 1 pending válido,
 * revalida tudo (status/TTL/vínculo + memória viva + hash) e só então
 * executa `forgetMemory()` + valida o pós-estado. Qualquer falha = NO DELETE.
 *
 * Vínculo de consumo: o turno de decisão é consumido UMA vez — redelivery da
 * MESMA intenção nunca re-resolve contra pendings posteriores (reproduz o
 * outcome registrado). Só `executed` é evidência de efeito; claim sem
 * execução verificada libera o claim (`pending`) em vez de virar sucesso.
 */
export const confirmForgetMemory = (
  sql: MemorySql,
  input: ForgetIdentity & { intentionId?: string; nowMs?: number; emit?: ForgetAuditEmit },
): ConfirmForgetOutcome => {
  const emit = input.emit ?? noopAudit;
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const intentionId = input.intentionId ?? '';

  // Idempotência por intentionId (§19): redelivery do MESMO turno converge
  // para "já concluído", nunca para nova mutação. O consumo é registrado
  // (recibo): observar execução anterior também consome o turno — replay
  // nunca re-resolve contra pendings posteriores.
  if (intentionId && findTerminalByIntention(sql, input, intentionId)) {
    if (intentionId) recordForgetDecision(sql, { ...input, intentionId, outcome: 'already_done', createdAt: nowIso });
    return { outcome: 'already_done', message: FORGET_COPY.alreadyDone };
  }
  // Turno de decisão já consumido sem executar: reproduz o outcome, sem
  // tocar em pendings posteriores.
  if (intentionId) {
    const prior = findForgetDecision(sql, { workspaceId: input.workspaceId, actorId: input.actorId, intentionId }, nowMs);
    // Recibo compartilhado com o cancelamento: 'cancelled' aqui significa
    // "este turno não executou nada" → none (nunca autoriza).
    if (prior && prior !== 'cancelled') return { outcome: prior, message: decisionOutcomeMessage(prior) };
    if (prior) return { outcome: 'none', message: FORGET_COPY.noPending };
  }

  const fail = (outcome: Exclude<ForgetDecisionOutcome, 'cancelled'>, message: string): ConfirmForgetOutcome => {
    if (intentionId) recordForgetDecision(sql, { ...input, intentionId, outcome, createdAt: nowIso });
    return { outcome, message } as ConfirmForgetOutcome;
  };

  const active = listActiveForgetProposals(sql, input, nowMs);
  if (active.length === 0) {
    // Corrida perdida (§34): a vencedora acabou de executar — o perdedor
    // observa o estado final em vez de alegar "nada pendente". A observação
    // consome o turno (recibo): replay não re-resolve contra o futuro.
    const recent = latestTerminal(sql, input, nowMs);
    if (recent) {
      emit('forget.confirmed', auditBase(input, { observed: true, memoryId: recent.memoryId }));
      if (intentionId) recordForgetDecision(sql, { ...input, intentionId, outcome: 'already_done', createdAt: nowIso });
      return { outcome: 'already_done', message: FORGET_COPY.alreadyDone };
    }
    // TTL vencido (§21): "sim" não executa, mas a resposta distingue
    // expiração real de ausência de proposta.
    if (findRecentTtlExpiry(sql, input, nowMs)) {
      return fail('expired', FORGET_COPY.expired);
    }
    return fail('none', FORGET_COPY.noPending);
  }
  if (active.length > 1) {
    emit('forget.revalidation_failed', auditBase(input, { reason: 'multiple_active' }));
    return fail('ambiguous', FORGET_COPY.multiplePending);
  }

  const proposal = active[0]!;
  // Revalidação §17: a memória precisa existir, viva e idêntica — visível
  // pelo MESMO filtro de escopo da resolução (sem oráculo cross-actor).
  const current = listForgetCandidates(sql, { workspaceId: input.workspaceId, actor: input.actorId }).find(
    (item) => item.id === proposal.memoryId,
  );
  if (!current) {
    markForgetProposalExpired(sql, proposal.id, nowIso, 'revalidation_failed');
    emit('forget.revalidation_failed', auditBase(input, { reason: 'target_gone', memoryId: proposal.memoryId }));
    emit('forget.expired', auditBase(input, { memoryId: proposal.memoryId }));
    return fail('revalidation_failed', FORGET_COPY.changed);
  }
  if (forgetContentHash(current.content) !== proposal.contentHash) {
    markForgetProposalExpired(sql, proposal.id, nowIso, 'revalidation_failed');
    emit('forget.revalidation_failed', auditBase(input, { reason: 'hash_mismatch', memoryId: proposal.memoryId }));
    emit('forget.expired', auditBase(input, { memoryId: proposal.memoryId }));
    return fail('revalidation_failed', FORGET_COPY.changed);
  }

  // Claim atômico pending→confirmed: UMA vencedora; a perdedora cai no
  // already_done/none acima na releitura (nunca duplo delete).
  const resultJson = JSON.stringify({ intentionId, cascaded: 0 });
  const claimed = casForgetProposalStatus(sql, {
    id: proposal.id,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    from: 'pending',
    to: 'confirmed',
    decidedAt: nowIso,
    resultJson,
  });
  if (!claimed) {
    const reread = getForgetProposal(sql, proposal.id);
    if (reread && reread.status === 'executed') {
      if (intentionId) recordForgetDecision(sql, { ...input, intentionId, outcome: 'already_done', createdAt: nowIso });
      return { outcome: 'already_done', message: FORGET_COPY.alreadyDone };
    }
    emit('forget.revalidation_failed', auditBase(input, { reason: 'claim_lost', memoryId: proposal.memoryId }));
    return fail('none', FORGET_COPY.noPending);
  }
  emit('forget.confirmed', auditBase(input, { memoryId: proposal.memoryId }));

  // Execução guardada: qualquer falha libera o claim de volta para `pending`
  // (nova confirmação pode repetir); replay da MESMA intenção encontra o
  // recibo `failed` registrado abaixo — nunca "já foi esquecido".
  const releaseClaim = (reason: string): void => {
    try {
      casForgetProposalStatus(sql, {
        id: proposal.id,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        from: 'confirmed',
        to: 'pending',
        decidedAt: new Date().toISOString(),
        resultJson: JSON.stringify({ intentionId, reason }),
      });
    } catch {
      // Best-effort: o estado `confirmed` travado é o residual documentado.
    }
    emit('forget.revalidation_failed', auditBase(input, { reason, memoryId: proposal.memoryId }));
  };
  let invalidated: string[] = [];
  let cascaded: string[] = [];
  try {
    const result = forgetMemory(sql, { workspaceId: input.workspaceId, id: proposal.memoryId });
    invalidated = result.invalidated;
    cascaded = result.cascaded;
  } catch {
    releaseClaim('execution_error');
    return fail('failed', FORGET_COPY.failed);
  }
  if (invalidated.length === 0) {
    releaseClaim('delete_noop');
    return fail('failed', FORGET_COPY.failed);
  }
  // Pós-validação §41: o alvo não pode continuar visível.
  const stillVisible = listForgetCandidates(sql, { workspaceId: input.workspaceId, actor: input.actorId }).some(
    (item) => item.id === proposal.memoryId,
  );
  if (stillVisible) {
    releaseClaim('post_state');
    return fail('failed', FORGET_COPY.failed);
  }

  casForgetProposalStatus(sql, {
    id: proposal.id,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    from: 'confirmed',
    to: 'executed',
    decidedAt: new Date().toISOString(),
    resultJson: JSON.stringify({ intentionId, cascaded: cascaded.length }),
  });
  emit('forget.executed', auditBase(input, { memoryId: proposal.memoryId, contentHash: proposal.contentHash }));
  return { outcome: 'executed', cascaded: cascaded.length, message: FORGET_COPY.executed(cascaded.length) };
};

const decisionOutcomeMessage = (outcome: ForgetDecisionOutcome): string => {
  switch (outcome) {
    case 'expired': return FORGET_COPY.expired;
    case 'ambiguous': return FORGET_COPY.multiplePending;
    case 'revalidation_failed': return FORGET_COPY.changed;
    case 'failed': return FORGET_COPY.failed;
    case 'cancelled': return FORGET_COPY.cancelled;
    case 'already_done': return FORGET_COPY.alreadyDone;
    default: return FORGET_COPY.noPending;
  }
};

export const cancelForgetMemory = (
  sql: MemorySql,
  input: ForgetIdentity & { intentionId?: string; nowMs?: number; emit?: ForgetAuditEmit },
): CancelForgetOutcome => {
  const emit = input.emit ?? noopAudit;
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const intentionId = input.intentionId ?? '';

  // Turno de cancelamento já consumido: reproduz sem tocar em pendings
  // posteriores (redelivery nunca cancela proposta nova).
  if (intentionId) {
    const prior = findForgetDecision(sql, { workspaceId: input.workspaceId, actorId: input.actorId, intentionId }, nowMs);
    if (prior) {
      const message = prior === 'cancelled' ? FORGET_COPY.cancelled : decisionOutcomeMessage(prior);
      return { outcome: prior === 'cancelled' ? 'cancelled' : 'none', message };
    }
  }
  const record = (outcome: 'none' | 'ambiguous' | 'cancelled'): void => {
    if (intentionId) {
      recordForgetDecision(sql, { workspaceId: input.workspaceId, actorId: input.actorId, intentionId, outcome, createdAt: nowIso });
    }
  };

  const active = listActiveForgetProposals(sql, input, nowMs);
  if (active.length === 0) {
    record('none');
    return { outcome: 'none', message: FORGET_COPY.noPending };
  }
  if (active.length > 1) {
    emit('forget.revalidation_failed', auditBase(input, { reason: 'multiple_active_cancel' }));
    record('ambiguous');
    return { outcome: 'ambiguous', message: FORGET_COPY.multiplePending };
  }
  const proposal = active[0]!;
  const cancelled = casForgetProposalStatus(sql, {
    id: proposal.id,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    from: 'pending',
    to: 'cancelled',
    decidedAt: nowIso,
    resultJson: JSON.stringify({ reason: 'user_cancel', intentionId }),
  });
  if (!cancelled) return { outcome: 'none', message: FORGET_COPY.noPending };
  emit('forget.cancelled', auditBase(input, { memoryId: proposal.memoryId }));
  if (intentionId) recordForgetDecision(sql, { ...input, intentionId, outcome: 'cancelled', createdAt: nowIso });
  return { outcome: 'cancelled', message: FORGET_COPY.cancelled };
};

/**
 * Learning §30: turnos de proposta/confirmação/cancelamento/falha do fluxo
 * de forget obedecem à mesma filosofia da A17 — intenção mutacional só
 * aprende com evidência materializada válida. Na dúvida: não ensina.
 * (Heurística textual sobre os dois lados do turno; o executor de learning
 * chama isto antes de extrair qualquer candidato.)
 */
export const isForgetManagementTurn = (userText: string, assistantText: string): boolean => {
  const user = fold(userText);
  const assistant = fold(assistantText);
  if (!user && !assistant) return false;
  if (isForgetRequestText(user)) return true;
  if (isForgetConfirmationText(user) || isForgetCancellationText(user)) return true;
  if (assistant.includes('quer que eu a esqueca') || assistant.includes('pronto, esqueci essa memoria')) return true;
  if (assistant.includes('nao encontrei uma memoria') || assistant.includes('especifique melhor qual devo esquecer')) return true;
  if (assistant.includes('tudo bem, nao esqueci nada') || assistant.includes('nenhuma confirma') || assistant.includes('proposta de esquecimento expirou')) return true;
  if (assistant.includes('mudou ou nao esta mais disponivel') || assistant.includes('isso ja foi esquecido')) return true;
  return false;
};
