"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import { getToken, clearToken, setToken, setSessionToken } from "@/lib/auth/token-store";
import { ApiError, clearActiveWorkspaceId } from "@/lib/api/client";
import { signInWithEmail, registerDeviceToken, verifyDeviceToken, fetchSession, type SessionUser, type SessionProbeStatus } from "@/lib/api/auth";
import { clearSensitiveSession } from "@/lib/session";
import { SessionProvider, type SessionSnapshot } from "@/lib/auth/session-context";
import { setSessionStatus, getSessionStatus } from "@/lib/auth/session-authority";
import {
  setOfflinePrincipalId,
  getOfflinePrincipalId,
  getOfflineWorkspaceId,
} from "@/lib/auth/offline-identity";
import { resolveUnreachableOfflineRoute } from "@/lib/state/snapshot-db";
import { Lock, Mail, ArrowRight } from "lucide-react";
import { Splash } from "@/components/Splash";

type AuthState = "loading" | "login" | "unlocked";

interface Props {
  children: React.ReactNode;
}

export function AuthGate({ children }: Props) {
  const [state, setState] = useState<AuthState>("loading");
  const [error, setError] = useState("");
  // V4.1 Closure AUTH-01: explicit session authority mirrored from the
  // probe. Written to the module store synchronously BEFORE unlocking so
  // AppStateProvider (mounted as a child) boots with the right authority.
  //
  // T07c-F2R2-F1: reprobe epoch. Every authority-identity change in this
  // gate (publishSession, bindPrincipal — login, logout, expiry, and the
  // reprobe's own flip) bumps it. A recovery probe captures the epoch at
  // start and discards a late response on mismatch, so a stale probe can
  // never bind/publish over a newer authority (e.g. expireSession or a
  // different login that landed mid-flight). No shared epoch source exists
  // (session-authority is a plain setter), so this AuthGate-local counter is
  // the documented equivalent.
  const probeEpochRef = useRef(0);
  const [session, setSessionValue] = useState<SessionSnapshot>({ status: "unknown" });
  const publishSession = useCallback((next: SessionSnapshot) => {
    probeEpochRef.current += 1;
    setSessionStatus(next);
    setSessionValue(next);
  }, []);
  // Phase 3 (AUTH-02): persist the server-confirmed user identity for
  // offline partitioning. Non-secret, non-authenticator — never a bearer,
  // device secret, or cookie value. Best-effort, never blocks the boot.
  const bindPrincipal = useCallback((user: { id: string }) => {
    try {
      setOfflinePrincipalId(user.id);
      probeEpochRef.current += 1;
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // FIX-FINAL-2 FINDING 1 (ADR-015 cookie-first) + V4.1 Closure AUTH-04:
      // the boot ALWAYS probes the cookie session first (GET /auth/session).
      // The probe distinguishes authenticated / unauthenticated (401/403,
      // 2xx-without-user) / unreachable (network — NEVER logout). A stored
      // device token is scoped (registration/verification/rotation) and
      // never decides the session alone — an invalid device token (401)
      // drops ONLY the device token; the cookie session is never cleared
      // on this path.
      let sessionUser: SessionUser | null = null;
      let probeStatus: SessionProbeStatus = "unreachable";
      try {
        const session = await fetchSession();
        sessionUser = session?.user ?? null;
        probeStatus = session?.status ?? (sessionUser ? "authenticated" : "unauthenticated");
      } catch {
        sessionUser = null;
        probeStatus = "unreachable";
      }

      const token = getToken();
      // V41C FIX 2: the single unreachable decider — shared by the
      // tokenless and token paths below. A probe that never reached the
      // server must NEVER unlock live I/O: only a valid, within-TTL V3
      // envelope for the bound identity unlocks (offline read-only, INV-06
      // — no write queue exists); anything else stays on the offline/login
      // screen. Never purges here — unreachability is not a rejection.
      const unlockOrLoginForUnreachable = async (): Promise<void> => {
        let offline = false;
        try {
          const route = await resolveUnreachableOfflineRoute(
            getOfflinePrincipalId(),
            getOfflineWorkspaceId(),
          );
          offline = route === "offline-read-only";
        } catch {
          offline = false;
        }
        if (cancelled) return;
        if (offline) {
          publishSession({
            status: "unreachable",
            offlinePrincipalId: getOfflinePrincipalId() ?? undefined,
          });
          setState("unlocked");
        } else {
          publishSession({ status: "unreachable" });
          setState("login");
        }
      };
      if (!token) {
        // T2.5 (ADR-015 Opção C, session-first): the boot MUST NOT depend on
        // the device token. Without one, a valid cookie session is enough to
        // operate — GET /auth/session is the scoped session check.
        // Fail-closed: unauthenticated means login. Unreachable means the
        // server never answered: record it as unreachable (NOT a logout —
        // nothing is purged). Phase 3 (AUTH-T03) routes it through the V3
        // snapshot below — valid + within TTL unlocks offline read-only,
        // otherwise the login screen. The distinction survives in the
        // session authority instead of collapsing into login-state.
        if (probeStatus === "authenticated" && sessionUser) {
          bindPrincipal(sessionUser);
          publishSession({
            status: "authenticated",
            user: { userId: sessionUser.id, email: sessionUser.email, name: sessionUser.name },
          });
          if (!cancelled) setState("unlocked");
        } else if (probeStatus === "unreachable") {
          // Phase 3 (AUTH-03/AUTH-04): unreachability is not a rejection —
          // never purge here. Consult the V3 snapshot: a valid,
          // within-TTL envelope for the last bound identity unlocks offline
          // read-only; otherwise the login screen (no false logout).
          await unlockOrLoginForUnreachable();
        } else {
          // V41C FIX 4 (INV-05/AUTH-T04): explicit server rejection with no
          // device token — purge offline identity + snapshots BEFORE
          // publishing login, so a later unavailability cannot reopen
          // financial data from the snapshot. Same purge contract as
          // expireSession below.
          await clearSensitiveSession({
            clearToken: true,
            clearV1Snapshot: true,
            clearProfile: true,
            clearOfflineIdentity: true,
          }).catch(() => {});
          if (cancelled) return;
          publishSession({ status: "unauthenticated" });
          if (!cancelled) setState("login");
        }
        return;
      }

      try {
        await verifyDeviceToken(token);
        // Compat path: a verified device token unlocks as before. It only
        // proves the session authority when the cookie probe agrees
        // (authenticated → live). Otherwise the V41C FIX 1 gate keeps live
        // bootstrap closed for non-authenticated authority.
        if (sessionUser) {
          bindPrincipal(sessionUser);
          publishSession({
            status: "authenticated",
            user: { userId: sessionUser.id, email: sessionUser.email, name: sessionUser.name },
          });
          if (!cancelled) setState("unlocked");
          return;
        }
        if (probeStatus === "unreachable") {
          // V41C FIX 2: the probe never reached the server — a verified
          // device token alone must not unlock. Same V3 route as tokenless.
          await unlockOrLoginForUnreachable();
          return;
        }
        // W1 item 2 (Onda 1): o probe respondeu explicitamente "sem sessão"
        // mas a verificação do device passou — FAIL CLOSED. Um device token
        // verificado sozinho nunca concede autoridade de shell: purga a
        // identidade offline + snapshots (V1/V2/V3) ANTES do login para que
        // uma indisponibilidade posterior não reabra dados de outro
        // principal (INV-05), preserva o device recém-verificado e conduz
        // ao login. Nunca `unknown` com shell liberado.
        await clearSensitiveSession({
          clearToken: false,
          clearV1Snapshot: true,
          clearProfile: true,
          clearOfflineIdentity: true,
        }).catch(() => {});
        if (cancelled) return;
        publishSession({ status: "unauthenticated" });
        if (!cancelled) {
          setError("Sessão não confirmada. Faça login novamente.");
          setState("login");
        }
        return;
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          // Scoped device token expired/rotated/revoked: drop ONLY it. When
          // the cookie session is still valid the user stays unlocked; when
          // the probe never reached the server (unreachable) the offline
          // identity + snapshot survive and the V3 route decides (read-only
          // when valid — unreachability is not a rejection, nothing is
          // purged). Only an explicit probe rejection falls through to the
          // fail-closed purge + login below.
          try {
            clearToken();
          } catch {
            /* noop */
          }
          if (sessionUser) {
            bindPrincipal(sessionUser);
            publishSession({
              status: "authenticated",
              user: { userId: sessionUser.id, email: sessionUser.email, name: sessionUser.name },
            });
            if (!cancelled) setState("unlocked");
            return;
          }
          if (probeStatus === "unreachable") {
            await unlockOrLoginForUnreachable();
            return;
          }
          await clearSensitiveSession({
            clearToken: true,
            clearV1Snapshot: true,
            clearProfile: true,
            clearOfflineIdentity: true,
          }).catch(() => {});
          publishSession({ status: "unauthenticated" });
          if (!cancelled) {
            setError("Sessão antiga expirada. Faça login novamente.");
            setState("login");
          }
          return;
        }
        // V41C FIX 2: a non-401 verification failure proves nothing. When
        // the cookie probe confirmed a session, that confirmation stands
        // (device-endpoint flakiness must not kill it). When the probe never
        // reached the server, only the validated V3 route may unlock
        // (offline read-only, never live). When the probe EXPLICITLY
        // rejected the session (2xx-without-user/401/403), a device-endpoint
        // failure (e.g. operational 403) never reopens the offline route:
        // purge as an explicit rejection and conclude login.
        if (sessionUser) {
          bindPrincipal(sessionUser);
          publishSession({
            status: "authenticated",
            user: { userId: sessionUser.id, email: sessionUser.email, name: sessionUser.name },
          });
          if (!cancelled) setState("unlocked");
          return;
        }
        if (probeStatus === "unreachable") {
          await unlockOrLoginForUnreachable();
          return;
        }
        await clearSensitiveSession({
          clearToken: true,
          clearV1Snapshot: true,
          clearProfile: true,
          clearOfflineIdentity: true,
        }).catch(() => {});
        if (cancelled) return;
        publishSession({ status: "unauthenticated" });
        if (!cancelled) {
          setError("Sessão não confirmada. Faça login novamente.");
          setState("login");
        }
      }
    };
    init();

    return () => {
      cancelled = true;
    };
  }, [publishSession, bindPrincipal]);

  const handleLogin = useCallback(async (credentials: { email: string; password: string }) => {
    setError("");
    clearActiveWorkspaceId();
    try {
      const signInRes = await signInWithEmail(credentials);
      const sessionToken = signInRes?.token;
      // T2.2 B2/B3 (ADR-015): escrita do bearer legado atrás da janela de
      // compat (NEXT_PUBLIC_LEGACY_BEARER_COMPAT, review 2026-12-01) dentro
      // da token-store — sem writes diretos em localStorage aqui. Com a
      // flag off, a sessão opera 100% via cookie HttpOnly.
      if (sessionToken) {
        setSessionToken(sessionToken);
      }

      const res = await registerDeviceToken(sessionToken);

      if (!res?.token) {
        throw new Error("Token de dispositivo não retornado pelo servidor.");
      }

      setToken(res.token);

      // W1 item 2 (Onda 1): sign-in + device register 2xx provam a
      // autenticação, mas a IDENTIDADE (principal) só vale quando validada
      // pelo probe canônico (/auth/session). Sem usuário no probe, falhar
      // fechado: nunca marcar authenticated nem criar offlinePrincipalId a
      // partir do e-mail digitado (identidade inventada ligaria o snapshot
      // V3 ao dono errado). O contrato de signInRes.user não é comprovado
      // como o ID canônico de /auth/session, então é ignorado.
      try {
        const probe = await fetchSession();
        if (probe.user) {
          bindPrincipal(probe.user);
          publishSession({
            status: "authenticated",
            user: { userId: probe.user.id, email: probe.user.email, name: probe.user.name },
          });
          setState("unlocked");
          return;
        }
        if (probe.status === "unreachable") {
          // O servidor nunca respondeu: indisponibilidade não apaga
          // snapshot/identidade válidos — permanece no login com erro para
          // nova tentativa, sem I/O autenticado e sem V3 ligado.
          publishSession({ status: "unreachable" });
          setError("Não foi possível confirmar a sessão. Verifique a conexão e tente novamente.");
          return;
        }
        // Rejeição explícita (2xx-sem-usuário/401/403): purge + login, o
        // mesmo contrato de expireSession — nunca offline e nunca unlock.
        await clearSensitiveSession({
          clearToken: true,
          clearV1Snapshot: true,
          clearProfile: true,
          clearOfflineIdentity: true,
        }).catch(() => {});
        publishSession({ status: "unauthenticated" });
        setError("Sessão não confirmada. Faça login novamente.");
      } catch {
        // fetchSession não rejeita por contrato; defesa residual com a
        // mesma semântica de indisponibilidade (sem purge).
        publishSession({ status: "unreachable" });
        setError("Não foi possível confirmar a sessão. Verifique a conexão e tente novamente.");
      }
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        if (e.status === 401 || e.status === 400) {
          setError("E-mail ou senha incorretos.");
        } else {
          setError(e.message || "Falha na autenticação.");
        }
      } else if (e instanceof Error) {
        setError(e.message || "Falha ao realizar login.");
      } else {
        setError("Falha ao realizar login.");
      }
      throw e;
    }
  }, [bindPrincipal]);

  const expireSession = useCallback(async (message?: string) => {
    // 401/403: explicit server rejection → purge everything offline (V1/V2/V3
    // snapshots, tokens, profile, offline identity + stamp) + login. Never
    // offline mode on this path (AUTH-T04/T05, INV-05).
    await clearSensitiveSession({
      clearToken: true,
      clearV1Snapshot: true,
      clearProfile: true,
      clearOfflineIdentity: true,
    });
    // 401/403: explicit server rejection → unauthenticated (purge + login).
    publishSession({ status: "unauthenticated" });
    setError(message ?? "Sessão expirada. Faça login novamente.");
    setState("login");
  }, [publishSession]);

  // T07c-F2: network-recovery reprobe. The boot probe runs once; without a
  // reprobe an offline-booted shell stays `unreachable` forever even after
  // the network returns, so WorkspaceProvider never revalidates. There is
  // no shared online-state signal in the app (app-state-context consumes
  // none — no `online` listener, no `navigator.onLine` anywhere; verified
  // T07c-F2), so this owned-side `window "online"` listener is the
  // documented equivalent. Recovery probe: flips unreachable→authenticated
  // on a server-confirmed user; routes explicit server rejection to the
  // canonical expiry treatment exactly as boot does (T07c-F2R2-F2); preserves
  // the offline shell on unreachability/transport/5xx (never purge there).
  // Single-flight guarded, no polling. Declared after expireSession so the
  // dep array never reads it in TDZ.
  //
  // T07c-F2R2-F1: generation-based invalidation. The epoch is captured at
  // probe start; after the await, an epoch mismatch means the authority
  // moved while the probe was in flight (expireSession, login/logout —
  // every identity change bumps the epoch via publishSession/bindPrincipal),
  // so the late response is discarded silently: no bind, no publication.
  // The live-authority re-check covers the same window for changes that
  // bypassed the epoch (none exist in this gate, but the probe's offline
  // reason must still apply at commit time).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let inFlight = false;
    const onOnline = () => {
      if (cancelled || inFlight) return;
      // Only an unreachable authority is eligible: authenticated stays put
      // (no-op) and unauthenticated stays on login (login re-probes
      // explicitly on submit).
      if (getSessionStatus().status !== "unreachable") return;
      const epoch = probeEpochRef.current;
      inFlight = true;
      void (async () => {
        try {
          const probe = await fetchSession();
          if (cancelled) return;
          if (probeEpochRef.current !== epoch) return;
          if (getSessionStatus().status !== "unreachable") return;
          // Server-confirmed principal only (INV-03/W1-item-2): bind + flip.
          if (probe?.user) {
            bindPrincipal(probe.user);
            publishSession({
              status: "authenticated",
              user: { userId: probe.user.id, email: probe.user.email, name: probe.user.name },
            });
            return;
          }
          // Explicit server rejection (2xx-without-user, 401/403 — fetchSession
          // classifies all three as unauthenticated): canonical expiry
          // treatment exactly as boot does. Unreachability/transport/5xx
          // preserves the offline shell.
          if (probe && probe.status === "unauthenticated") {
            await expireSession();
          }
        } catch {
          /* transport failure = still unreachable; a later `online` retries */
        } finally {
          inFlight = false;
        }
      })();
    };
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
  }, [publishSession, bindPrincipal, expireSession]);

  if (state === "unlocked")
    return <SessionProvider value={{ expireSession, session }}>{children}</SessionProvider>;
  if (state === "loading") return <Splash />;

  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-bg p-5 sm:p-8">
      {/* Background Ambient Glow */}
      <div className="pointer-events-none absolute -top-24 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />

      {state === "login" && (
        <LoginForm onSubmit={handleLogin} error={error} />
      )}
    </main>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function LoginForm({
  onSubmit,
  error,
}: {
  onSubmit: (credentials: { email: string; password: string }) => Promise<void> | void;
  error: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e?: React.FormEvent | React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!email.trim() || !password.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({ email: email.trim(), password: password.trim() });
    } catch {
      // Errors handled in AuthGate state
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative w-full max-w-sm rounded-[24px] border border-border-subtle bg-surface-1 p-6 sm:p-8 shadow-card backdrop-blur-xl">
      <form
        action="#"
        method="post"
        onSubmit={handleSubmit}
        noValidate
        className="space-y-5"
      >
        <div className="text-center space-y-2">
          {/* Logo Badge */}
          <Image
            src="/logo.svg"
            alt="Meu Ted"
            width={48}
            height={48}
            priority
            className="mx-auto h-12 w-12 drop-shadow-[0_4px_18px_rgba(14,140,90,0.35)]"
          />
          <h1 className="text-[22px] font-bold tracking-tight text-text-primary">Meu Ted</h1>
          <p className="text-[13px] font-medium text-text-muted">
            tudo em dia.
          </p>
        </div>

        <div className="space-y-3.5">
          <fieldset>
            <label htmlFor="email" className="block text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1.5">
              E-mail
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted">
                <Mail size={16} />
              </span>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleSubmit(e);
                  }
                }}
                placeholder="seu.email@exemplo.com"
                autoComplete="email"
                autoFocus
                required
                disabled={submitting}
                className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-10 pr-3.5 text-[16px] font-medium text-text-primary outline-none focus:border-primary disabled:opacity-50 transition-colors"
              />
            </div>
          </fieldset>

          <fieldset>
            <label htmlFor="password" className="block text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1.5">
              Senha
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted">
                <Lock size={16} />
              </span>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleSubmit(e);
                  }
                }}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                disabled={submitting}
                className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-10 pr-3.5 text-[16px] font-medium text-text-primary outline-none focus:border-primary disabled:opacity-50 transition-colors"
              />
            </div>
          </fieldset>
        </div>

        {error && (
          <div className="rounded-[12px] bg-danger-tint px-3.5 py-2.5 text-center text-[12px] font-semibold text-danger" role="alert">
            ⚠ {error}
          </div>
        )}

        <button
          type="submit"
          disabled={!email.trim() || !password.trim() || submitting}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void handleSubmit(e);
          }}
          className="flex items-center justify-center gap-2 w-full rounded-[14px] bg-primary py-3.5 text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98] disabled:opacity-50 cursor-pointer"
        >
          {submitting ? "Entrando…" : "Entrar"}
          {!submitting && <ArrowRight size={16} strokeWidth={2.4} />}
        </button>
      </form>
    </div>
  );
}
