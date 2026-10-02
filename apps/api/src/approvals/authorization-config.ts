export type TedRiskBasedAutoexecuteMode = 'off' | 'shadow' | 'on';

/** Exact lowercase values only; unset and malformed values fail closed. */
export const parseTedRiskBasedAutoexecute = (raw: string | undefined): TedRiskBasedAutoexecuteMode =>
  raw === 'on' || raw === 'shadow' ? raw : 'off';

export const getTedRiskBasedAutoexecute = (): TedRiskBasedAutoexecuteMode =>
  parseTedRiskBasedAutoexecute(process.env.TED_RISK_BASED_AUTOEXECUTE);
