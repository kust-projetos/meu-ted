/**
 * Única abstração de armazenamento de sessão (V4 T2.2 B2).
 *
 * Duas chaves com contratos DISTINTOS (T04, remediação wave1-pwa):
 *
 * - `pi-finance:token` = DEVICE token (vínculo H-12, emitido por
 *   POST /auth/devices/register). NÃO é bearer legado: persiste SEMPRE,
 *   independente da janela de compat — o mint do Agent (`agent-auth.ts`
 *   self-heal) depende dele, e com a flag off cada request repetiria o
 *   register (storm sequencial que bloqueia o flip da Release B). Nunca é
 *   anexado como `Authorization` (T2.5 removeu o attach universal; só vai
 *   como `x-device-token` explícito em fluxos escopados).
 * - `pi-finance:session-token` = bearer legado de sessão (fallback
 *   `Authorization` da janela ADR-011/015). Escrita+leitura atrás de
 *   `NEXT_PUBLIC_LEGACY_BEARER_COMPAT` (default true = janela aberta; leitura
 *   em call-time para `vi.stubEnv` nos testes). Com a flag off, nenhum bearer
 *   legado é persistido — a sessão opera 100% via cookie HttpOnly
 *   (`credentials: "include"` no client). Revisão/remoção: 2026-12-01
 *   (janela ADR-011/T5.4).
 *
 * T2.3 (B3 passos 4–6, DECISÃO: flag única, sem sub-flag) controlava
 * leitura+escrita juntas das DUAS chaves; a T04 desgaterou só a chave de
 * device (o bearer legado continua gateado como está). `clearToken()` nunca
 * foi gateado (logout/invalidação funcionam com qualquer flag) e
 * `cleanupOrphanedLegacyTokens()` (boot via RootProviders) apaga só o
 * session-token órfão — o device é preservado.
 */

const PREFIX = "pi-finance:";

type EnvLike = Record<string, string | undefined>;

const COMPAT_OFF_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Janela de compat do bearer legado aberta? Default true. Leitura em
 * call-time (nunca snapshot de build) para permitir toggle em teste.
 */
export function isLegacyBearerCompatEnabled(env?: EnvLike): boolean {
  try {
    // Keep the browser-bundle reference static: Next replaces direct
    // `process.env.NEXT_PUBLIC_*` access at build time, but cannot inline a
    // dynamic `process.env[key]` lookup. Tests may still inject an explicit
    // env object to exercise the call-time compatibility switch.
    const raw = env !== undefined
      ? env["NEXT_PUBLIC_LEGACY_BEARER_COMPAT"]
      : typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_LEGACY_BEARER_COMPAT
        : undefined;
    if (raw === undefined) return true;
    return !COMPAT_OFF_VALUES.has(raw.trim().toLowerCase());
  } catch {
    return true;
  }
}

function getStorage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof globalThis !== "undefined" && globalThis.localStorage) return globalThis.localStorage;
  return null;
}

export function getToken(): string | null {
  // T04: chave de DEVICE (vínculo H-12) — fora do gate de compat do bearer
  // legado. O mint do Agent precisa reler o token persistido com a flag off;
  // sem isso, cada request repetiria POST /auth/devices/register.
  try {
    return getStorage()?.getItem(`${PREFIX}token`) ?? null;
  } catch {
    return null;
  }
}
export function setToken(token: string): void {
  // T04: device persiste sempre (ver doc do módulo). O gate de compat segue
  // valendo só para o bearer legado de sessão (setSessionToken).
  try {
    getStorage()?.setItem(`${PREFIX}token`, token);
  } catch {
    /* noop */
  }
}
export function clearToken(): void {
  try {
    getStorage()?.removeItem(`${PREFIX}token`);
  } catch {
    /* noop */
  }
}

const SESSION_PREFIX = "pi-finance:session-token";

export function getSessionToken(): string | null {
  // T2.3 B3.5: flag off => leitura removida (órfão ignorado, zero reads).
  if (!isLegacyBearerCompatEnabled()) return null;
  try {
    return getStorage()?.getItem(SESSION_PREFIX) ?? null;
  } catch {
    return null;
  }
}
export function setSessionToken(token: string): void {
  // B3 coexistência: sem a janela de compat, o bearer legado não é persistido.
  if (!isLegacyBearerCompatEnabled()) return;
  try {
    getStorage()?.setItem(SESSION_PREFIX, token);
  } catch {
    /* noop */
  }
}
export function clearSessionToken(): void {
  try {
    getStorage()?.removeItem(SESSION_PREFIX);
  } catch {
    /* noop */
  }
}

/**
 * T2.3 (B3 passo 4–6, caminho de limpeza do B2) + T04: remove o bearer legado
 * de sessão órfão no boot quando a janela de compat está fechada. Com a flag
 * on, no-op (coexistência B3.1 — nunca apaga sessão ativa legada no meio da
 * janela). Chamado uma vez no boot via RootProviders. O DEVICE token
 * (`pi-finance:token`) é PRESERVADO em qualquer flag — apagá-lo no boot
 * recriaria o register storm do mint a cada carregamento (T04).
 */
export function cleanupOrphanedLegacyTokens(): void {
  if (isLegacyBearerCompatEnabled()) return;
  clearSessionToken();
}
