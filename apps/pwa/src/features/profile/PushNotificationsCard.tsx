"use client";

import { useEffect, useState } from "react";
import { disablePush, enablePush, getPushState, type PushState } from "@/lib/api/push-client";

export default function PushNotificationsCard({
  workspaceId,
  hideWhenActive = false,
}: {
  workspaceId?: string;
  hideWhenActive?: boolean;
}) {
  const [state, setState] = useState<PushState | "loading">(
    workspaceId ? "loading" : "unsupported",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) {
      return () => { cancelled = true; };
    }
    void getPushState()
      .then((next) => { if (!cancelled) setState(next); })
      .catch(() => { if (!cancelled) setState("unsupported"); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  async function activate() {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await enablePush(workspaceId);
      setState("active");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível ativar as notificações.");
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await disablePush(workspaceId);
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível desativar as notificações.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "active") {
    if (hideWhenActive) return null;
    return (
      <section
        className="mb-3 flex items-center justify-between gap-3 rounded-[14px] border border-border-subtle bg-surface-2/60 px-3.5 py-2.5"
        aria-label="Notificações no dispositivo"
      >
        <p role="status" className="text-[12px] font-semibold text-primary">
          Notificações ativas
        </p>
        <button
          type="button"
          onClick={() => void deactivate()}
          disabled={busy}
          className="text-[12px] font-semibold text-text-muted underline disabled:opacity-50"
        >
          {busy ? "Desativando…" : "Desativar"}
        </button>
      </section>
    );
  }

  return (
    <section className="mb-3 rounded-[16px] border border-border bg-fill-light p-4" aria-labelledby="push-title">
      <div className="mb-1 text-[15px] font-bold text-text-primary" id="push-title">Notificações no dispositivo</div>
      <p className="mb-3 text-[13px] leading-relaxed text-text-secondary">
        Receba lembretes importantes mesmo quando o Meu Ted estiver fechado.
      </p>

      {state === "loading" && <p role="status" className="text-[13px] text-text-muted">Verificando suporte…</p>}
      {state === "unsupported" && <p role="status" className="text-[13px] text-text-muted">Este navegador não oferece notificações push.</p>}
      {state === "install-required" && (
        <div className="space-y-2 text-[13px] text-text-secondary">
          <p className="font-semibold text-text-primary">No iPhone, instale o Meu Ted primeiro:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Abra o menu Compartilhar no Safari.</li>
            <li>Toque em <strong>Adicionar à Tela de Início</strong>.</li>
            <li>Abra o Meu Ted pelo novo ícone e volte aqui.</li>
          </ol>
        </div>
      )}
      {state === "ready" && (
        <button type="button" onClick={() => void activate()} disabled={busy} className="rounded-full bg-primary px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50">
          {busy ? "Ativando…" : "Ativar notificações"}
        </button>
      )}
      {state === "denied" && <p role="alert" className="text-[13px] text-text-secondary">Notificações bloqueadas. Reative-as nos ajustes do navegador.</p>}
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    </section>
  );
}
