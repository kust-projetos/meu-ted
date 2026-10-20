/**
 * POC Fase 2 — telemetria mínima por turno (sem PII, sem segredos).
 *
 * Campos: tool/read executada, latência, tokens estimados (chars/4 quando o
 * modelo não é chamado), se o modelo foi chamado, fundamentada/concluída/
 * alucinação (preenchidos pela checagem do turno).
 */
export type PocTurnTelemetry = {
  readonly scenarioId: string;
  readonly tool: string | null;
  readonly read: string | null;
  readonly latencyMs: number;
  readonly inputTokensEst: number;
  readonly outputTokensEst: number;
  readonly modelCalled: boolean;
  readonly grounded: boolean;
  readonly completed: boolean;
  readonly hallucination: boolean;
};

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export const createPocTelemetry = (
  scenarioId: string,
  startedAt: number,
  input: { tool: string | null; read: string | null; modelCalled: boolean },
  output: { answerText: string; grounded: boolean; completed: boolean; hallucination: boolean },
  questionText: string,
): PocTurnTelemetry => ({
  scenarioId,
  tool: input.tool,
  read: input.read,
  latencyMs: Date.now() - startedAt,
  inputTokensEst: estimateTokens(questionText),
  outputTokensEst: estimateTokens(output.answerText),
  modelCalled: input.modelCalled,
  grounded: output.grounded,
  completed: output.completed,
  hallucination: output.hallucination,
});
