"use client";

import { useState, useEffect, type FormEvent } from "react";
import { Archive, Check, FolderKanban, Pencil, Plus, RotateCcw, Users, X, History, Send } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import StatusBar from "@/components/StatusBar";
import { Button } from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Dialog from "@/components/ui/Dialog";
import EmptyState from "@/components/ui/EmptyState";
import { useWorkspace } from "@/lib/auth/workspace-context";
import type { Workspace } from "@/lib/api/workspaces";
import { createWorkspaceInvite } from "@/lib/api/workspaces";
import { ApiError } from "@/lib/api/client";
import { fetchAuditLogs, type AuditLog } from "@/lib/api/endpoints";

type WorkspaceKind = Workspace["kind"];

const kindLabels: Record<WorkspaceKind, string> = {
  personal: "Pessoal",
  shared: "Compartilhado",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join("") || "W").toUpperCase();
}

function workspaceColor(workspace: Workspace): string {
  if (workspace.kind === "personal") return "#0E8C5A";
  let hash = 0;
  for (const character of workspace.name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return ["#7A5AF8", "#D97706", "#2563EB", "#C2415D"][hash % 4]!;
}

export default function WorkspaceManagerPage() {
  const {
    workspaces,
    activeWorkspace,
    members,
    pendingInvites,
    ownershipTransfers,
    loading,
    error,
    selectWorkspace,
    refreshWorkspaces,
    createWorkspace,
    renameWorkspace,
    archiveWorkspace,
    restoreWorkspace,
    inviteMember,
    resendInvite,
    revokeInvite,
    transferOwnership,
    acceptTransfer,
  } = useWorkspace();
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<WorkspaceKind>("shared");
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null);
  const [editingName, setEditingName] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<Workspace | null>(null);
  const [busyWorkspaceId, setBusyWorkspaceId] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<import("@/lib/api/workspaces").PendingInvite | null>(null);
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [transferTargetUserId, setTransferTargetUserId] = useState("");
  const [transferConfirmOpen, setTransferConfirmOpen] = useState(false);
  const [acceptTransferTarget, setAcceptTransferTarget] = useState<import("@/lib/api/workspaces").OwnershipTransfer | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);

  // Card-specific invite state for shared workspace cards
  const [cardInviteEmails, setCardInviteEmails] = useState<Record<string, string>>({});
  const [cardInviteBusy, setCardInviteBusy] = useState<Record<string, boolean>>({});

  // Audit logs modal state
  const [logsWorkspace, setLogsWorkspace] = useState<Workspace | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const active = workspaces.filter((workspace) => workspace.status !== "archived");
  const archived = workspaces.filter((workspace) => workspace.status === "archived");
  const activeMembers = activeWorkspace?.kind === "shared" ? members.length : 0;

  const handleCloseLogs = () => {
    setLogsWorkspace(null);
    setAuditLogs([]);
    setLogsError(null);
  };

  useEffect(() => {
    if (!logsWorkspace) return;
    let cancelled = false;
    async function loadLogs() {
      setLogsLoading(true);
      setLogsError(null);
      try {
        const result = await fetchAuditLogs({ limit: 20, workspaceId: logsWorkspace!.id });
        if (!cancelled) setAuditLogs(result.items);
      } catch (cause) {
        if (!cancelled) setLogsError(cause instanceof Error ? cause.message : "Não foi possível carregar logs");
      } finally {
        if (!cancelled) setLogsLoading(false);
      }
    }
    void loadLogs();
    return () => { cancelled = true; };
  }, [logsWorkspace]);

  function isDuplicateEmail(email: string): boolean {
    const lower = email.trim().toLowerCase();
    if (!lower) return false;
    const memberDup = members.some((m) => m.email.toLowerCase() === lower);
    const pendingDup = pendingInvites.some((i) => i.email.toLowerCase() === lower);
    return memberDup || pendingDup;
  }

  async function handleCardInvite(event: FormEvent<HTMLFormElement>, workspaceId: string) {
    event.preventDefault();
    const email = (cardInviteEmails[workspaceId] ?? "").trim();
    if (!email) return;
    // Validacao email duplicado (apenas quando workspace do card é o ativo, onde temos dados de membros)
    if (activeWorkspace?.id === workspaceId && isDuplicateEmail(email)) {
      setActionError("Este e-mail já é membro ou possui convite pendente.");
      return;
    }
    setCardInviteBusy((prev) => ({ ...prev, [workspaceId]: true }));
    setActionError(null);
    try {
      if (activeWorkspace?.id === workspaceId) {
        await inviteMember(email);
      } else {
        await createWorkspaceInvite(workspaceId, email);
      }
      setCardInviteEmails((prev) => ({ ...prev, [workspaceId]: "" }));
    } catch (cause) {
      const message =
        cause instanceof ApiError && cause.code === "auth.invite_forbidden"
          ? "Apenas o owner pode convidar quem ainda não possui conta."
          : cause instanceof Error
            ? cause.message
            : "Não foi possível enviar o convite.";
      setActionError(message);
    } finally {
      setCardInviteBusy((prev) => ({ ...prev, [workspaceId]: false }));
    }
  }
  const otherMembers = members.filter((m) => m.role !== "owner");
  const activePendingTransfer = ownershipTransfers?.find((t) => t.status === "pending");
  const pendingTransferForMember = activeWorkspace?.role === "member" ? activePendingTransfer : null;

  async function handleResendInvite(inviteId: string) {
    setResendingInviteId(inviteId);
    setActionError(null);
    try {
      await resendInvite(inviteId);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Não foi possível reenviar o convite.");
    } finally {
      setResendingInviteId(null);
    }
  }

  async function handleRevokeInvite() {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    setActionError(null);
    try {
      await revokeInvite(revokeTarget.id);
      setRevokeTarget(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Não foi possível revogar o convite.");
    } finally {
      setRevokeBusy(false);
    }
  }

  async function handleTransferOwnership() {
    if (!transferTargetUserId) return;
    setTransferBusy(true);
    setActionError(null);
    try {
      await transferOwnership(transferTargetUserId);
      setTransferConfirmOpen(false);
      setTransferTargetUserId("");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Não foi possível transferir a titularidade.");
    } finally {
      setTransferBusy(false);
    }
  }

  async function handleAcceptTransfer() {
    if (!acceptTransferTarget) return;
    setTransferBusy(true);
    setActionError(null);
    try {
      await acceptTransfer(acceptTransferTarget.id);
      setAcceptTransferTarget(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Não foi possível aceitar a titularidade.");
    } finally {
      setTransferBusy(false);
    }
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    if (isDuplicateEmail(email)) {
      setActionError("Este e-mail já é membro ou possui convite pendente.");
      return;
    }
    setInviteBusy(true);
    setActionError(null);
    try {
      await inviteMember(email);
      setInviteEmail("");
    } catch (cause) {
      const message =
        cause instanceof ApiError && cause.code === "auth.invite_forbidden"
          ? "Apenas o owner pode convidar quem ainda não possui conta."
          : cause instanceof Error
            ? cause.message
            : "Não foi possível enviar o convite.";
      setActionError(message);
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setFormBusy(true);
    setActionError(null);
    try {
      await createWorkspace({ name, kind: newKind });
      setNewName("");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Não foi possível criar o workspace.");
    } finally {
      setFormBusy(false);
    }
  }

  async function handleRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingWorkspace || !editingName.trim()) return;
    setBusyWorkspaceId(editingWorkspace.id);
    setActionError(null);
    try {
      await renameWorkspace(editingWorkspace.id, editingName.trim());
      setEditingWorkspace(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Não foi possível renomear o workspace.");
    } finally {
      setBusyWorkspaceId(null);
    }
  }

  async function handleArchive() {
    if (!archiveTarget) return;
    setBusyWorkspaceId(archiveTarget.id);
    setActionError(null);
    try {
      await archiveWorkspace(archiveTarget.id);
      setArchiveTarget(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Não foi possível arquivar o workspace.");
    } finally {
      setBusyWorkspaceId(null);
    }
  }

  async function handleRestore(workspace: Workspace) {
    setBusyWorkspaceId(workspace.id);
    setActionError(null);
    try {
      await restoreWorkspace(workspace.id);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Não foi possível restaurar o workspace.");
    } finally {
      setBusyWorkspaceId(null);
    }
  }

  function renderWorkspaceCard(workspace: Workspace) {
    const isActive = workspace.id === activeWorkspace?.id;
    const isArchived = workspace.status === "archived";
    const canManage = workspace.role === "owner";
    const busy = busyWorkspaceId === workspace.id;

    return (
      <article
        key={workspace.id}
        className={`group relative overflow-hidden rounded-[20px] border p-4 transition-all ${
          isArchived
            ? "border-border-subtle bg-surface-2/55 opacity-80"
            : isActive
              ? "border-primary/40 bg-surface-1 shadow-elevated"
              : "border-border-subtle bg-surface-1 shadow-card hover:border-border-medium"
        }`}
        data-status={workspace.status}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex h-11 w-11 flex-none items-center justify-center rounded-[14px] text-sm font-extrabold text-white shadow-sm"
            style={{ background: workspaceColor(workspace) }}
            aria-hidden="true"
          >
            {initials(workspace.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[15px] font-extrabold text-text-primary">{workspace.name}</h3>
              {isActive && (
                <span className="inline-flex flex-none items-center gap-1 rounded-full bg-primary-tint px-2 py-0.5 text-[10px] font-bold text-primary">
                  <Check size={11} strokeWidth={2.8} /> Ativo
                </span>
              )}
            </div>
            <p className="mt-1 text-[12px] font-medium text-text-muted">
              {kindLabels[workspace.kind]} · {workspace.role === "owner" ? "Owner" : "Membro"}
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
          <span className={`text-[11px] font-bold ${isArchived ? "text-text-muted" : "text-primary"}`}>
            {isArchived ? "Arquivado" : workspace.kind === "shared" && isActive ? `${members.length} membro${members.length === 1 ? "" : "s"}` : "Pronto para usar"}
          </span>
          <div className="flex items-center gap-1.5">
            {!isArchived && !isActive && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Usar ${workspace.name}`}
                onClick={() => void selectWorkspace(workspace.id)}
              >
                Usar
              </Button>
            )}
            {canManage && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Renomear ${workspace.name}`}
                  onClick={() => {
                    setEditingWorkspace(workspace);
                    setEditingName(workspace.name);
                    setActionError(null);
                  }}
                  disabled={busy}
                >
                  <Pencil size={15} />
                </Button>
                {isArchived ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Restaurar ${workspace.name}`}
                    onClick={() => void handleRestore(workspace)}
                    loading={busy}
                  >
                    <RotateCcw size={15} />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Arquivar ${workspace.name}`}
                    onClick={() => {
                      setArchiveTarget(workspace);
                      setActionError(null);
                    }}
                    disabled={busy}
                  >
                    <Archive size={15} />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {workspace.kind === "shared" && !isArchived && (
          <div className="mt-4 space-y-3 rounded-[14px] border border-border-subtle bg-surface-2/40 p-3">
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-text-muted">
                <Users size={12} /> Membros {isActive ? `· ${members.length}` : ""}
              </p>
              {isActive && members.length > 0 ? (
                <ul className="space-y-1.5">
                  {members.map((m) => (
                    <li key={m.userId} className="flex items-center justify-between gap-2 rounded-[10px] bg-surface-1 px-2.5 py-1.5 border border-border-subtle">
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-bold text-text-primary">{m.name || m.email}</p>
                        <p className="truncate text-[10px] text-text-muted">{m.email}</p>
                      </div>
                      <div className="flex flex-none items-center gap-1.5">
                        <span className="rounded-full bg-primary-tint px-2 py-0.5 text-[10px] font-bold text-primary">
                          Ativo
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${m.role === "owner" ? "bg-primary-tint text-primary" : "bg-surface-2 text-text-muted"}`}>
                          {m.role === "owner" ? "Owner" : "Membro"}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : isActive && members.length === 0 ? (
                <p className="text-[12px] text-text-muted">Nenhum membro encontrado.</p>
              ) : (
                <p className="text-[11px] text-text-muted">Membros visíveis quando o workspace estiver ativo.</p>
              )}
            </div>
            <form onSubmit={(e) => void handleCardInvite(e, workspace.id)} className="space-y-2">
              <label htmlFor={`card-invite-${workspace.id}`} className="block text-[11px] font-bold uppercase tracking-wider text-text-muted">
                Convidar por e-mail
              </label>
              <div className="flex gap-2">
                <input
                  id={`card-invite-${workspace.id}`}
                  aria-label="E-mail do convidado"
                  type="email"
                  value={cardInviteEmails[workspace.id] ?? ""}
                  onChange={(e) => setCardInviteEmails((prev) => ({ ...prev, [workspace.id]: e.target.value }))}
                  placeholder="email@exemplo.com"
                  className="h-9 flex-1 rounded-[10px] border border-border-subtle bg-surface-1 px-3 text-[12px] font-medium text-text-primary outline-none focus:border-primary"
                />
                <Button
                  type="submit"
                  size="sm"
                  aria-label={`Convidar para ${workspace.name}`}
                  loading={!!cardInviteBusy[workspace.id]}
                  disabled={!(cardInviteEmails[workspace.id] ?? "").trim()}
                  className="flex-none"
                >
                  <Send size={14} /> Convidar
                </Button>
              </div>
            </form>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Ver logs de ${workspace.name}`}
              onClick={() => setLogsWorkspace(workspace)}
              className="w-full"
            >
              <History size={14} /> Logs
            </Button>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg pb-[var(--tab-bar-height)]">
      <StatusBar />
      <PageHeader title="Meus Espaços" subtitle="Organize cada contexto sem misturar seus dados." />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-5 py-4 sm:px-8 lg:px-12">
        <section className="relative overflow-hidden rounded-[24px] bg-gradient-to-br from-[#0d6b47] via-[#0e8c5a] to-[#1c9b72] p-5 text-white shadow-elevated sm:p-7" aria-labelledby="workspace-overview-heading">
          <div className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full border-[24px] border-white/10" />
          <div className="pointer-events-none absolute -bottom-20 right-24 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
          <div className="relative flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-white/65">Centro de ambientes</p>
              <h1 id="workspace-overview-heading" className="max-w-lg text-[25px] font-extrabold leading-tight tracking-tight">
                Um lugar certo para cada decisão financeira.
              </h1>
              <p className="mt-2 max-w-md text-[13px] font-medium leading-relaxed text-white/75">
                O ambiente ativo controla o contexto dos seus dados. Workspaces arquivados continuam disponíveis para restauração.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:min-w-[190px]">
              <div className="rounded-[16px] border border-white/15 bg-black/10 px-3 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-white/60">Ativos</p>
                <p className="mt-1 text-[24px] font-extrabold">{active.length}</p>
              </div>
              <div className="rounded-[16px] border border-white/15 bg-black/10 px-3 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-white/60">Arquivados</p>
                <p className="mt-1 text-[24px] font-extrabold">{archived.length}</p>
              </div>
            </div>
          </div>
        </section>

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-[16px] border border-warning/30 bg-warning-tint px-4 py-3 text-[13px] font-semibold text-warning" role="alert">
            <span>{error}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void refreshWorkspaces().catch(() => {})}>Tentar novamente</Button>
          </div>
        )}
        {actionError && (
          <div className="flex items-center justify-between gap-3 rounded-[16px] border border-danger/20 bg-danger-tint px-4 py-3 text-[13px] font-semibold text-danger" role="alert">
            <span>{actionError}</span>
            <button type="button" aria-label="Fechar erro" onClick={() => setActionError(null)}><X size={16} /></button>
          </div>
        )}

        {pendingTransferForMember && (
          <Card className="border-primary/40 bg-primary-tint/30">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-[15px] font-extrabold text-text-primary">Proposta de Titularidade</h2>
                <p className="mt-1 text-[12px] text-text-muted">
                  O proprietário atual propôs transferir a titularidade deste workspace para você.
                </p>
              </div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setAcceptTransferTarget(pendingTransferForMember)}
              >
                Aceitar Titularidade
              </Button>
            </div>
          </Card>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <section aria-labelledby="workspace-list-heading">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-text-muted">Seus ambientes</p>
                <h2 id="workspace-list-heading" className="mt-1 text-[19px] font-extrabold tracking-tight text-text-primary">Workspaces disponíveis</h2>
              </div>
              <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-bold text-text-muted">{workspaces.length} total</span>
            </div>
            {loading ? (
              <div className="grid gap-3 sm:grid-cols-2" aria-label="Carregando workspaces">
                {[1, 2].map((item) => <div key={item} className="h-[142px] animate-pulse rounded-[20px] border border-border-subtle bg-surface-1" />)}
              </div>
            ) : workspaces.length === 0 ? (
              <Card className="min-h-[220px]">
                <EmptyState
                  icon={<FolderKanban size={24} />}
                  title="Nenhum workspace ainda"
                  description="Crie um ambiente para separar sua vida pessoal, família ou negócio."
                />
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">{workspaces.map(renderWorkspaceCard)}</div>
            )}
          </section>

          <aside className="space-y-4 lg:sticky lg:top-5" aria-label="Ações de workspace">
            <Card elevation={2}>
              <div className="mb-4 flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-[13px] bg-primary-tint text-primary"><Plus size={19} /></span>
                <div>
                  <h2 className="text-[16px] font-extrabold text-text-primary">Criar workspace</h2>
                  <p className="mt-1 text-[12px] leading-relaxed text-text-muted">Comece um contexto novo sem copiar seus lançamentos.</p>
                </div>
              </div>
              <form className="space-y-3" onSubmit={(event) => void handleCreate(event)}>
                <div>
                  <label htmlFor="workspace-name" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Nome</label>
                  <input id="workspace-name" aria-label="Nome do workspace" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Ex.: Casa, Empresa..." maxLength={120} className="h-11 w-full rounded-[12px] border border-border-subtle bg-surface-2 px-3 text-[13px] font-medium text-text-primary outline-none transition-colors focus:border-primary" />
                </div>
                <div>
                  <label htmlFor="workspace-kind" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Tipo</label>
                  <select id="workspace-kind" value={newKind} onChange={(event) => setNewKind(event.target.value as WorkspaceKind)} className="h-11 w-full rounded-[12px] border border-border-subtle bg-surface-2 px-3 text-[13px] font-medium text-text-primary outline-none focus:border-primary">
                    <option value="shared">Compartilhado</option>
                    <option value="personal">Pessoal</option>
                  </select>
                </div>
                <Button type="submit" className="w-full" loading={formBusy} disabled={!newName.trim()}>Criar workspace</Button>
              </form>
            </Card>

            <Card className="border-primary/15 bg-primary-tint/30">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-surface-1 text-primary"><Users size={17} /></span>
                <div>
                  <h2 className="text-[13px] font-extrabold text-text-primary">Workspace ativo</h2>
                  <p className="mt-1 truncate text-[14px] font-bold text-primary">{activeWorkspace?.name ?? "Nenhum selecionado"}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                    {activeWorkspace?.kind === "shared" ? `${activeMembers} membro${activeMembers === 1 ? "" : "s"} com acesso a este ambiente.` : "Ambiente privado, somente para você."}
                  </p>
                </div>
              </div>
            </Card>

{activeWorkspace?.kind === "shared" && (
              <>
                <Card elevation={2}>
                  <div className="mb-3">
                    <h2 className="text-[15px] font-extrabold text-text-primary">Convidar membro</h2>
                    <p className="text-[11px] text-text-muted">Envie um convite por e-mail para adicionar alguém ao workspace.</p>
                  </div>
                  <form onSubmit={(event) => void handleInvite(event)} className="space-y-3">
                    <div>
                      <label htmlFor="invite-email" className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-text-muted">
                        E-mail do convidado
                      </label>
                      <input
                        id="invite-email"
                        aria-label="E-mail do convidado"
                        type="email"
                        value={inviteEmail}
                        onChange={(event) => setInviteEmail(event.target.value)}
                        placeholder="email@exemplo.com"
                        required
                        className="h-10 w-full rounded-[12px] border border-border-subtle bg-surface-2 px-3 text-[13px] font-medium text-text-primary outline-none focus:border-primary"
                      />
                    </div>
                    <Button type="submit" className="w-full" loading={inviteBusy} disabled={!inviteEmail.trim()}>
                      Convidar membro
                    </Button>
                  </form>
</Card>
              </>
            )}
            {activeWorkspace?.role === "owner" && (
              <>
                <Card elevation={2}>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <h2 className="text-[15px] font-extrabold text-text-primary">Convites pendentes</h2>
                      <p className="text-[11px] text-text-muted">Convites aguardando resposta.</p>
                    </div>
                    <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-bold text-text-muted">
                      {pendingInvites.length}
                    </span>
                  </div>
                  {pendingInvites.length === 0 ? (
                    <p className="text-[12px] text-text-muted py-2">Nenhum convite pendente.</p>
                  ) : (
                    <div className="divide-y divide-border-subtle">
                      {pendingInvites.map((invite) => (
                        <div key={invite.id} className="flex items-center justify-between py-2.5 gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-[12px] font-bold text-text-primary">{invite.email}</p>
                            <p className="text-[10px] text-text-muted">
                              Membro · Expira em {new Date(invite.expiresAt).toLocaleDateString("pt-BR")}
                            </p>
                          </div>
                          <div className="flex flex-none items-center gap-1.5">
                            <span className="rounded-full bg-warning-tint px-2 py-0.5 text-[10px] font-bold text-warning">
                              Pendente
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={`Reenviar convite para ${invite.email}`}
                              loading={resendingInviteId === invite.id}
                              onClick={() => void handleResendInvite(invite.id)}
                            >
                              Reenviar
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Revogar convite para ${invite.email}`}
                              onClick={() => setRevokeTarget(invite)}
                            >
                              Revogar
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card elevation={2}>
                  <div className="mb-3">
                    <h2 className="text-[15px] font-extrabold text-text-primary">Transferir titularidade</h2>
                    <p className="text-[11px] text-text-muted">Passe o controle total deste workspace para outro membro ativo.</p>
                  </div>
                  {activePendingTransfer ? (
                    <div className="rounded-[12px] bg-warning-tint p-3 text-[11px] font-medium text-warning border border-warning/30">
                      Transferência pendente aguardando aceitação pelo destinatário.
                    </div>
                  ) : otherMembers.length === 0 ? (
                    <p className="text-[11px] text-text-muted py-1">Adicione outros membros ao workspace para habilitar a transferência.</p>
                  ) : (
                    <div className="space-y-3">
                      <div>
                        <label htmlFor="new-owner-select" className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-text-muted">
                          Novo titular
                        </label>
                        <select
                          id="new-owner-select"
                          aria-label="Novo titular"
                          value={transferTargetUserId}
                          onChange={(e) => setTransferTargetUserId(e.target.value)}
                          className="h-10 w-full rounded-[12px] border border-border-subtle bg-surface-2 px-3 text-[12px] font-medium text-text-primary outline-none focus:border-primary"
                        >
                          <option value="">Selecione um membro...</option>
                          {otherMembers.map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {member.name ? `${member.name} (${member.email})` : member.email}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={!transferTargetUserId}
                        onClick={() => setTransferConfirmOpen(true)}
                      >
                        Transferir titularidade
                      </Button>
                    </div>
                  )}
                </Card>
              </>
            )}
          </aside>
        </div>
      </main>

      <Dialog open={editingWorkspace !== null} onClose={() => setEditingWorkspace(null)} title="Renomear workspace" description="O novo nome será exibido para todos os membros.">
        <form className="space-y-4" onSubmit={(event) => void handleRename(event)}>
          <label htmlFor="rename-workspace" className="block text-[11px] font-bold uppercase tracking-wider text-text-muted">Nome do workspace</label>
          <input id="rename-workspace" value={editingName} onChange={(event) => setEditingName(event.target.value)} maxLength={120} autoFocus className="h-11 w-full rounded-[12px] border border-border-subtle bg-surface-2 px-3 text-[13px] font-medium text-text-primary outline-none focus:border-primary" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditingWorkspace(null)}>Cancelar</Button>
            <Button type="submit" loading={busyWorkspaceId === editingWorkspace?.id} disabled={!editingName.trim()}>Salvar nome</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={archiveTarget !== null} onClose={() => setArchiveTarget(null)} title="Arquivar workspace?" description="Os dados financeiros permanecem preservados. O ambiente deixará de ser selecionável até ser restaurado.">
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setArchiveTarget(null)}>Cancelar</Button>
          <Button type="button" variant="danger" loading={busyWorkspaceId === archiveTarget?.id} onClick={() => void handleArchive()}>Arquivar workspace</Button>
        </div>
      </Dialog>

      <Dialog open={revokeTarget !== null} onClose={() => setRevokeTarget(null)} title="Revogar convite?" description="O destinatário não conseguirá mais entrar neste workspace com este convite.">
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setRevokeTarget(null)}>Cancelar</Button>
          <Button type="button" variant="danger" loading={revokeBusy} onClick={() => void handleRevokeInvite()}>Revogar convite</Button>
        </div>
      </Dialog>

      <Dialog open={transferConfirmOpen} onClose={() => setTransferConfirmOpen(false)} title="Transferir titularidade do workspace?" description="Ao transferir a titularidade, o membro selecionado se tornará o novo Owner deste workspace, e seu acesso será convertido para Membro comum após a aceitação.">
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setTransferConfirmOpen(false)}>Cancelar</Button>
          <Button type="button" variant="primary" loading={transferBusy} onClick={() => void handleTransferOwnership()}>Confirmar transferência</Button>
        </div>
      </Dialog>

      <Dialog open={logsWorkspace !== null} onClose={handleCloseLogs} title={`Histórico · ${logsWorkspace?.name ?? ""}`} description="Histórico de alterações auditadas deste workspace.">
        <div className="max-h-[50vh] overflow-y-auto">
          {logsLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-text-muted">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-border-subtle border-t-primary mr-2" />
              Carregando logs...
            </div>
          ) : logsError ? (
            <div className="rounded-[12px] border border-danger/20 bg-danger-tint p-3 text-[13px] text-danger">{logsError}</div>
          ) : auditLogs.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-text-muted">Nenhum histórico encontrado.</p>
          ) : (
            <div className="space-y-2">
              {auditLogs.map((log) => (
                <div key={log.id} className="rounded-[12px] border border-border-subtle bg-surface-1 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-bold text-text-secondary">{log.operation}</span>
                    <span className="text-[11px] text-text-muted">{new Date(log.createdAt).toLocaleString("pt-BR")}</span>
                  </div>
                  <p className="mt-1.5 text-[12px] font-medium text-text-primary">{log.eventType}</p>
                  <p className="text-[11px] text-text-muted">Actor: {log.actorType} · {log.actorId.slice(0, 8)}…</p>
                  {log.effectRef && <p className="text-[11px] text-text-muted">Ref: {log.effectRef.slice(0, 8)}…</p>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="ghost" onClick={handleCloseLogs}>Fechar</Button>
        </div>
      </Dialog>

      <Dialog open={acceptTransferTarget !== null} onClose={() => setAcceptTransferTarget(null)} title="Aceitar titularidade do workspace?" description="Você se tornará o novo Owner deste workspace com controle administrativo total.">
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setAcceptTransferTarget(null)}>Cancelar</Button>
          <Button type="button" variant="primary" loading={transferBusy} onClick={() => void handleAcceptTransfer()}>Confirmar aceitação</Button>
        </div>
      </Dialog>
    </div>
  );
}
