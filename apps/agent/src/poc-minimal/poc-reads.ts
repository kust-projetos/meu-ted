/**
 * POC Fase 2 — registry mínimo de READS reais (somente leitura).
 *
 * Reutiliza os MESMOS readers do hot path via o tipo injetável
 * `ChannelReadTools` (`../orchestration/channel-evidence.js`): em produção
 * o default liga as tools HTTP geradas; no POC/testes o chamador injeta
 * stubs com o mesmo contrato. Nenhum write existe aqui por construção —
 * `assertPocReadsOnly` rejeita qualquer nome fora da allowlist.
 */
import type { ChannelReadTools } from '../orchestration/channel-evidence.js';

export const POC_READ_NAMES = [
  'listAccounts',
  'listCards',
  'listTransactions',
  'listStatements',
  'getMonthSummary',
  'listCategories',
] as const;

export type PocReadName = (typeof POC_READ_NAMES)[number];

const POC_READ_TO_TOOL: Record<PocReadName, keyof ChannelReadTools> = {
  listAccounts: 'listAccounts',
  listCards: 'listCards',
  listTransactions: 'listRecentTransactions',
  listStatements: 'listStatements',
  getMonthSummary: 'getMonthSummary',
  listCategories: 'listCategories',
};

export const assertPocReadName = (name: string): PocReadName => {
  const found = (POC_READ_NAMES as readonly string[]).find((entry) => entry === name);
  if (!found) throw new Error(`poc.read_not_allowed:${name}`);
  return found as PocReadName;
};

export type PocReadCall = {
  readonly name: PocReadName;
  readonly params: Record<string, unknown>;
};

export type PocReadOutcome = {
  readonly name: PocReadName;
  readonly latencyMs: number;
  readonly payload: unknown;
};

/** Execução sequencial com latência por leitura; erro vira payload tipado (fail-closed a jusante). */
export const executePocReads = async (
  tools: ChannelReadTools,
  calls: readonly PocReadCall[],
): Promise<PocReadOutcome[]> => {
  const outcomes: PocReadOutcome[] = [];
  for (const call of calls) {
    const name = assertPocReadName(call.name);
    const startedAt = Date.now();
    let payload: unknown;
    try {
      payload = await tools[POC_READ_TO_TOOL[name]]({ ...call.params });
    } catch (error) {
      payload = { __pocReadError: error instanceof Error ? error.message.slice(0, 120) : 'read_failed' };
    }
    outcomes.push({ name, latencyMs: Date.now() - startedAt, payload });
  }
  return outcomes;
};
