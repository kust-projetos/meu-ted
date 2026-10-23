/**
 * Round3 HIGH: preflight PURO do harness de validação PG (sem I/O).
 *
 * A suíte de validação só pode tocar as duas bases descartáveis desta
 * rodada, e o guard de marker pré-existente (requireTestDatabase) deve
 * passar ANTES de qualquer escrita/migration/schema/cleanup. Nenhum
 * provisionamento automático existe aqui: sem CREATE DATABASE, sem criar
 * marker, sem pool, sem query. URL arbitrária é rejeitada antes de
 * qualquer conexão — o companion legado é o nome EXATO constante, nunca
 * derivado de entrada arbitrária.
 *
 * Limites exatos por perfil (qualquer divergência rejeita fail-closed):
 * - protocolo postgresql:, host loopback (127.0.0.1/localhost),
 *   porta 5433 explícita, database EXATO `ted_validation_20261021`;
 * - companion EXATO `ted_validation_20261021_legacy`;
 * - perfil CI explícito: loopback:5432, `pi_financeiro_test` e companion
 *   `pi_financeiro_test_legacy`.
 */

export const VALIDATION_DATABASE_NAME = 'ted_validation_20261021' as const;
export const VALIDATION_LEGACY_DATABASE_NAME = 'ted_validation_20261021_legacy' as const;
export const VALIDATION_POSTGRES_PORT = 5433 as const;
export const CI_VALIDATION_DATABASE_NAME = 'pi_financeiro_test' as const;
export const CI_VALIDATION_LEGACY_DATABASE_NAME = 'pi_financeiro_test_legacy' as const;
export type ValidationDatabaseProfile = 'local' | 'ci';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);

export class ValidationPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationPreflightError';
  }
}

export type ValidatedDatabaseUrl = {
  /** A URL exata informada (inalterada). */
  url: string;
  database: typeof VALIDATION_DATABASE_NAME | typeof CI_VALIDATION_DATABASE_NAME;
  host: string;
  port: typeof VALIDATION_POSTGRES_PORT | 5432;
};

export const validationDatabaseProfileFromEnvironment = (): ValidationDatabaseProfile => {
  const configured = process.env.VALIDATION_DATABASE_PROFILE;
  if (configured === undefined || configured === '') return 'local';
  if (configured === 'ci') return 'ci';
  return fail(`perfil '${configured}'`);
};

const fail = (reason: string): never => {
  throw new ValidationPreflightError(
    `validation preflight recusado (${reason}); esperado perfil local loopback:5433/${VALIDATION_DATABASE_NAME} ou perfil CI loopback:5432/${CI_VALIDATION_DATABASE_NAME}`,
  );
};

/**
 * Valida a URL da base de validação. Pura: nenhum I/O, pool ou query.
 * Rejeita ted_local, produção, outro host/porta/banco e lixo.
 */
export const assertValidationDatabaseUrl = (
  raw: unknown,
  profile: ValidationDatabaseProfile = 'local',
): ValidatedDatabaseUrl => {
  if (typeof raw !== 'string' || raw.trim() === '') return fail('URL ausente ou vazia');
  // Round4 HIGH: o pg resolve a connection string via pg-connection-string (2.13),
  // que PRIORIZA ?host=/?port= (socket/opcoes incluidos) sobre a authority da URL.
  // O new URL sozinho nao enxerga o override: TODA query (?) e hash (#) rejeitam,
  // sem allowlist. Nenhuma string chega ao pg antes do guard.
  if (/[?#]/.test(raw)) return fail('query/hash na URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail('URL inválida');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return fail(`protocolo '${parsed.protocol}'`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return fail(`host '${parsed.hostname}'`);
  const expectedPort = profile === 'ci' ? '5432' : String(VALIDATION_POSTGRES_PORT);
  const expectedDatabase = profile === 'ci' ? CI_VALIDATION_DATABASE_NAME : VALIDATION_DATABASE_NAME;
  if (parsed.port !== expectedPort) return fail(`porta '${parsed.port || '(ausente)'}'`);
  if (parsed.pathname !== `/${expectedDatabase}`) return fail(`database '${parsed.pathname}'`);
  return {
    url: raw,
    database: expectedDatabase,
    host: parsed.hostname.toLowerCase(),
    port: profile === 'ci' ? 5432 : VALIDATION_POSTGRES_PORT,
  };
};

/**
 * URL do companion legado: substitui o pathname pelo nome EXATO constante,
 * SOMENTE após a base passar no preflight. Entrada arbitrária nunca gera
 * companion — rejeita antes de derivar.
 */
export const validationCompanionUrl = (
  raw: unknown,
  profile: ValidationDatabaseProfile = 'local',
): string => {
  const base = assertValidationDatabaseUrl(raw, profile);
  const companion = new URL(base.url);
  companion.pathname = `/${profile === 'ci' ? CI_VALIDATION_LEGACY_DATABASE_NAME : VALIDATION_LEGACY_DATABASE_NAME}`;
  companion.search = '';
  companion.hash = '';
  return companion.toString();
};

/**
 * Cria os dois pools SOMENTE após o preflight passar. A factory é
 * injetada para prova unitária (URL rejeitada → factory nunca chamada:
 * nenhuma conexão, nenhum write).
 */
export const createValidationPools = <T>(opts: {
  baseUrl: string;
  profile?: ValidationDatabaseProfile;
  createPool: (connectionString: string) => T;
}): { main: T; legacy: T } => {
  const profile = opts.profile ?? 'local';
  const base = assertValidationDatabaseUrl(opts.baseUrl, profile);
  const companion = validationCompanionUrl(opts.baseUrl, profile);
  return { main: opts.createPool(base.url), legacy: opts.createPool(companion) };
};


/**
 * Round4 MEDIUM: prepara as duas bases de validacao com guards ANTES de qualquer
 * write/migration. Ordem fechada: preflight puro -> cria os dois pools (construir
 * pool nao escreve) -> guard main -> guard legacy -> migrate main -> migrate legacy
 * -> afterMigrate opcional (ex.: DDL de forma legada). Se qualquer guard falhar,
 * nada alem dele executa: zero migrations, zero schema, zero cleanup writes.
 * Delimitado ao harness de validacao: nao e framework, nao toca producao.
 */
export const prepareValidationDatabases = async <T>(opts: {
  baseUrl: string;
  profile?: ValidationDatabaseProfile;
  createPool: (connectionString: string) => T;
  requireGuard: (pool: T, operation: string) => Promise<void>;
  migrate: (pool: T) => Promise<unknown>;
  afterMigrate?: (pools: { main: T; legacy: T }) => Promise<void>;
}): Promise<{ main: T; legacy: T }> => {
  const profile = opts.profile ?? 'local';
  const base = assertValidationDatabaseUrl(opts.baseUrl, profile);
  const companion = validationCompanionUrl(opts.baseUrl, profile);
  const main = opts.createPool(base.url);
  const legacy = opts.createPool(companion);
  await opts.requireGuard(main, 'validation-main');
  await opts.requireGuard(legacy, 'validation-legacy');
  await opts.migrate(main);
  await opts.migrate(legacy);
  if (opts.afterMigrate !== undefined) await opts.afterMigrate({ main, legacy });
  return { main, legacy };
};
