/**
 * G-B (SPEC adendo 11.1.2): o inteiro exato atravessa a resposta.
 *
 * `transactions.amount_cents` e `BIGINT CHECK (> 0)` sem teto e o SQL ja
 * devolvia `SUM(...)::text` - exato. A perda estava 100% no `Number()` do
 * JavaScript: acima de 2^53 o double pula centavos em silencio.
 *
 * Regras fechadas aqui:
 *
 * - **`Number.isSafeInteger` e o gate.** Dentro dele NADA muda (o default
 *   permanece byte a byte, sem campos novos). Fora dele a resposta carrega o
 *   decimal exato e `approximate: true`.
 * - **BigInt e interno.** Ele reconstrói a soma exata a partir de addends ja
 *   exatos; o wire NUNCA carrega BigInt, somente a string decimal.
 * - **Nada e inventado.** Se algum addend nao e um inteiro seguro, o decimal
 *   exato nao pode ser reconstruido e NAO e publicado - o payload carrega
 *   apenas `approximate: true`, que e a forma honesta.
 */

/** Agregado + decimal exato, quando o decimal e comprovadamente exato. */
export type Cents = { cents: number; exactText?: string };

/** `SUM(...)::text` do Postgres: o texto e a autoridade, o number e o double. */
export const centsFromSqlText = (text: unknown): Cents => {
  if (text === null || text === undefined) return { cents: 0 };
  const exactText = String(text);
  return { cents: Number(exactText), exactText };
};

/**
 * Soma de addends ja carregados. Quando todos sao inteiros seguros a soma e
 * feita em BigInt e devolvida como decimal exato + double; caso contrario o
 * double e a soma comum (identica a de hoje) e o decimal e omitido.
 */
export const sumCents = (values: readonly number[]): Cents => {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      return { cents: values.reduce((acc, entry) => acc + entry, 0) };
    }
    total += BigInt(value);
  }
  return { cents: Number(total), exactText: total.toString() };
};

/**
 * Sums aggregates that already carry their own decimal (`Cents`).
 *
 * Re-summing the NUMBERS alone would throw the decimal away - a per-category
 * total above 2^53 is already a lossy double, and summing three of them is
 * worse. When every addend declares a decimal, that decimal is the authority
 * and the sum is exact; only when nobody can prove it does the result degrade
 * to the plain double with no `exactText`.
 */
export const mergeCents = (values: readonly Cents[]): Cents => {
  if (values.length === 0) return { cents: 0, exactText: '0' };
  if (values.every((value) => value.exactText !== undefined)) {
    const total = values.reduce((acc, value) => acc + BigInt(value.exactText as string), 0n);
    return { cents: Number(total), exactText: total.toString() };
  }
  if (values.every((value) => Number.isSafeInteger(value.cents))) return sumCents(values.map((value) => value.cents));
  return { cents: values.reduce((acc, value) => acc + value.cents, 0) };
};

export const isApproximateCents = (cents: number): boolean => !Number.isSafeInteger(cents);

/**
 * Companheiros de wire de um campo agregado: `{ approximate: true }` mais
 * `<campo>Exact` quando o decimal exato existe. Vazio dentro do safe integer,
 * entao nenhuma resposta default ganha campo novo.
 */
export const exactCentsCompanion = (field: string, value: Cents): Record<string, unknown> => {
  if (!isApproximateCents(value.cents)) return {};
  const companion: Record<string, unknown> = { approximate: true };
  if (value.exactText !== undefined) companion[`${field}Exact`] = value.exactText;
  return companion;
};