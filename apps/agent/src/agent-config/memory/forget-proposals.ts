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
  ensureForgetBinding,
  extractForgetQueryDiscriminators,
  findForgetDecision,
  findForgetDecisionRow,
  forgetContentHash,
  FORGET_PROPOSAL_TTL_MS,
  forgetMemoryInTransaction,
  getForgetBinding,
  getForgetProposal,
  insertForgetProposal,
  isUnpublishedForgetExpiry,
  listActiveForgetProposals,
  listForgetCandidates,
  listForgetProposalsForActor,
  makeForgetPreview,
  markForgetProposalExpired,
  recordForgetDecision,
  runMemoryTransaction,
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
 * Issue #102 — escrita de recibo FORA de transação é best-effort: a fonte da
 * verdade do `executed` é o terminal da proposta + intentionId
 * (`findTerminalByIntention`); o recibo é hint de replay. Se o storage
 * rejeita o recibo, o estado destrutivo já está seguro (rollback ou terminal
 * não-destrutivo) e repetir a MESMA intenção continua seguro — engolir o
 * erro aqui nunca autoriza delete. Dentro da transação o recibo é estrito
 * (faz parte do COMMIT).
 */
const recordDecisionBestEffort = (
  sql: MemorySql,
  input: { workspaceId: string; actorId: string; intentionId: string; outcome: ForgetDecisionOutcome; createdAt: string; nowMs: number; proposalId?: string | null },
): void => {
  try {
    recordForgetDecision(sql, input);
  } catch {
    // Best-effort fora da transação (ver acima).
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
      // Issue #102 — só `executed` é evidência de efeito: `confirmed` sem
      // execução verificada (órfão legado de crash pré-transacional) nunca
      // vira "já foi esquecido" em replay.
      const executed = prior.some((p) => p.status === 'executed');
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
  // Issue #102 §23 — supersede da anterior + inserção da nova na MESMA
  // transação: falha no meio nunca deixa `old superseded + new ausente`.
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
  runMemoryTransaction(sql, () => {
    supersedeActiveForgetProposals(sql, input, nowIso);
    insertForgetProposal(sql, record);
  });
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
 * Issue #102 — erro terminal DENTRO da transação confirmada. Qualquer throw
 * aborta `runMemoryTransaction` com ROLLBACK total (nada apagado, proposta de
 * volta a estado seguro); o chamador traduz em outcome + recibo FORA da
 * transação (o recibo de falha não pode ser desfeito pelo rollback).
 */
export class ForgetTransactionError extends Error {
  readonly outcome: 'none' | 'expired' | 'ambiguous' | 'revalidation_failed' | 'failed';
  constructor(outcome: ForgetTransactionError['outcome'], message: string) {
    super(message);
    this.name = 'ForgetTransactionError';
    this.outcome = outcome;
  }
}

export type ConfirmedForgetResult = Readonly<{ cascaded: number }>;

/**
 * Issue #102 (P1) — operação autoritativa da execução confirmada. Encapsula
 * na MESMA transação SQLite: revalidação final + claim `pending→confirmed` +
 * invalidação do alvo + cascade + transição terminal `confirmed→executed` +
 * recibo de decisão. Sucesso = COMMIT total; qualquer falha = ROLLBACK
 * total. Invariante: ou tudo acontece, ou nada acontece — nunca estado
 * intermediário (alvo apagado com UX de falha, cascade parcial, claim
 * travado, `executed` sem recibo).
 *
 * Não-aninhável: `forgetMemoryInTransaction` e os CAS participam da
 * transação externa via `exec` cru (o depth-guard de `runMemoryTransaction`
 * impede nesting no primitivo do DO).
 */
export const executeConfirmedForgetTransaction = (
  sql: MemorySql,
  input: ForgetIdentity & { proposalId: string; intentionId: string; nowMs: number },
): ConfirmedForgetResult => {
  try {
    return runMemoryTransaction(sql, () => {
    const nowIso = new Date(input.nowMs).toISOString();
    // 1. Leitura autoritativa do pending (vínculo exato, sem oráculo).
    const proposal = getForgetProposal(sql, input.proposalId);
    if (!proposal || proposal.workspaceId !== input.workspaceId || proposal.actorId !== input.actorId) {
      throw new ForgetTransactionError('none', FORGET_COPY.noPending);
    }
    if (proposal.status !== 'pending') {
      throw new ForgetTransactionError('none', proposal.status === 'executed' ? FORGET_COPY.alreadyDone : FORGET_COPY.noPending);
    }
    if (proposal.expiresAt <= nowIso) {
      throw new ForgetTransactionError('expired', FORGET_COPY.expired);
    }
    // 2. Revalidação §17: a memória precisa existir, viva e idêntica —
    // visível pelo MESMO filtro de escopo da resolução (sem oráculo
    // cross-actor). Só leitura aqui; a marcação `expired` acontece fora da
    // transação (não pode ser desfeita pelo rollback que ela mesma causaria).
    const current = listForgetCandidates(sql, { workspaceId: input.workspaceId, actor: input.actorId }).find(
      (item) => item.id === proposal.memoryId,
    );
    if (!current) {
      throw new ForgetTransactionError('revalidation_failed', FORGET_COPY.changed);
    }
    if (forgetContentHash(current.content) !== proposal.contentHash) {
      throw new ForgetTransactionError('revalidation_failed', FORGET_COPY.changed);
    }
    // 3. Claim atômico pending→confirmed: UMA vencedora (CAS com autoria).
    const resultJson = JSON.stringify({ intentionId: input.intentionId, cascaded: 0 });
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
      throw new ForgetTransactionError('none', FORGET_COPY.noPending);
    }
    // 4. Invalidação do alvo + cascade (participam desta transação).
    const { invalidated, cascaded } = forgetMemoryInTransaction(sql, {
      workspaceId: input.workspaceId,
      id: proposal.memoryId,
    });
    if (invalidated.length === 0) {
      throw new ForgetTransactionError('failed', FORGET_COPY.failed);
    }
    // 5. Pós-validação §41: o alvo não pode continuar visível.
    const stillVisible = listForgetCandidates(sql, { workspaceId: input.workspaceId, actor: input.actorId }).some(
      (item) => item.id === proposal.memoryId,
    );
    if (stillVisible) {
      throw new ForgetTransactionError('failed', FORGET_COPY.failed);
    }
    // 6. Transição terminal + recibo na MESMA transação: o COMMIT os persiste
    // juntos. O recibo representa o CONSUMO da intenção de decisão (replay
    // observa `already_done` sem mutar — §27/§28).
    const done = casForgetProposalStatus(sql, {
      id: proposal.id,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      from: 'confirmed',
      to: 'executed',
      decidedAt: nowIso,
      resultJson: JSON.stringify({ intentionId: input.intentionId, cascaded: cascaded.length }),
    });
    if (!done) {
      throw new ForgetTransactionError('failed', FORGET_COPY.failed);
    }
    recordForgetDecision(sql, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      intentionId: input.intentionId,
      outcome: 'already_done',
      createdAt: nowIso,
      nowMs: input.nowMs,
      proposalId: input.proposalId,
    });
    return { cascaded: cascaded.length };
    });
  } catch (err) {
    // Falha NÃO-terminal (SQLite, cascade, CAS inesperado): o ROLLBACK já
    // restaurou tudo — traduz em terminal `failed` para o recibo fail-closed.
    if (err instanceof ForgetTransactionError) throw err;
    throw new ForgetTransactionError('failed', FORGET_COPY.failed);
  }
};

/**
 * Confirmação em turno posterior: exige EXATAMENTE 1 pending válido e delega
 * a execução a `executeConfirmedForgetTransaction` (fronteira ACID §6:
 * COMMIT total ou ROLLBACK total). Qualquer falha = NO DELETE.
 *
 * Vínculo de consumo: o turno de decisão é consumido UMA vez — redelivery da
 * MESMA intenção nunca re-resolve contra pendings posteriores (reproduz o
 * outcome registrado). Só `executed` é evidência de efeito; falha com
 * rollback restaura `pending` (nova confirmação com NOVA intenção pode
 * repetir; a MESMA intenção encontra o recibo `failed`).
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
    if (intentionId) recordDecisionBestEffort(sql, { ...input, intentionId, outcome: 'already_done', createdAt: nowIso, nowMs });
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
    // Issue #102 — consumo permanente: a confirmação autoriza UM preview
    // específico, então redelivery NUNCA re-resolve contra pendings
    // posteriores. Barras (nesta ordem, todas sem writes):
    // 1. vínculo na tabela própria (qualquer valor, incl. sentinela '');
    // 2. recibo físico — QUALQUER linha, inclusive `proposal_id` NULL
    //    pré-closure: após o TTL, o reuse do mesmo intentionId é redelivery
    //    (turno novo = messageId novo), nunca decisão nova; reproduz o
    //    consumo em vez de resolver. Livre só quem nunca foi consumido
    //    (sem linha e sem vínculo).
    const bound = getForgetBinding(sql, { workspaceId: input.workspaceId, actorId: input.actorId, intentionId });
    const physical = findForgetDecisionRow(sql, { workspaceId: input.workspaceId, actorId: input.actorId, intentionId });
    if (bound !== undefined || physical) {
      if (physical) {
        if (physical.outcome === 'cancelled') return { outcome: 'none', message: FORGET_COPY.noPending };
        return { outcome: physical.outcome, message: decisionOutcomeMessage(physical.outcome) } as ConfirmForgetOutcome;
      }
      return { outcome: 'failed', message: FORGET_COPY.failed };
    }
  }

  // Proposta vinculada a esta intenção quando a resolução alcança UMA
  // proposta (o recibo carrega o vínculo mesmo em falha — redelivery futuro
  // encontra o alvo original, nunca um pending posterior). NULL = sem alvo
  // único ainda (none/ambiguous): o fail() vincula ao sentinela ''.
  let boundProposalId: string | null = null;
  const fail = (outcome: Exclude<ForgetDecisionOutcome, 'cancelled'>, message: string): ConfirmForgetOutcome => {
    if (intentionId) {
      if (boundProposalId == null) {
        // Consumo sem alvo único: vincula ao sentinela para que redelivery
        // futuro recuse em vez de resolver contra pending posterior.
        // Best-effort: falha aqui = storage quebrado = nenhum pending novo
        // possível no mesmo motor (residual documentado).
        try {
          ensureForgetBinding(sql, { ...input, intentionId, proposalId: '', createdAt: nowIso });
        } catch {
          // Sem vínculo: fail-closed abaixo sem autorizar nada.
        }
      }
      // Round 4: o recibo carrega o sentinela '' (distinto de NULL pré-closure):
      // o fallback de barreira distingue "vinculado a nada" (recusa) de
      // "nunca vinculado" (renewal §15-A livre).
      recordDecisionBestEffort(sql, { ...input, intentionId, outcome, createdAt: nowIso, nowMs, proposalId: boundProposalId ?? '' });
    }
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
      if (intentionId) {
        // Round 4: observar execução alheia também consome PERMANENTEMENTE —
        // vincula à proposta observada, senão o replay vencido resolveria
        // contra um pending posterior sem nunca ter confirmado aquele preview.
        try {
          ensureForgetBinding(sql, { ...input, intentionId, proposalId: recent.id, createdAt: nowIso });
        } catch {
          // Sem vínculo: fail-closed abaixo sem autorizar nada.
        }
        recordDecisionBestEffort(sql, { ...input, intentionId, outcome: 'already_done', createdAt: nowIso, nowMs, proposalId: recent.id });
      }
      return { outcome: 'already_done', message: FORGET_COPY.alreadyDone };
    }
    // TTL vencido (§21): "sim" não executa, mas a resposta distingue
    // expiração real de ausência de proposta. Vincula a intenção à proposta
    // expirada resolvida: redelivery futuro nunca opera sobre pending
    // posterior (review rodada 2). Sem vínculo aqui, o reuse expirado
    // re-resolveria e apagaria o alvo novo.
    const ttlExpired = findRecentTtlExpiry(sql, input, nowMs);
    if (ttlExpired) {
      if (intentionId) {
        try {
          ensureForgetBinding(sql, { ...input, intentionId, proposalId: ttlExpired.id, createdAt: nowIso });
        } catch {
          // Sem vínculo: fail-closed abaixo sem autorizar nada (o recibo
          // com proposal_id abaixo continua barreira via fallback).
        }
      }
      boundProposalId = ttlExpired.id;
      return fail('expired', FORGET_COPY.expired);
    }
    return fail('none', FORGET_COPY.noPending);
  }
  if (active.length > 1) {
    emit('forget.revalidation_failed', auditBase(input, { reason: 'multiple_active' }));
    return fail('ambiguous', FORGET_COPY.multiplePending);
  }

  const proposal = active[0]!;
  // Issue #102 — vínculo PRÉ-tentativa (tabela própria, commit independente,
  // sobrevive ao rollback da execução): sem vínculo durável, sem autoridade
  // destrutiva. Falha de escrita ou vínculo com outra proposta = fail-closed.
  if (intentionId) {
    try {
      const winner = ensureForgetBinding(sql, { ...input, intentionId, proposalId: proposal.id, createdAt: nowIso });
      if (winner !== proposal.id) return fail('failed', FORGET_COPY.failed);
    } catch {
      return fail('failed', FORGET_COPY.failed);
    }
  }
  boundProposalId = proposal.id;

  // Issue #102 — fronteira ACID: revalidação + claim + delete + cascade +
  // terminal + recibo numa ÚNICA transação (COMMIT total ou ROLLBACK total).
  // Defesa em profundidade para o fallback sem transação (mocks): se o
  // rollback não cobriu um claim `confirmed` órfão, libera para `pending`.
  const releaseClaim = (reason: string): void => {
    try {
      const reread = getForgetProposal(sql, proposal.id);
      if (!reread || reread.status !== 'confirmed') return;
      casForgetProposalStatus(sql, {
        id: proposal.id,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        from: 'confirmed',
        to: 'pending',
        decidedAt: nowIso,
        resultJson: JSON.stringify({ intentionId, reason }),
      });
    } catch {
      // Best-effort: o estado `confirmed` travado é o residual documentado.
    }
    emit('forget.revalidation_failed', auditBase(input, { reason, memoryId: proposal.memoryId }));
  };

  try {
    const { cascaded } = executeConfirmedForgetTransaction(sql, {
      ...input,
      proposalId: proposal.id,
      intentionId,
      nowMs,
    });
    emit('forget.confirmed', auditBase(input, { memoryId: proposal.memoryId }));
    emit('forget.executed', auditBase(input, { memoryId: proposal.memoryId, contentHash: proposal.contentHash }));
    return { outcome: 'executed', cascaded, message: FORGET_COPY.executed(cascaded) };
  } catch (err) {
    if (!(err instanceof ForgetTransactionError)) throw err;
    if (err.outcome === 'expired') {
      markForgetProposalExpired(sql, proposal.id, nowIso, 'ttl', input);
      emit('forget.expired', auditBase(input, { memoryId: proposal.memoryId }));
      return fail('expired', FORGET_COPY.expired);
    }
    if (err.outcome === 'revalidation_failed') {
      markForgetProposalExpired(sql, proposal.id, nowIso, 'revalidation_failed', input);
      emit('forget.revalidation_failed', auditBase(input, { reason: 'target_changed', memoryId: proposal.memoryId }));
      emit('forget.expired', auditBase(input, { memoryId: proposal.memoryId }));
      return fail('revalidation_failed', FORGET_COPY.changed);
    }
    if (err.outcome === 'none') {
      const reread = getForgetProposal(sql, proposal.id);
      if (reread && reread.status === 'executed') {
        if (intentionId) recordDecisionBestEffort(sql, { ...input, intentionId, outcome: 'already_done', createdAt: nowIso, nowMs });
        return { outcome: 'already_done', message: FORGET_COPY.alreadyDone };
      }
      emit('forget.revalidation_failed', auditBase(input, { reason: 'claim_lost', memoryId: proposal.memoryId }));
      return fail('none', FORGET_COPY.noPending);
    }
    releaseClaim('execution_error');
    return fail('failed', FORGET_COPY.failed);
  }
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
    // Issue #102 — consumo permanente (espelho do confirm): QUALQUER vínculo
    // ou recibo físico recusa sem tocar em pendings posteriores.
    const bound = getForgetBinding(sql, { workspaceId: input.workspaceId, actorId: input.actorId, intentionId });
    const physical = findForgetDecisionRow(sql, { workspaceId: input.workspaceId, actorId: input.actorId, intentionId });
    if (bound !== undefined || physical) {
      if (physical) {
        const message = physical.outcome === 'cancelled' ? FORGET_COPY.cancelled : decisionOutcomeMessage(physical.outcome);
        return { outcome: physical.outcome === 'cancelled' ? 'cancelled' : 'none', message };
      }
      const target = getForgetProposal(sql, bound ?? '');
      const result = target ? readResultJson(target) : {};
      if (target?.status === 'cancelled' && result['intentionId'] === intentionId) {
        return { outcome: 'cancelled', message: FORGET_COPY.cancelled };
      }
      return { outcome: 'none', message: FORGET_COPY.noPending };
    }
  }

  const record = (outcome: 'none' | 'ambiguous' | 'cancelled'): void => {
    if (intentionId) {
      if (outcome !== 'cancelled') {
        // Consumo sem alvo único: sentinela (ver fail() do confirm).
        try {
          ensureForgetBinding(sql, { workspaceId: input.workspaceId, actorId: input.actorId, intentionId, proposalId: '', createdAt: nowIso });
        } catch {
          // Sem vínculo: fail-closed sem autorizar nada.
        }
      }
      // Round 4: sentinela '' no recibo (distinto de NULL): barreira permanente.
      recordDecisionBestEffort(sql, { workspaceId: input.workspaceId, actorId: input.actorId, intentionId, outcome, createdAt: nowIso, nowMs, proposalId: '' });
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
  // Issue #102 §22 — `cancel + receipt` na MESMA transação (+ vínculo
  // pré-tentativa como no confirm: sem vínculo, sem autoridade).
  if (intentionId) {
    try {
      const winner = ensureForgetBinding(sql, { ...input, intentionId, proposalId: proposal.id, createdAt: nowIso });
      if (winner !== proposal.id) return { outcome: 'none', message: FORGET_COPY.noPending };
    } catch {
      return { outcome: 'none', message: FORGET_COPY.noPending };
    }
  }
  // Issue #102 §22 — `cancel + receipt` na MESMA transação: o recibo faz
  // parte da proteção contra replay, então nunca persiste `cancelled` sem
  // recibo (nem recibo sem `cancelled`). Falha = nada aplicado (proposta
  // segue `pending`, retry possível) e retorno `none` fail-closed.
  try {
    const cancelled = runMemoryTransaction(sql, () => {
      const moved = casForgetProposalStatus(sql, {
        id: proposal.id,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        from: 'pending',
        to: 'cancelled',
        decidedAt: nowIso,
        resultJson: JSON.stringify({ reason: 'user_cancel', intentionId }),
      });
      if (!moved) return undefined;
      if (intentionId) {
        recordForgetDecision(sql, { ...input, intentionId, outcome: 'cancelled', createdAt: nowIso, nowMs, proposalId: proposal.id });
      }
      return moved;
    });
    if (!cancelled) return { outcome: 'none', message: FORGET_COPY.noPending };
  } catch {
    return { outcome: 'none', message: FORGET_COPY.noPending };
  }
  emit('forget.cancelled', auditBase(input, { memoryId: proposal.memoryId }));
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
