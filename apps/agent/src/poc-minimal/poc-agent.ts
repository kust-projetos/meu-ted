/**
 * POC Fase 2 — agente mínimo reads-only.
 *
 * Fluxo por turno: histórico → intenção determinística → 1 leitura real
 * (via `ChannelReadTools` injetado — os mesmos readers do hot path) →
 * resposta fundamentada por template a partir da evidência → telemetria.
 *
 * Sem writes por construção: este módulo não importa nem referencia nenhum
 * writer/mutação; a resposta de erro é fail-closed sem dígitos.
 */
import type { ChannelReadTools } from '../orchestration/channel-evidence.js';
import { PocHistory } from './poc-history.js';
import { routePocIntent } from './poc-intent.js';
import { executePocReads } from './poc-reads.js';
import { buildPocSystemPrompt } from './poc-system.js';
import { createPocTelemetry, type PocTurnTelemetry } from './poc-telemetry.js';

export type PocTurnResult = {
  readonly answer: string;
  readonly evidence: unknown;
  readonly telemetry: PocTurnTelemetry;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  !!value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const FAIL_CLOSED_TEXT =
  'Não consegui apurar os dados agora (falha de leitura). Nenhum valor foi considerado — tente novamente.';

const formatBrl = (cents: number): string =>
  `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

export class PocMinimalAgent {
  private readonly history = new PocHistory();

  constructor(
    private readonly deps: {
      readonly readTools: ChannelReadTools;
      readonly now?: () => Date;
      readonly workspaceId?: string;
    },
  ) {}

  get systemPrompt(): string {
    const nowDate = this.deps.now?.() ?? new Date();
    return buildPocSystemPrompt(nowDate.toISOString().slice(0, 10));
  }

  get turnCount(): number {
    return this.history.size();
  }

  async answerTurn(question: string, scenarioId: string): Promise<PocTurnResult> {
    const startedAt = Date.now();
    const nowDate = this.deps.now?.() ?? new Date();
    this.history.push('user', question);

    const intent = routePocIntent(question, nowDate);
    if (intent.kind === 'general') {
      const answer =
        'Cartão de crédito é um meio de pagamento com limite concedido pela instituição: ' +
        'as compras acumulam na fatura e são pagas depois. ' +
        'Posso listar seus cartões ou mostrar faturas quando quiser — é só pedir.';
      this.history.push('assistant', answer);
      return {
        answer,
        evidence: null,
        telemetry: createPocTelemetry(
          scenarioId,
          startedAt,
          { tool: null, read: null, modelCalled: false },
          { answerText: answer, grounded: true, completed: true, hallucination: false },
          question,
        ),
      };
    }

    const outcomes = await executePocReads(this.deps.readTools, [
      { name: intent.read, params: { ...intent.params, workspaceId: this.deps.workspaceId ?? 'poc-workspace' } },
    ]);
    const outcome = outcomes[0];
    const payload = outcome?.payload;
    const payloadRecord = asRecord(payload);

    if (payloadRecord?.__pocReadError !== undefined) {
      this.history.push('assistant', FAIL_CLOSED_TEXT);
      return {
        answer: FAIL_CLOSED_TEXT,
        evidence: payload,
        telemetry: createPocTelemetry(
          scenarioId,
          startedAt,
          { tool: intent.read, read: intent.read, modelCalled: false },
          { answerText: FAIL_CLOSED_TEXT, grounded: true, completed: false, hallucination: false },
          question,
        ),
      };
    }

    const answer = this.renderGrounded(intent.read, payload);
    this.history.push('assistant', answer);
    const grounded = this.isGrounded(answer, payload);
    // P2d: render e grounding viajam separados — payload inválido ({} ou
    // resumo sem campos) nunca conclui, mesmo quando a copy fail-closed não
    // carrega dígitos (e por isso passa no `isGrounded`).
    const usable = this.isPayloadUsable(intent.read, payload);
    return {
      answer,
      evidence: payload,
      telemetry: createPocTelemetry(
        scenarioId,
        startedAt,
        { tool: intent.read, read: intent.read, modelCalled: false },
        { answerText: answer, grounded, completed: grounded && usable, hallucination: !grounded },
        question,
      ),
    };
  }

  private renderGrounded(read: string, payload: unknown): string {
    const record = asRecord(payload);
    const items = record && Array.isArray(record['items']) ? (record['items'] as unknown[]) : null;
    if (read === 'getMonthSummary') {
      const count =
        typeof record?.['transactionCount'] === 'number' ? (record['transactionCount'] as number) : null;
      if (count === 0 || (items !== null && items.length === 0)) {
        const ym = typeof record?.['yearMonth'] === 'string' ? (record['yearMonth'] as string) : 'o período';
        return `Não há lançamentos em ${ym} (período sem dados). Nenhum valor foi inventado — peça outro período se quiser.`;
      }
      const expense =
        typeof record?.['expenseCents'] === 'number' ? (record['expenseCents'] as number) : null;
      const income = typeof record?.['incomeCents'] === 'number' ? (record['incomeCents'] as number) : null;
      if (expense !== null) {
        const ym = typeof record?.['yearMonth'] === 'string' ? ` em ${record['yearMonth'] as string}` : '';
        const extra = income !== null ? ` (receitas ${formatBrl(income)})` : '';
        return `Você gastou ${formatBrl(expense)}${ym}${extra}, segundo o resumo do período.`;
      }
      return FAIL_CLOSED_TEXT;
    }
    if (items !== null) {
      if (items.length === 0) {
        const label =
          read === 'listAccounts'
            ? 'contas'
            : read === 'listCards'
              ? 'cartões'
              : read === 'listStatements'
                ? 'faturas neste escopo'
                : 'registros neste escopo';
        return `Não encontrei ${label} (leitura funcionou e voltou vazia). Se esperava dados, confira o workspace ou o período.`;
      }
      if (read === 'listAccounts') {
        const names = items
          .map((row) => {
            const r = asRecord(row);
            const name = r && typeof r['accountName'] === 'string' ? (r['accountName'] as string) : null;
            const cents =
              r && typeof r['balanceCents'] === 'number' ? (r['balanceCents'] as number) : null;
            return name !== null && cents !== null ? `${name} (${formatBrl(cents)})` : null;
          })
          .filter((line): line is string => line !== null);
        if (names.length === 0) return FAIL_CLOSED_TEXT;
        return `Suas contas: ${names.join('; ')}.`;
      }
      if (read === 'listCards') {
        const names = items
          .map((row) => {
            const r = asRecord(row);
            const name = r && typeof r['name'] === 'string' ? (r['name'] as string) : null;
            return name ?? JSON.stringify(row).slice(0, 80);
          })
          .filter((line) => line.length > 0);
        return `Seus cartões: ${names.join('; ')}.`;
      }
      if (read === 'listTransactions') {
        const lines = items.slice(0, 5).map((row) => {
          const r = asRecord(row);
          const desc = r && typeof r['description'] === 'string' ? (r['description'] as string) : '?';
          const cents = r && typeof r['amountCents'] === 'number' ? (r['amountCents'] as number) : null;
          return cents !== null ? `${desc} (${formatBrl(cents)})` : desc;
        });
        return `Gastos encontrados: ${lines.join('; ')}.`;
      }
      return `Encontrei ${items.length} registro(s) para sua pergunta.`;
    }
    return FAIL_CLOSED_TEXT;
  }

  /**
   * P2d — o payload é UTILIZÁVEL quando carrega os campos do contrato da
   * leitura. `{}` ou resumo sem campos (`{ yearMonth }` sem contagem nem
   * totais) é inválido: a resposta cai no fail-closed e o turno não conclui.
   * Listas exigem o array `items` (vazio = ausência real e utilizável).
   * REVIEWER-F2/G: validade espelha o efetivamente renderizável — resumo sem
   * `expenseCents` (ex. só `incomeCents`) cai no fail-closed do renderer, e
   * lista cujo nenhum item tem campo exibível (ex. `[{}]`) também; ambos são
   * inválidos (`completed=false`).
   */
  private isPayloadUsable(read: string, payload: unknown): boolean {
    const record = asRecord(payload);
    if (record === null) return false;
    if (read === 'getMonthSummary') {
      if (typeof record['yearMonth'] !== 'string') return false;
      const count =
        typeof record['transactionCount'] === 'number' ? (record['transactionCount'] as number) : null;
      if (count === 0) return true;
      const items = Array.isArray(record['items']) ? (record['items'] as unknown[]) : null;
      if (items !== null && items.length === 0) return true;
      return typeof record['expenseCents'] === 'number';
    }
    if (!Array.isArray(record['items'])) return false;
    const items = record['items'] as unknown[];
    if (items.length === 0) return true;
    return items.some((row) => this.hasDisplayableField(read, row));
  }

  /** Campo exibível por leitura — espelha os ramos do `renderGrounded`. */
  private hasDisplayableField(read: string, row: unknown): boolean {
    const record = asRecord(row);
    if (record === null) return false;
    if (read === 'listAccounts') {
      return (
        typeof record['accountName'] === 'string' && typeof record['balanceCents'] === 'number'
      );
    }
    if (read === 'listCards') {
      return typeof record['name'] === 'string';
    }
    if (read === 'listTransactions') {
      return (
        typeof record['description'] === 'string' || typeof record['amountCents'] === 'number'
      );
    }
    return Object.keys(record).length > 0;
  }

  /** Checagem de grounding: todo valor monetário da resposta precisa existir na evidência. */
  private isGrounded(answer: string, payload: unknown): boolean {
    const serialized = JSON.stringify(payload ?? null);
    const money = [...answer.matchAll(/R\$\s*([\d.]+),(\d{2})/g)];
    if (money.length === 0) return !/R\$/.test(answer) || serialized.includes('R$');
    return money.every((match) => {
      const digits = `${match[1]!.replaceAll('.', '')}.${match[2]!}`;
      const cents = Math.round(Number(digits) * 100);
      return serialized.includes(String(cents));
    });
  }
}
