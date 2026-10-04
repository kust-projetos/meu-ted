import { describe, expect, it, vi } from 'vitest';
import {
  JUDGMENT_ALLOWED_OPERATIONS,
  JUDGMENT_BREAKER_COOLDOWN_MS,
  JUDGMENT_BREAKER_FAILURE_THRESHOLD,
  JUDGMENT_MAX_CALLS_PER_TURN,
  JUDGMENT_TIMEOUT_MS,
  createJudgmentProvider,
  resolveWithJudgment,
  type BreakerStore,
  type JudgmentEnv,
  type JudgmentRequest,
} from '../src/judgment/provider.js';

const request = (overrides: Partial<JudgmentRequest> = {}): JudgmentRequest => ({
  turnId: 'turn-1',
  operation: 'jev_check',
  state: 'usuário pergunta se pode pagar a fatura',
  question: 'Esta ação é segura para executar?',
  options: ['yes', 'no'],
  ...overrides,
});

const okResponse = (choice: string) =>
  new Response(JSON.stringify({ choice, rationale: 'texto', confidence: 0.8 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const withClock = () => {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

const enabledEnv: JudgmentEnv = {
  TED_JUDGMENT_ENDPOINT: 'https://judgment.example.test/evaluate',
  TED_JUDGMENT_ALLOWED_MODELS: 'judgment-model-v1',
};

describe('JudgmentProvider default-off (A16/R15 — G04 aberto)', () => {
  it('SEM endpoint configurado toda chamada resolve unavailable, sem rede', async () => {
    const fetchImpl = vi.fn();
    const provider = createJudgmentProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await provider.evaluate(request());
    expect(outcome).toEqual({ status: 'unavailable', reason: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('SEM modelo na allowlist toda chamada resolve unavailable, sem rede (allowlist vazia = desligado)', async () => {
    const fetchImpl = vi.fn();
    const provider = createJudgmentProvider({
      env: { TED_JUDGMENT_ENDPOINT: 'https://judgment.example.test/evaluate' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await provider.evaluate(request())).toEqual({ status: 'unavailable', reason: 'not_configured' });
    expect(await provider.evaluate(request({ turnId: 'turn-2' }))).toEqual({ status: 'unavailable', reason: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('declara a allowlist de operações da R15 e registra o provider no catálogo', () => {
    expect([...JUDGMENT_ALLOWED_OPERATIONS]).toEqual(['jev_check', 'jev_score', 'jev_decide', 'jev_gate']);
    // O teto é uma constante declarada, não um número herdado da origem (30 s).
    expect(JUDGMENT_TIMEOUT_MS).toBe(2_000);
    expect(JUDGMENT_MAX_CALLS_PER_TURN).toBe(1);
    expect(JUDGMENT_BREAKER_FAILURE_THRESHOLD).toBe(2);
    expect(JUDGMENT_BREAKER_COOLDOWN_MS).toBe(300_000);
  });
});

describe('fail-closed do judge (AC25 — nunca concede permissão/sucesso)', () => {
  it('timeout → abstained, sem decisão e sem exceções', async () => {
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ) as unknown as typeof fetch,
      timeoutMs: 10,
    });
    const outcome = await provider.evaluate(request());
    expect(outcome).toMatchObject({ status: 'abstained', reason: 'timeout' });
    expect('choice' in outcome).toBe(false);
  });

  it('401 → abstained e conta para o breaker', async () => {
    const clock = withClock();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
    });
    expect(await provider.evaluate(request({ turnId: 'turn-1' }))).toMatchObject({
      status: 'abstained',
      reason: 'unauthorized',
    });
    expect(await provider.evaluate(request({ turnId: 'turn-2' }))).toMatchObject({
      status: 'abstained',
      reason: 'unauthorized',
    });
    // 2 falhas consecutivas → aberto: a 3ª chamada nem sai.
    expect(await provider.evaluate(request({ turnId: 'turn-3' }))).toEqual({
      status: 'unavailable',
      reason: 'circuit_open',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('resposta malformada → abstained, sem escolha', async () => {
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: vi.fn().mockResolvedValue(new Response('não é json', { status: 200 })) as unknown as typeof fetch,
    });
    expect(await provider.evaluate(request())).toMatchObject({ status: 'abstained', reason: 'malformed_response' });
  });

  it('escolha fora da allowlist declarada → abstained (nada é invented)', async () => {
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: vi.fn().mockResolvedValue(okResponse('talvez')) as unknown as typeof fetch,
    });
    const outcome = await provider.evaluate(request());
    expect(outcome).toMatchObject({ status: 'abstained', reason: 'choice_outside_allowlist' });
    expect('choice' in outcome).toBe(false);
  });

  it('operação fora da allowlist da R15 → unavailable sem rede', async () => {
    const fetchImpl = vi.fn();
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await provider.evaluate(request({ operation: 'jev_free_form' as never }))).toEqual({
      status: 'unavailable',
      reason: 'operation_not_allowed',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('escolha válida volta como decisão ADVISORY explícita', async () => {
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: vi.fn().mockResolvedValue(okResponse('no')) as unknown as typeof fetch,
    });
    const outcome = await provider.evaluate(request());
    expect(outcome).toMatchObject({ status: 'decision', choice: 'no', advisory: true });
  });
});

describe('circuit breaker por provider/config (R15)', () => {
  it('abre após 2 falhas, respeita cooldown de 300 s e libera 1 tentativa em half-open', async () => {
    const clock = withClock();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
    });

    expect(await provider.evaluate(request({ turnId: 'turn-1' }))).toMatchObject({ status: 'abstained', reason: 'transport_error' });
    expect(await provider.evaluate(request({ turnId: 'turn-2' }))).toMatchObject({ status: 'abstained', reason: 'transport_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Aberto: nenhuma chamada durante o cooldown.
    expect(await provider.evaluate(request({ turnId: 'turn-3' }))).toEqual({ status: 'unavailable', reason: 'circuit_open' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Cooldown expirado → UMA tentativa (half-open limitado).
    clock.advance(JUDGMENT_BREAKER_COOLDOWN_MS + 1);
    expect(await provider.evaluate(request({ turnId: 'turn-4' }))).toMatchObject({ status: 'abstained', reason: 'transport_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // A tentativa half-open falhou: reabre, sem segunda tentativa no mesmo cooldown.
    expect(await provider.evaluate(request({ turnId: 'turn-5' }))).toEqual({ status: 'unavailable', reason: 'circuit_open' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('sucesso fecha o breaker e zera a contagem consecutiva', async () => {
    const clock = withClock();
    // Sem o reset, a 3ª falha (neste roteiro: 4ª chamada) já abriria o
    // breaker; com o reset, são necessárias DUAS falhas seguidas depois do
    // último sucesso — e a 7ª chamada já encontra o circuito aberto.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(okResponse('yes'))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(okResponse('yes'))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
    });
    expect((await provider.evaluate(request({ turnId: 'turn-1' }))).status).toBe('abstained');
    expect((await provider.evaluate(request({ turnId: 'turn-2' }))).status).toBe('decision');
    expect((await provider.evaluate(request({ turnId: 'turn-3' }))).status).toBe('abstained');
    expect((await provider.evaluate(request({ turnId: 'turn-4' }))).status).toBe('decision');
    expect((await provider.evaluate(request({ turnId: 'turn-5' }))).status).toBe('abstained');
    expect((await provider.evaluate(request({ turnId: 'turn-6' }))).status).toBe('abstained');
    expect(await provider.evaluate(request({ turnId: 'turn-7' }))).toEqual({
      status: 'unavailable',
      reason: 'circuit_open',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('4xx de conteúdo NÃO abre o breaker (nem trava o half-open)', async () => {
    const clock = withClock();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 422 }));
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
    });
    for (const turnId of ['turn-1', 'turn-2', 'turn-3']) {
      expect(await provider.evaluate(request({ turnId }))).toMatchObject({
        status: 'abstained',
        reason: 'rejected_request',
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(provider.stats().breakerOpens).toBe(0);
    // Segue disponível em turnos seguintes: conteúdo recusado não é illness.
    clock.advance(1);
    expect((await provider.evaluate(request({ turnId: 'turn-4' }))).status).toBe('abstained');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('breaker é por configuração: outra config não herda o estado', async () => {
    const clock = withClock();
    const breakers: BreakerStore = new Map();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      breakers,
    });
    await provider.evaluate(request({ turnId: 'turn-1' }));
    await provider.evaluate(request({ turnId: 'turn-2' }));
    expect(await provider.evaluate(request({ turnId: 'turn-3' }))).toEqual({ status: 'unavailable', reason: 'circuit_open' });

    // Config distinta (outro endpoint/modelo) tem breaker próprio no MESMO
    // store: 4xx/falha de conteúdo de uma config não contamina a outra nem
    // outros tenants.
    const otherFetch = vi.fn().mockResolvedValue(okResponse('yes'));
    const other = createJudgmentProvider({
      env: { TED_JUDGMENT_ENDPOINT: 'https://outro.example.test/evaluate', TED_JUDGMENT_ALLOWED_MODELS: 'outro-model' },
      fetchImpl: otherFetch as unknown as typeof fetch,
      now: clock.now,
      breakers,
    });
    expect(await other.evaluate(request({ turnId: 'turn-1' }))).toMatchObject({ status: 'decision' });
    expect(otherFetch).toHaveBeenCalledTimes(1);

    // Mesma config, outra instância, mesmo store: o circuito aberto é visível.
    const sameConfig = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: otherFetch as unknown as typeof fetch,
      now: clock.now,
      breakers,
    });
    expect(await sameConfig.evaluate(request({ turnId: 'turn-1' }))).toEqual({
      status: 'unavailable',
      reason: 'circuit_open',
    });
    expect(otherFetch).toHaveBeenCalledTimes(1);
  });
});

describe('teto de 1 chamada por turno (medido em A10, declarado aqui)', () => {
  it('a segunda chamada do mesmo turno é barrada sem tocar a rede', async () => {
    // Resposta nova por chamada: um `Response` tem corpo de uso único.
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('yes'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await provider.evaluate(request({ turnId: 'turn-1' }))).status).toBe('decision');
    expect(await provider.evaluate(request({ turnId: 'turn-1' }))).toEqual({
      status: 'unavailable',
      reason: 'turn_budget_exhausted',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Turno seguinte tem orçamento novo.
    expect((await provider.evaluate(request({ turnId: 'turn-2' }))).status).toBe('decision');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('RED: um corpo que NUNCA resolve ainda respeita o teto (abstained/timeout, evaluate não fica pendente)', async () => {
    const provider = createJudgmentProvider({
      env: enabledEnv,
      // Headers imediatos, corpo travado: o teto precisa cobrir a LEITURA, não
      // só o fetch (FIX C1).
      fetchImpl: vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => new Promise<never>(() => {}),
      }) as unknown as typeof fetch,
      timeoutMs: JUDGMENT_TIMEOUT_MS,
    });
    const startedAt = Date.now();
    const outcome = await provider.evaluate(request());
    const elapsedMs = Date.now() - startedAt;
    expect(outcome).toMatchObject({ status: 'abstained', reason: 'timeout' });
    expect('choice' in outcome).toBe(false);
    // Resolve no teto (~2 s), nunca pendurado: a janela é o próprio teto + folga.
    expect(elapsedMs).toBeGreaterThanOrEqual(JUDGMENT_TIMEOUT_MS - 50);
    expect(elapsedMs).toBeLessThan(JUDGMENT_TIMEOUT_MS + 1_500);
  });

  it('RED: 200 turnos distintos não abrem brecha — o replay do turno 1 continua barrado', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('yes'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    // Bem acima de qualquer janela de evicção: um teto por turno que esquecesse
    // turnos antigos devolveria a chamada ao judge para um turno já gasto.
    for (let turn = 1; turn <= 200; turn += 1) {
      expect((await provider.evaluate(request({ turnId: `turn-${turn}` }))).status).toBe('decision');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(200);
    expect(await provider.evaluate(request({ turnId: 'turn-1' }))).toEqual({
      status: 'unavailable',
      reason: 'turn_budget_exhausted',
    });
    expect(await provider.evaluate(request({ turnId: 'turn-200' }))).toEqual({
      status: 'unavailable',
      reason: 'turn_budget_exhausted',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(200);
  });

  it('sem turnId o teto por turno não pode ser provado → unavailable, sem rede', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('yes'));
    const provider = createJudgmentProvider({ env: enabledEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await provider.evaluate(request({ turnId: '   ' }))).toEqual({
      status: 'unavailable',
      reason: 'turn_id_required',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('registra a contagem de chamadas por eixo (informativa; a accounting durável é de A10)', async () => {
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(okResponse('yes'))
        .mockResolvedValueOnce(new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });
    await provider.evaluate(request({ turnId: 'turn-1' }));
    await provider.evaluate(request({ turnId: 'turn-2' }));
    expect(provider.stats()).toEqual({ calls: 2, decisions: 1, abstentions: 1, unavailables: 0, breakerOpens: 0 });
  });
});

describe('resolveWithJudgment — consumidor determinístico (AC25)', () => {
  it('com judge indisponível devolve o determinístico sem consultar o judge', async () => {
    const fetchImpl = vi.fn();
    const provider = createJudgmentProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const resolution = await resolveWithJudgment(
      { allowed: false, reason: 'exige confirmação do usuário' },
      { provider, request: request() },
    );
    expect(resolution.value).toEqual({ allowed: false, reason: 'exige confirmação do usuário' });
    expect(resolution.source).toBe('deterministic');
    expect(resolution.judgment).toEqual({ status: 'unavailable', reason: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('com decisão válida o valor determinístico permanece autoritativo (advisory só anexa)', async () => {
    const provider = createJudgmentProvider({
      env: enabledEnv,
      fetchImpl: vi.fn().mockResolvedValue(okResponse('no')) as unknown as typeof fetch,
    });
    const resolution = await resolveWithJudgment({ allowed: true, reason: 'confirmado' }, { provider, request: request() });
    expect(resolution.value).toEqual({ allowed: true, reason: 'confirmado' });
    expect(resolution.source).toBe('judgment_advisory');
    expect(resolution.judgment).toMatchObject({ status: 'decision', choice: 'no', advisory: true });
  });

  it('nenhum caminho Concede permissão: o determinístico é sempre o valor final', async () => {
    const deterministic = { allowed: false, reason: 'determinístico' };
    const providers = [
      createJudgmentProvider({ env: enabledEnv, fetchImpl: vi.fn().mockResolvedValue(okResponse('yes')) as unknown as typeof fetch }),
      createJudgmentProvider({ env: enabledEnv, fetchImpl: vi.fn().mockResolvedValue(new Response('x', { status: 401 })) as unknown as typeof fetch }),
      createJudgmentProvider({ env: enabledEnv, fetchImpl: vi.fn().mockResolvedValue(new Response('{', { status: 200 })) as unknown as typeof fetch }),
    ];
    for (const provider of providers) {
      const resolution = await resolveWithJudgment(deterministic, { provider, request: request() });
      expect(resolution.value).toEqual(deterministic);
    }
  });
});