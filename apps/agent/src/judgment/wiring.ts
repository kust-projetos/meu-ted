/**
 * A16/R15 follow-up — o `JudgmentProvider` LIGADO a UM ponto de decisão do hot
 * path (G04 resolvido como default-off com wiring completo; ver
 * docs/reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md §1).
 *
 * A fronteira de `provider.ts` existia sem consumidor real. Este módulo é a
 * cola entre ela e o orquestrador, e ele existe para tornar o contrato
 * verificável em um lugar só:
 *
 * - **Um pedido sem estado financeiro.** O consumidor descreve FATOS
 *   STRUTURAIS do turno (`ContinuationRelationFacts`), nunca texto do usuário,
 *   valor, data, descrição, categoria ou id de conta. O judge vê a FORMA de uma
 *   decisão, nunca o dinheiro de ninguém.
 * - **O determinístico continua autoritativo.** `value` é sempre o valor
 *   determinístico, em todos os caminhos — inclusive quando o judge responde o
 *   contrário. Uma decisão só muda `source` (telemetria), nunca o desfecho.
 * - **Abstinência e ausência não são dúvidas do orquestrador.** Sem accessor, ou
 *   com o provider default-off, o caminho é o determinístico sem rede; o
 *   wiring nem pede o provider quando o chamador não tem um.
 *
 * O ponto ligado é a relação de continuação do rascunho ("correção" | "negação"
 * | "continuação"): uma classificação puramente COMPORTAMENTAL que hoje é
 * resolvida por heurística determinística. Correção de valor NÃO entra aqui —
 * ela é o caminho com trava de revisão de escrita financeira, e nenhuma
 * consulta opcional pode abrir uma janela antes dela.
 */
import {
  judgmentUnavailable,
  resolveWithJudgment,
  type JudgmentOutcome,
  type JudgmentProvider,
  type JudgmentRequest,
  type JudgmentResolution,
} from './provider.js';

/** Allowlist fechada: o judge escolhe um destes rótulos ou nada é aceito. */
export const CONTINUATION_RELATION_CHOICES = ['correction', 'negation', 'continuation'] as const;
export type ContinuationRelationChoice = (typeof CONTINUATION_RELATION_CHOICES)[number];

/**
 * Fatos estruturais do turno. Cada campo é uma FORMA (rótulo da máquina de
 * estados, contagem, booleano), nunca conteúdo: um rascunho com três campos
 * pendentes vira `pendingFieldCount: 3`, nunca a lista com os nomes/valores.
 */
export type ContinuationRelationFacts = Readonly<{
  /** Chave do TURNO — é o que o teto de 1 chamada por turno mede. */
  turnId: string;
  /** Rótulo do estado do rascunho (`active`, `proposing`, ...). */
  draftStatus: string;
  /** Quantos campos ainda faltam; NUNCA os nomes dos campos nem seus valores. */
  pendingFieldCount: number;
  /** A heurística determinística encontrou um marcador de negação. */
  negationMarker: boolean;
  /** O que a heurística decidiu (a resposta que continua autoritativa). */
  deterministicRelation: ContinuationRelationChoice;
}>;

/**
 * Pergunta fixa, sem dado do usuário: o judge classifica uma FORMA de turno.
 * "advisory" está no enunciado porque a resposta é consumida como sugestão.
 */
export const CONTINUATION_RELATION_QUESTION =
  'Classifique a relação deste turno com o rascunho ativo (correção, negação ou continuação). A resposta é advisory: ela não altera o resultado do turno.';

/** O pedido ao judge derivado dos fatos estruturais — único lugar que monta o payload. */
export const continuationRelationJudgmentRequest = (
  facts: ContinuationRelationFacts,
): JudgmentRequest => ({
  turnId: facts.turnId,
  operation: 'jev_decide',
  state: JSON.stringify({
    activeDraft: true,
    draftStatus: facts.draftStatus,
    pendingFieldCount: facts.pendingFieldCount,
    negationMarker: facts.negationMarker,
    deterministicRelation: facts.deterministicRelation,
  }),
  question: CONTINUATION_RELATION_QUESTION,
  options: [...CONTINUATION_RELATION_CHOICES],
});

/**
 * `not_configured` (sem accessor, ou env ausente) é a ÚNICA ausência que não
 * vira evento: com o default-off, o turno precisa ser indistinguível do turno
 * de antes do wiring — inclusive na telemetria.
 */
export const isJudgmentDefaultOff = (outcome: JudgmentOutcome): boolean =>
  outcome.status === 'unavailable' && outcome.reason === 'not_configured';

/**
 * A escolha do judge, revalidada contra a allowlist local. O provider já
 * rejeita uma escolha fora da lista; a checagem se repete porque aqui o valor
 * é usado em TELEMETRIA, e um campo de evento não pode carregar rótulo livre.
 */
export const advisoryRelation = (outcome: JudgmentOutcome): ContinuationRelationChoice | null =>
  outcome.status === 'decision' && (CONTINUATION_RELATION_CHOICES as readonly string[]).includes(outcome.choice)
    ? (outcome.choice as ContinuationRelationChoice)
    : null;

/** Campos SANITIZADOS do evento de consulta: enums e booleanos, nunca conteúdo. */
export type JudgmentConsultFields = Readonly<{
  operation: 'jev_decide';
  status: JudgmentOutcome['status'];
  source: JudgmentResolution<ContinuationRelationChoice>['source'];
  reason?: string;
  choice?: ContinuationRelationChoice;
  deterministicRelation: ContinuationRelationChoice;
}>;

export const judgmentConsultFields = (
  resolution: JudgmentResolution<ContinuationRelationChoice>,
): JudgmentConsultFields => {
  const { judgment } = resolution;
  const choice = advisoryRelation(judgment);
  const reason = 'reason' in judgment ? judgment.reason : undefined;
  return {
    operation: 'jev_decide',
    status: judgment.status,
    source: resolution.source,
    ...(reason !== undefined ? { reason } : {}),
    ...(choice !== null ? { choice } : {}),
    deterministicRelation: resolution.value,
  };
};

/**
 * Consulta o judge como desempate ADVISORY. Retorna a resolução do provider
 * com `value` = determinístico em TODOS os caminhos; um accessor ausente nem é
 * lido (fail-closed, zero rede).
 */
export const resolveContinuationRelation = async (
  deterministic: ContinuationRelationChoice,
  input: { provider?: JudgmentProvider | undefined; facts: ContinuationRelationFacts },
): Promise<JudgmentResolution<ContinuationRelationChoice>> => {
  if (!input.provider) {
    return {
      value: deterministic,
      source: 'deterministic',
      judgment: judgmentUnavailable('not_configured'),
    };
  }
  return resolveWithJudgment(deterministic, {
    provider: input.provider,
    request: continuationRelationJudgmentRequest(input.facts),
  });
};