/**
 * A16 follow-up — UMA instância do `JudgmentProvider` por Durable Object.
 *
 * O breaker e o teto de 1 chamada por turno moram DENTRO da instância. Com uma
 * instância por chamada, os dois_STATEFULIZAM por turno: o teto nunca seguraria
 * (cada chamada nasceria com orçamento novo) e um circuito aberto seria
 * esquecido no turno seguinte. O follow-up do relatório P3 é exatamente esse:
 * um judge que falha duas vezes continuaria sendo chamado a cada turno.
 *
 * O escopo é por DO (workspace), nunca global: dois workspaces não podem
 * compartilhar teto de turno nem breaker.
 *
 * Issue #86: este arquivo cobre a FRONTEIRA JEV, que continua reutilizada como
 * adapter. A instância por DO da camada neutra (e o accessor do
 * `FinanceChatAgent`) vive em `tests/decision-provider-per-do.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  JUDGMENT_BREAKER_COOLDOWN_MS,
  createJudgmentProvider,
  judgmentProviderForDo,
  type JudgmentEnv,
} from '../src/judgment/provider.js';

const request = (turnId: string) => ({
  turnId,
  operation: 'jev_check' as const,
  state: 'usuário pergunta se pode pagar a fatura',
  question: 'Esta ação é segura para executar?',
  options: ['yes', 'no'],
});

const okResponse = (choice: string) =>
  new Response(JSON.stringify({ choice, rationale: 'texto', confidence: 0.8 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const enabledEnv: JudgmentEnv = {
  TED_JUDGMENT_ENDPOINT: 'https://judgment.example.test/evaluate',
  TED_JUDGMENT_ALLOWED_MODELS: 'judgment-model-v1',
};

/** Stands in for the Durable Object instance (one per workspace). */
const fakeDo = (name: string): object => ({ name });

describe('instância única do JudgmentProvider por DO (A16 follow-up)', () => {
  it('RED: o MESMO DO devolve a MESMA instância entre turnos', () => {
    const doScope = fakeDo('ws-1');
    const first = judgmentProviderForDo(doScope, { env: enabledEnv, fetchImpl: vi.fn() as unknown as typeof fetch });
    const second = judgmentProviderForDo(doScope, { env: enabledEnv, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(first).toBe(second);
  });

  it('RED: o teto de 1 chamada por turno sobrevive entre turnos do MESMO DO', async () => {
    const doScope = fakeDo('ws-1');
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('yes'));
    const provider = judgmentProviderForDo(doScope, {
      env: enabledEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await provider.evaluate(request('turn-1'))).status).toBe('decision');
    // Turno seguinte é um turno NOVO: o orçamento é novo, como manda a R15.
    expect((await provider.evaluate(request('turn-2'))).status).toBe('decision');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // O replay do turno 1 no MESMO DO continua barrado: o teto não pode ser
    // "resetado" por uma segunda instanciação.
    expect(await provider.evaluate(request('turn-1'))).toEqual({
      status: 'unavailable',
      reason: 'turn_budget_exhausted',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('RED: o circuito aberto de um DO sobrevive ao turno seguinte', async () => {
    const doScope = fakeDo('ws-1');
    let now = 1_000_000;
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    const provider = judgmentProviderForDo(doScope, {
      env: enabledEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    expect((await provider.evaluate(request('turn-1'))).status).toBe('abstained');
    expect((await provider.evaluate(request('turn-2'))).status).toBe('abstained');
    // Turno 3 do MESMO DO: o circuito continua aberto (com cooldown em curso).
    expect(await provider.evaluate(request('turn-3'))).toEqual({
      status: 'unavailable',
      reason: 'circuit_open',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // E o cooldown ainda vale depois do tempo.
    now += JUDGMENT_BREAKER_COOLDOWN_MS + 1;
    expect((await provider.evaluate(request('turn-4'))).status).toBe('abstained');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('RED: DOs diferentes NUNCA compartilham teto nem breaker', async () => {
    const first = judgmentProviderForDo(fakeDo('ws-1'), {
      env: enabledEnv,
      fetchImpl: vi.fn().mockImplementation(async () => okResponse('yes')) as unknown as typeof fetch,
    });
    const second = judgmentProviderForDo(fakeDo('ws-2'), {
      env: enabledEnv,
      fetchImpl: vi.fn().mockImplementation(async () => okResponse('yes')) as unknown as typeof fetch,
    });
    expect(first).not.toBe(second);
    await first.evaluate(request('turn-1'));
    // O mesmo `turnId` em outro workspace é outro turno: o teto é por DO.
    expect((await second.evaluate(request('turn-1'))).status).toBe('decision');
  });

  it('as deps da PRIMEIRA chamada valem: a instância do DO não é recriada por chamada', () => {
    const doScope = fakeDo('ws-1');
    const first = judgmentProviderForDo(doScope, { env: enabledEnv, fetchImpl: vi.fn() as unknown as typeof fetch });
    // Env ausente na segunda chamada: o judge segue com a config já resolvida.
    const second = judgmentProviderForDo(doScope, {});
    expect(second).toBe(first);
    expect(second.available).toBe(true);
  });

  it('a fábrica pura continua sendo uma fábrica (instância nova por chamada)', () => {
    const a = createJudgmentProvider({ env: enabledEnv, fetchImpl: vi.fn() as unknown as typeof fetch });
    const b = createJudgmentProvider({ env: enabledEnv, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(a).not.toBe(b);
  });
});
