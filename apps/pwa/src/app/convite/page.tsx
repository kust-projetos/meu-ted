"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { ApiError } from "@/lib/api/client";
import { fetchSession, signInWithEmail, signUpWithEmail, verifyAccountInvite, registerDeviceToken } from "@/lib/api/auth";
import { acceptWorkspaceInvite, verifyWorkspaceInvite } from "@/lib/api/workspaces";
import { setToken, setSessionToken } from "@/lib/auth/token-store";

type VerifyResult = {
  email: string;
  householdId: string;
  role: string;
  expiresAt: string;
};

type InviteKind = "workspace" | "account" | null;

export default function ConvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";

  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(true);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [inviteKind, setInviteKind] = useState<InviteKind>(null);

  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  const [acceptBusy, setAcceptBusy] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [acceptSuccess, setAcceptSuccess] = useState(false);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupBusy, setSignupBusy] = useState(false);
  const [signupError, setSignupError] = useState<string | null>(null);

  // Token validity is derived during render (no setState-in-effect cascade).
  const tokenError = !token
    ? "Link de convite inválido. Verifique se o link foi copiado corretamente."
    : token.length !== 64
      ? "Token do convite deve conter 64 caracteres. Cole o link completo recebido por e-mail."
      : null;

  useEffect(() => {
    if (tokenError) return;
    let cancelled = false;
    (async () => {
      try {
        const wsResult = await verifyWorkspaceInvite(token);
        if (!cancelled) {
          setVerify(wsResult);
          setEmail(wsResult.email);
          setInviteKind("workspace");
          setVerifyError(null);
        }
      } catch (workspaceCause) {
        if (!cancelled && workspaceCause instanceof ApiError && workspaceCause.code === "invite.not_found") {
          try {
            const acResult = await verifyAccountInvite(token);
            if (!cancelled) {
              setVerify({ email: acResult.email, householdId: "", role: "member", expiresAt: acResult.expiresAt });
              setEmail(acResult.email);
              setInviteKind("account");
              setVerifyError(null);
            }
          } catch (accountCause) {
            if (!cancelled) {
const message =
                accountCause instanceof ApiError
                  ? accountCause.code === "invite.not_found"
                    ? "Convite não encontrado. Ele pode ter sido revogado ou já utilizado."
                    : accountCause.code === "invite.expired"
                      ? "Convite de conta expirado."
                      : accountCause.code === "invite.revoked"
                        ? "Convite de conta revogado."
                        : accountCause.code === "invite.already_used"
                          ? "Convite de conta já utilizado."
                          : accountCause.message
                  : "Não foi possível verificar o convite.";
              setVerifyError(message);
            }
          }
        } else if (!cancelled) {
          const message =
            workspaceCause instanceof ApiError
              ? workspaceCause.code === "invite.not_found"
                ? "Convite não encontrado. Ele pode ter sido revogado ou já utilizado."
                : workspaceCause.code === "invite.expired"
                  ? "Convite expirado. Peça um novo convite ao owner do workspace."
                  : workspaceCause.code === "invite.revoked"
                    ? "Convite revogado. Solicite um novo convite."
                    : workspaceCause.code === "invite.already_used"
                      ? "Convite já utilizado."
                      : workspaceCause.message
              : "Não foi possível verificar o convite.";
          setVerifyError(message);
        }
      } finally {
        if (!cancelled) setVerifyLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, tokenError]);

  const showVerifying = verifyLoading && !tokenError;
  const displayError = tokenError ?? verifyError;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchSession();
      if (!cancelled) {
        setSessionEmail(res.user?.email?.toLowerCase() ?? null);
        setSessionChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const clearTokenFromUrl = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.pathname + url.search);
    } catch {
      router.replace("/convite");
    }
  };

  const handleAccept = async () => {
    if (!token) return;
    setAcceptBusy(true);
    setAcceptError(null);
    try {
      await acceptWorkspaceInvite(token);
      setAcceptSuccess(true);
      clearTokenFromUrl();
      setTimeout(() => { router.replace("/workspaces"); }, 900);
    } catch (cause) {
      const message =
        cause instanceof ApiError
          ? cause.code === "invite.email_mismatch"
            ? "O e-mail da sua conta não confere com o do convite. Faça logout e entre com o e-mail convidado, ou crie a conta correta."
            : cause.message
          : "Não foi possível aceitar o convite.";
      setAcceptError(message);
    } finally {
      setAcceptBusy(false);
    }
  };

  const handleSignupAndAccept = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token || !verify) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail !== verify.email.toLowerCase()) {
      setSignupError(`O e-mail deve ser exatamente ${verify.email} para aceitar este convite.`);
      return;
    }
    if (!name.trim()) {
      setSignupError("Informe seu nome.");
      return;
    }
    if (password.length < 8) {
      setSignupError("A senha deve ter pelo menos 8 caracteres.");
      return;
    }
    setSignupBusy(true);
    setSignupError(null);
    try {
      const signUpRes = await signUpWithEmail({ email: normalizedEmail, password, name: name.trim() });
      const signUpToken = (signUpRes as unknown as { token?: string })?.token;
      // T2.2 B2/B3 (ADR-015): bearer legado só via token-store, atrás da
      // janela de compat (NEXT_PUBLIC_LEGACY_BEARER_COMPAT, review
      // 2026-12-01) — sem writes diretos em localStorage neste fluxo.
      if (signUpToken) {
        setSessionToken(signUpToken);
      }
      const signInRes = await signInWithEmail({ email: normalizedEmail, password });
      const sessionToken = (signInRes as unknown as { token?: string })?.token ?? signUpToken;
      if (sessionToken) {
        setSessionToken(sessionToken);
      }
      const deviceRes = await registerDeviceToken(sessionToken);
      if (deviceRes?.token) {
        setToken(deviceRes.token, deviceRes.householdId);
      }
      if (inviteKind === "workspace") {
        await acceptWorkspaceInvite(token);
      }
      setAcceptSuccess(true);
      clearTokenFromUrl();
      setTimeout(() => { router.replace("/workspaces"); }, 900);
    } catch (cause) {
      const message =
        cause instanceof ApiError
          ? cause.code === "auth.signup_requires_invite"
            ? "É necessário um convite pendente para criar conta com este e-mail."
            : cause.message
          : cause instanceof Error
            ? cause.message
            : "Não foi possível criar a conta.";
      setSignupError(message);
    } finally {
      setSignupBusy(false);
    }
  };

  const isLogged = sessionEmail !== null;

  const inviteTitle = inviteKind === "account" ? "Convite para criar conta" : "Convite de workspace";
  const inviteSubtitle = inviteKind === "account"
    ? "Você foi convidado a criar sua conta no Meu Ted."
    : "Aceite o convite para acessar o workspace compartilhado.";

  return (
    <main className="flex min-h-dvh flex-col bg-bg">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col px-5 py-10 sm:px-6">
        <div className="mb-8 text-center">
          <Image
            src="/logo.svg"
            alt="Meu Ted"
            width={48}
            height={48}
            className="mx-auto h-12 w-12"
          />
          <h1 className="mt-4 text-[22px] font-extrabold tracking-tight text-text-primary">{inviteTitle}</h1>
          <p className="mt-1 text-[13px] text-text-muted">{inviteSubtitle}</p>
        </div>

        {showVerifying && (
          <Card>
            <p className="py-6 text-center text-[13px] font-semibold text-text-muted">Verificando convite…</p>
          </Card>
        )}

        {!showVerifying && displayError && (
          <Card className="border-danger/20 bg-danger-tint">
            <p className="text-[13px] font-semibold text-danger" role="alert">{displayError}</p>
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="outline" className="w-full" onClick={() => router.push("/")}>Voltar ao início</Button>
              <Button type="button" className="w-full" onClick={() => router.push("/workspaces")}>Ir para Workspaces</Button>
            </div>
          </Card>
        )}

        {!showVerifying && !displayError && verify && acceptSuccess && (
          <Card className="border-primary/20 bg-primary-tint/30">
            <p className="text-[14px] font-bold text-primary">Convite aceito com sucesso!</p>
            <p className="mt-1 text-[12px] text-text-muted">Redirecionando para seus workspaces…</p>
          </Card>
        )}

        {!showVerifying && !displayError && verify && !acceptSuccess && (
          <>
            <Card elevation={2} className="space-y-3">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                  {inviteKind === "account" ? "Convite de conta" : "Detalhes do convite"}
                </p>
                <p className="mt-2 text-[13px]">
                  <span className="font-semibold text-text-primary">E-mail convidado:</span> <span className="font-bold text-primary">{verify.email}</span>
                </p>
                <p className="text-[11px] text-text-muted">Expira em {new Date(verify.expiresAt).toLocaleString("pt-BR")}</p>
              </div>
            </Card>

            {!sessionChecked ? (
              <Card className="mt-4">
                <p className="py-4 text-center text-[13px] text-text-muted">Verificando sessão…</p>
              </Card>
            ) : isLogged ? (
              <Card className="mt-4 space-y-4">
                <div>
                  <p className="text-[13px] text-text-muted">
                    Você está logado como <span className="font-bold text-text-primary">{sessionEmail}</span>.
                  </p>
                  {sessionEmail !== verify.email.toLowerCase() && (
                    <p className="mt-2 rounded-[10px] bg-warning-tint px-3 py-2 text-[12px] font-semibold text-warning" role="alert">
                      O e-mail da sua sessão ({sessionEmail}) não confere com o do convite ({verify.email}).
                      {inviteKind === "account"
                        ? " Faça login com o e-mail convidado para criar a conta."
                        : " Faça logout e entre com o e-mail convidado, ou crie a conta correta."}
                    </p>
                  )}
                </div>
                {inviteKind === "workspace" ? (
                  <>
                    {acceptError && (
                      <p className="rounded-[10px] bg-danger-tint px-3 py-2 text-[12px] font-semibold text-danger" role="alert">{acceptError}</p>
                    )}
                    <Button type="button" className="w-full" loading={acceptBusy} disabled={sessionEmail !== verify.email.toLowerCase()} onClick={() => void handleAccept()}>
                      Aceitar convite
                    </Button>
                    <p className="text-center text-[11px] text-text-muted">O token será removido da URL após o aceite.</p>
                  </>
                ) : (
                  <p className="text-[12px] text-text-muted">Para criar sua conta, faça logout e use o link novamente ou crie uma conta com este e-mail.</p>
                )}
              </Card>
            ) : (
              <Card className="mt-4">
                <h2 className="text-[15px] font-extrabold text-text-primary">
                  {inviteKind === "account" ? "Crie sua conta" : "Crie sua conta para aceitar"}
                </h2>
                <p className="mt-1 text-[12px] text-text-muted">
                  {inviteKind === "account"
                    ? "Sua conta será criada com este e-mail. Use exatamente o e-mail do convite."
                    : "Sua conta será criada vinculada a este convite. Use exatamente o e-mail convidado."}
                </p>
                <form onSubmit={handleSignupAndAccept} className="mt-4 space-y-3">
                  <div>
                    <label htmlFor="invite-name" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Nome</label>
                    <input id="invite-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Seu nome" required className="h-11 w-full rounded-[12px] border border-border-subtle bg-surface-2 px-3 text-[13px] text-text-primary outline-none focus:border-primary" />
                  </div>
                  <div>
                    <label htmlFor="invite-email" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">E-mail</label>
                    <input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required className="h-11 w-full rounded-[12px] border border-border-subtle bg-surface-2 px-3 text-[13px] text-text-primary outline-none focus:border-primary" />
                    <p className="mt-1 text-[10px] text-text-muted">Deve ser {verify.email}</p>
                  </div>
                  <div>
                    <label htmlFor="invite-password" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Senha (mín. 8 caracteres)</label>
                    <input id="invite-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} className="h-11 w-full rounded-[12px] border border-border-subtle bg-surface-2 px-3 text-[13px] text-text-primary outline-none focus:border-primary" />
                  </div>
                  {signupError && (<p className="rounded-[10px] bg-danger-tint px-3 py-2 text-[12px] font-semibold text-danger" role="alert">{signupError}</p>)}
                  <Button type="submit" className="w-full" loading={signupBusy}>
                    {inviteKind === "account" ? "Criar conta" : "Criar conta e aceitar convite"}
                  </Button>
                  <p className="text-center text-[11px] text-text-muted">
                    Após criar a conta, seu convite será aceito automaticamente e o token removido da URL.
                  </p>
                </form>
                <div className="mt-4 flex justify-center">
                  <button type="button" className="text-[12px] font-bold text-primary" onClick={() => router.push("/")}>Já tenho conta — fazer login</button>
                </div>
              </Card>
            )}
          </>
        )}

        {!token && !verifyLoading && (
          <p className="mt-6 text-center text-[11px] text-text-muted">
            Dica: o link de convite vem no formato <span className="font-mono">/convite?token=...64 caracteres...</span> e é enviado por e-mail.
          </p>
        )}
      </div>
    </main>
  );
}
