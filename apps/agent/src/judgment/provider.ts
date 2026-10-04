/**
 * A16 / SPEC R15 — fronteira `JudgmentProvider` (Jev), default-OFF.
 *
 * G04 (transporte, credencial, modelo, preço e privacidade) está ABERTO e não
 * existe integração Jev real no Worker: o harness local/stdio não é um deploy.
 * Esta fatia entrega só a FRONTEIRA, no mesmo padrão default-off da A11
 * (`TED_WEB_FETCH_ALLOWED_HOSTS` vazio ⇒ tool indisponível com resposta
 * graciosa): com endpoint ausente ou allowlist de modelo vazia, TODA chamada
 * resolve `unavailable` sem tocar a rede e o consumidor cai no determinístico.
 *
 * Decisões que o módulo NÃO toma (por desenho, não por omissão):
 * - **Nenhum método abstrato antecipado.** A SPEC pede "só os métodos realmente
 *   usados": há UM, `evaluate`. `check`/`score`/`decide`/`gate` são o
 *   `operation` da allowlist da R15, não quatro interfaces.
 * - **A saída é ADVISORY.** Uma decisão válida nunca autoriza nada: ela vem
 *   marcada `advisory: true` e `resolveWithJudgment` mantém o valor
 *   determinístico como autoritativo em todos os caminhos.
 * - **Falha é abstinência, nunca confiança.** timeout / 401 / malformado /
 *   escolha fora da allowlist produzem `abstained` ou `unavailable`, nunca um
 *   score sintético apresentado como "confiança do Jev" (R15).
 * - **Nada de estado financeiro no judge.** `JudgmentRequest` carrega texto
 *   sanitizado pelo chamador + a allowlist de opções; o provider não constrói
 *   payload a partir de saldos, transações ou contas.
 *
 * Teto e breaker (constantes declaradas, não herdadas da origem):
 * - `JUDGMENT_TIMEOUT_MS = 2s` por chamada e `JUDGMENT_MAX_CALLS_PER_TURN = 1`
 *   por turno — valor medido em A10, não os 30 s da origem;
 * - breaker por provider/config: abre com 2 falhas CONSECUTIVAS, cooldown de
 *   300 s, half-open limitado a 1 tentativa;
 * - 4xx de conteúdo (400/422) NÃO contam para o breaker: um conteúdo recusado
 *   por um tenant não pode desligar o judge dos outros (R15).
 */

export const JUDGMENT_ALLOWED_OPERATIONS = ['jev_check', 'jev_score', 'jev_decide', 'jev_gate'] as const;
export type JudgmentOperation = (typeof JUDGMENT_ALLOWED_OPERATIONS)[number];

/** Teto por chamada (R15: 2 s, medido em A10). */
export const JUDGMENT_TIMEOUT_MS = 2_000;
/** Teto por turno: no máximo 1 chamada (R15). */
export const JUDGMENT_MAX_CALLS_PER_TURN = 1;
/** Falhas consecutivas até abrir (R15). */
export const JUDGMENT_BREAKER_FAILURE_THRESHOLD = 2;
/** Cooldown antes da tentativa half-open (R15). */
export const JUDGMENT_BREAKER_COOLDOWN_MS = 300_000;

/**
 * Operator env. Default-off: endpoint OU modelo ausente deixa o judge
 * indisponível. A credencial pertence a G04 — esta fronteira não inventa
 * segredo, token ou header de autenticação, e trata 401 como abstinência.
 */
export const JUDGMENT_ENDPOINT_ENV = 'TED_JUDGMENT_ENDPOINT';
export const JUDGMENT_ALLOWED_MODELS_ENV = 'TED_JUDGMENT_ALLOWED_MODELS';

export type JudgmentEnv = {
  TED_JUDGMENT_ENDPOINT?: string;
  TED_JUDGMENT_ALLOWED_MODELS?: string;
};

export type JudgmentRequest = Readonly<{
  /** Turno que consome a chamada: é o que o teto por turno mede. */
  turnId: string;
  operation: JudgmentOperation | (string & {});
  /** Estado SANITIZADO pelo chamador (texto sem saldo, ID, conta ou documento). */
  state: string;
  question: string;
  /** Allowlist fechada de escolhas aceitáveis; a resposta precisa estar nela. */
  options?: readonly string[];
  levels?: readonly string[];
}>;

export const JUDGMENT_UNAVAILABLE_REASONS = [
  'not_configured',
  'operation_not_allowed',
  'turn_id_required',
  'turn_budget_exhausted',
  'circuit_open',
] as const;
export type JudgmentUnavailableReason = (typeof JUDGMENT_UNAVAILABLE_REASONS)[number];

export const JUDGMENT_ABSTAINED_REASONS = [
  'timeout',
  'unauthorized',
  'rejected_request',
  'transport_error',
  'malformed_response',
  'choice_outside_allowlist',
] as const;
export type JudgmentAbstainedReason = (typeof JUDGMENT_ABSTAINED_REASONS)[number];

/**
 * Abstinência tipada em três estados. `decision` carrega `advisory: true`
 * literal: o compilador obriga quem consume a tratar o resultado como
 * sugestão, e nenhum outro campo pode conceder autorização.
 */
export type JudgmentOutcome =
  | Readonly<{ status: 'unavailable'; reason: JudgmentUnavailableReason }>
  | Readonly<{ status: 'abstained'; reason: JudgmentAbstainedReason; message: string }>
  | Readonly<{ status: 'decision'; choice: string; advisory: true; rationale?: string; confidence?: number }>;

/** Fronteira mínima: UM método. */
export type JudgmentProvider = Readonly<{
  /** false = default-off (sem endpoint ou sem modelo na allowlist). */
  available: boolean;
  evaluate: (request: JudgmentRequest) => Promise<JudgmentOutcome>;
  /** Contadores em memória; a accounting durável por eixo é de A10. */
  stats: () => JudgmentStats;
}>;

export type JudgmentStats = Readonly<{
  calls: number;
  decisions: number;
  abstentions: number;
  unavailables: number;
  breakerOpens: number;
}>;

export const judgmentUnavailable = (reason: JudgmentUnavailableReason): JudgmentOutcome => ({
  status: 'unavailable',
  reason,
});

const abstained = (reason: JudgmentAbstainedReason, message: string): JudgmentOutcome => ({
  status: 'abstained',
  reason,
  message,
});

type BreakerState = { failures: number; openedAt: number | null; halfOpenUsed: boolean };
export type BreakerStore = Map<string, BreakerState>;

const blank = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');

/** Endpoint + modelo: a chave que isola uma configuração da outra (R15). */
const configKeyOf = (endpoint: string, model: string): string => `${endpoint}|${model}`;

const parseAllowedModels = (raw: string | undefined): readonly string[] =>
  (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

export type JudgmentProviderDeps = Readonly<{
  env?: JudgmentEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Store compartilhado opcional: duas instâncias da MESMA config compartilham breaker. */
  breakers?: BreakerStore;
}>;

/**
 * `createJudgmentProvider` — a ÚNICA porta de entrada registrada (A16).
 * `available: false` é o estado default do Worker hoje.
 *
 * Esta é a FÁBRICA PURA: cada chamada devolve uma instância nova, com breaker e
 * teto por turno próprios. Use `judgmentProviderForDo` no wiring por DO.
 */
export const createJudgmentProvider = (deps: JudgmentProviderDeps = {}): JudgmentProvider => {
  const endpoint = blank(deps.env?.[JUDGMENT_ENDPOINT_ENV]);
  const models = parseAllowedModels(deps.env?.[JUDGMENT_ALLOWED_MODELS_ENV]);
  const model = models[0] ?? '';
  const available = endpoint !== '' && model !== '';
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? JUDGMENT_TIMEOUT_MS;
  const breakers: BreakerStore = deps.breakers ?? new Map<string, BreakerState>();
  const configKey = configKeyOf(endpoint, model);

  // A16/FIX C2 — SEM janela de evicção: nenhum `turnId` gasto é esquecido, para
  // que um turno antigo nunca volte a ter orçamento (ver `consumeTurn`).
  const usedTurns = new Set<string>();
  const counters = { calls: 0, decisions: 0, abstentions: 0, unavailables: 0, breakerOpens: 0 };

  const breakerState = (): BreakerState => {
    const existing = breakers.get(configKey);
    if (existing) return existing;
    const created: BreakerState = { failures: 0, openedAt: null, halfOpenUsed: false };
    breakers.set(configKey, created);
    return created;
  };

  const settle = (outcome: JudgmentOutcome): JudgmentOutcome => {
    if (outcome.status === 'decision') counters.decisions += 1;
    else if (outcome.status === 'abstained') counters.abstentions += 1;
    else counters.unavailables += 1;
    return outcome;
  };

  /**
   * `counting` = falha de SAÚDE do judge (transport/credencial/malformado).
   * Um 4xx de conteúdo é `counting: false`: ele não abre nem estende breaker.
   */
  const recordOutcome = (outcome: JudgmentOutcome, counting: boolean): void => {
    const state = breakerState();
    if (outcome.status === 'decision') {
      state.failures = 0;
      state.openedAt = null;
      state.halfOpenUsed = false;
      return;
    }
    if (!counting) {
      // Libera a tentativa half-open: um conteúdo recusado não pode deixar o
      // breaker travado para sempre sem nova informação de saúde.
      state.halfOpenUsed = false;
      return;
    }
    state.failures += 1;
    if (state.failures >= JUDGMENT_BREAKER_FAILURE_THRESHOLD) {
      if (state.openedAt === null) counters.breakerOpens += 1;
      state.openedAt = now();
      state.halfOpenUsed = false;
    }
  };

  const gateBreaker = (): JudgmentOutcome | null => {
    const state = breakerState();
    if (state.openedAt === null) return null;
    if (now() - state.openedAt < JUDGMENT_BREAKER_COOLDOWN_MS) return judgmentUnavailable('circuit_open');
    if (state.halfOpenUsed) return judgmentUnavailable('circuit_open');
    state.halfOpenUsed = true; // half-open: UMA tentativa
    return null;
  };

  /**
 * A16/FIX C2 — turnos lembrados para o teto por turno, SEM evicção.
 *
 * Evitar o crescimento exigiria esquecer turnos antigos, e esquecer um turno é
 * exatamente o que devolve a chamada ao judge dentro do turno que já a consumiu
 * — o teto por turno viria uma posição "livre" silenciosamente. As entradas são
 * mínimas (o próprio `turnId`) e a instância vive no DO do workspace, que já
 * guarda histórico e memória por sessão: a fronteira declarada é a memória do
 * DO, não um teto escondido. Um DO que precise repor esse estado usa um checker
 * de frescor injetado em vez de uma janela cega.
 */
const consumeTurn = (turnId: string): boolean => {
    if (usedTurns.has(turnId)) return false;
    usedTurns.add(turnId);
    return true;
  };

  const evaluate = async (request: JudgmentRequest): Promise<JudgmentOutcome> => {
    if (!available) return settle(judgmentUnavailable('not_configured'));
    if (!(JUDGMENT_ALLOWED_OPERATIONS as readonly string[]).includes(request.operation)) {
      return settle(judgmentUnavailable('operation_not_allowed'));
    }
    if (blank(request.turnId) === '') return settle(judgmentUnavailable('turn_id_required'));
    if (!consumeTurn(request.turnId)) return settle(judgmentUnavailable('turn_budget_exhausted'));
    const blocked = gateBreaker();
    if (blocked) return settle(blocked);

    counters.calls += 1;
    const controller = new AbortController();
    let timedOut = false;
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    /**
     * A16/FIX C1 — UM ÚNICO teto para a tentativa INTEIRA: ele permanece
     * armado até o corpo ser lido, e o mesmo `AbortSignal` continua vivo durante
     * o `json()`. Antes, o timer era cancelado nos headers e uma resposta cujo
     * corpo nunca resolvesse deixava `evaluate` pendurado para sempre — o teto
     * de 2 s valia só para a chegada das headers, não para a resposta.
     */
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('judgment.deadline_exceeded'));
      }, timeoutMs);
    });
    // A corrida abaixo observa a rejeição; este catch extra impede que um timer
    // que vence depois da tentativa resolver vire rejeição não tratada.
    deadline.catch(() => undefined);
    const clearDeadline = (): void => {
      if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
      deadlineHandle = undefined;
    };
    const timeoutOutcome = (): JudgmentOutcome => {
      const outcome = abstained('timeout', 'O judge não respondeu no tempo; sigo com o caminho determinístico.');
      recordOutcome(outcome, true);
      return outcome;
    };

    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            operation: request.operation,
            model,
            question: request.question,
            state: request.state,
            ...(request.options ? { options: [...request.options] } : {}),
            ...(request.levels ? { levels: [...request.levels] } : {}),
          }),
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (_error) {
      clearDeadline();
      return settle(timedOut ? timeoutOutcome() : (() => {
        const outcome = abstained('transport_error', 'Não consegui falar com o judge agora; sigo com o caminho determinístico.');
        recordOutcome(outcome, true);
        return outcome;
      })());
    }

    try {
      if (response.status === 401 || response.status === 403) {
        const outcome = abstained('unauthorized', 'O judge recusou a credencial; sigo com o caminho determinístico.');
        recordOutcome(outcome, true);
        return settle(outcome);
      }
      if (response.status === 400 || response.status === 422) {
        // Rejeição de CONTEÚDO: não é saúde do judge, então não conta.
        const outcome = abstained('rejected_request', 'O judge recusou este pedido; sigo com o caminho determinístico.');
        recordOutcome(outcome, false);
        return settle(outcome);
      }
      if (!response.ok) {
        const outcome = abstained('transport_error', 'O judge falhou agora; sigo com o caminho determinístico.');
        recordOutcome(outcome, true);
        return settle(outcome);
      }

      let payload: unknown;
      try {
        // O corpo entra na MESMA corrida: um judge que manda headers e trava
        // depois é timeout, não uma resposta ilegível.
        payload = await Promise.race([response.json(), deadline]);
      } catch (_error) {
        if (timedOut) return settle(timeoutOutcome());
        const outcome = abstained('malformed_response', 'Resposta do judge ilegível; sigo com o caminho determinístico.');
        recordOutcome(outcome, true);
        return settle(outcome);
      }
    const choice = (payload as { choice?: unknown } | null)?.choice;
      if (typeof choice !== 'string' || choice === '') {
        const outcome = abstained('malformed_response', 'Resposta do judge sem escolha utilizável; sigo com o caminho determinístico.');
        recordOutcome(outcome, true);
        return settle(outcome);
      }
      if (request.options && !request.options.includes(choice)) {
        const outcome = abstained('choice_outside_allowlist', 'O judge escolheu fora da lista permitida; sigo com o caminho determinístico.');
        recordOutcome(outcome, true);
        return settle(outcome);
      }

      const rationale = (payload as { rationale?: unknown }).rationale;
      const confidence = (payload as { confidence?: unknown }).confidence;
      const outcome: JudgmentOutcome = {
        status: 'decision',
        choice,
        advisory: true,
        ...(typeof rationale === 'string' ? { rationale } : {}),
        ...(typeof confidence === 'number' && Number.isFinite(confidence) ? { confidence } : {}),
      };
      recordOutcome(outcome, true);
      return settle(outcome);
    } finally {
      clearDeadline();
    }
  };

  return {
    available,
    evaluate,
    stats: () => ({ ...counters }),
  };
};

export type JudgmentResolution<T> = Readonly<{
  /** SEMPRE o valor determinístico — um judge nunca concede permissão/sucesso. */
  value: T;
  source: 'deterministic' | 'judgment_advisory';
  judgment: JudgmentOutcome;
}>;

/**
 * A16 follow-up — UMA instância por Durable Object.
 *
 * O breaker e o teto de `JUDGMENT_MAX_CALLS_PER_TURN` por turno são ESTADO, e
 * o estado mora na instância. Uma instância por chamada os tornaria inócuos: o
 * teto se renovaria a cada avaliação e um circuito aberto seria esquecido no
 * turno seguinte (o judge que falha voltaria a ser chamado indefinidamente).
 *
 * O escopo é a INSTÂNCIA DO DO (um por workspace), nunca um singleton de
 * módulo: `WeakMap` por objeto de DO isola o teto e o breaker entre workspaces
 * e não sobrevive à reciclagem do DO (o estado é reconstruído do zero, que é a
 * postura fail-closed certa: sem histórico, o judge volta a ser consultado).
 *
 * `deps` valem na PRIMEIRA chamada: a config é resolvida uma vez por DO, como
 * qualquer config de runtime do Worker.
 */
const PROVIDERS_BY_DO = new WeakMap<object, JudgmentProvider>();

export const judgmentProviderForDo = (scope: object, deps: JudgmentProviderDeps = {}): JudgmentProvider => {
  const existing = PROVIDERS_BY_DO.get(scope);
  if (existing) return existing;
  const created = createJudgmentProvider(deps);
  PROVIDERS_BY_DO.set(scope, created);
  return created;
};

/**
 * Consumidor-exemplo mínimo: prefere o determinístico e só consulta o judge
 * quando ele está disponível. Uma decisão muda apenas `source` — o `value`
 * entregue é o determinístico em todos os caminhos, inclusive quando o judge
 * responde "yes".
 */
export const resolveWithJudgment = async <T>(
  deterministic: T,
  input: { provider: JudgmentProvider; request: JudgmentRequest },
): Promise<JudgmentResolution<T>> => {
  if (!input.provider.available) {
    return { value: deterministic, source: 'deterministic', judgment: judgmentUnavailable('not_configured') };
  }
  const judgment = await input.provider.evaluate(input.request);
  return {
    value: deterministic,
    source: judgment.status === 'decision' ? 'judgment_advisory' : 'deterministic',
    judgment,
  };
};