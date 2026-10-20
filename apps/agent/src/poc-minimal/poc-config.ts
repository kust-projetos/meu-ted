/**
 * POC Fase 2 (reads-only) — configuração de provider/modelo.
 *
 * Reutiliza o registry existente (`../llm/provider-registry.js`): o POC não
 * cria endpoint, alias ou protocolo próprios. Nenhum segredo é retornado ou
 * logado — só a PRESENÇA da key (boolean), como nos evals V3.
 */
import {
  PROVIDER_SECRET_MAP,
  getProviderEndpoint,
  resolveSecret,
} from '../llm/provider-registry.js';
import type { Protocol } from '../llm/provider-registry.js';

export const POC_DEFAULT_PROVIDER_KIND = 'opencode-zen';
export const POC_DEFAULT_PROTOCOL: Protocol = 'chat-completions';

export type PocModelConfig = {
  readonly providerKind: string;
  readonly modelId: string;
  readonly protocol: Protocol;
  readonly endpoint: string;
  readonly keyAlias: string;
  /** Só presença — nunca o valor. */
  readonly keyPresent: boolean;
};

export const resolvePocModelConfig = (
  env: Record<string, string | undefined>,
): PocModelConfig => {
  const providerKind = env.TED_POC_PROVIDER?.trim() || POC_DEFAULT_PROVIDER_KIND;
  const modelId = env.TED_POC_MODEL?.trim() || 'poc-cheap-default';
  const protocol = POC_DEFAULT_PROTOCOL;
  const alias = PROVIDER_SECRET_MAP[providerKind];
  if (!alias) throw new Error(`poc.config_unknown_provider:${providerKind}`);
  const endpoint = getProviderEndpoint(providerKind);
  const secret = resolveSecret(alias, env);
  return {
    providerKind,
    modelId,
    protocol,
    endpoint,
    keyAlias: alias,
    keyPresent: typeof secret === 'string' && secret.trim().length > 0,
  };
};

/** Linha sanitizada para log/telemetria: sem segredo, sem valor de key. */
export const describePocModelConfig = (config: PocModelConfig): string =>
  `provider=${config.providerKind} model=${config.modelId} protocol=${config.protocol} key=${config.keyAlias}:${config.keyPresent ? 'present' : 'absent'}`;
