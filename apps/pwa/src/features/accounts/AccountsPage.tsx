"use client";

import Link from "next/link";
import { useMemo, useState, useEffect } from "react";
import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import BottomSheet from "@/components/BottomSheet";
import { WriteErrorBanner } from "@/components/WriteErrorBanner";
import { StaleBanner } from "@/components/StaleBanner";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { useAppState } from "@/lib/state/app-state-context";
import type { Account } from "@/lib/state/types";
import { Plus, ChevronRight, FileText, Wallet } from "lucide-react";
import { InstitutionPicker } from "@/components/brand/InstitutionPicker";
import { InstitutionMark } from "@/components/brand/InstitutionMark";
import { getInstitution, normalize, resolveInstitution, type Institution } from "@/lib/institutions/catalog";
import { useAccountAppearance, writeAccountAppearance } from "@/lib/institutions/appearance-store";
import { useWorkspaceSafe } from "@/lib/auth/workspace-context";
import { resolveAccountPresentation } from "@/lib/institutions/appearance-store";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

export function formatInputBRL(value: string): string {
  // ADR-018: bank/cash accounts may open with a negative initial balance, so
  // a leading "-" survives masking (valid signed pt-BR formatting). A lone
  // "-" is kept so the user can keep typing; zero never carries a sign.
  const negative = value.trimStart().startsWith("-");
  const digits = value.replace(/\D/g, "");
  if (!digits) return negative ? "-" : "";
  const padded = digits.padStart(3, "0");
  const intPart = padded.slice(0, -2);
  const decPart = padded.slice(-2);
  const magnitude = `${parseInt(intPart, 10).toLocaleString("pt-BR")},${decPart}`;
  if (negative && !/^0+$/.test(digits)) return `-${magnitude}`;
  return magnitude;
}

const ACCOUNT_KINDS = [
  { value: "checking", label: "Conta corrente" },
  { value: "savings", label: "Poupança" },
  { value: "investment", label: "Investimento" },
  { value: "cash", label: "Dinheiro" },
];

/**
 * Maps the UI subkinds to the kinds the authoritative API accepts on account
 * creation ("bank" | "cash" | "credit_card"). checking/savings/investment are
 * all bank-kind accounts at the API level — the subkind choice is honored in
 * the payload via bankColor and kept here explicit instead of a degenerate
 * ternary.
 */
export function toApiAccountKind(kind: string): "bank" | "cash" | "credit_card" {
  switch (kind) {
    case "cash": return "cash";
    case "credit_card": return "credit_card";
    default: return "bank";
  }
}

/**
 * ADR-018: bank/cash accounts may open with a negative initial balance
 * (real overdraft); a credit_card balance is open debt and must never be
 * negative. The create form enforces this before submitting so the PWA never
 * sends a payload the authoritative API would reject.
 */
export function isNegativeInitialBalanceAllowed(kind: "bank" | "cash" | "credit_card"): boolean {
  return kind !== "credit_card";
}

export function parseBRLToCents(value: string): number {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return 0;
  const cleaned = trimmed.replace(/[.\s]/g, "").replace(",", ".");
  const cents = Math.round(parseFloat(cleaned) * 100);
  if (!Number.isFinite(cents)) return 0;
  return cents === 0 ? 0 : cents;
}

function AccountFormSheet({
  open,
  onClose,
  onAdd,
  onAppearance,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (input: {
    name: string;
    kind: "bank" | "cash" | "credit_card";
    initialBalanceCents: number;
    bankColor: string;
    institutionId: string | null;
  }) => Promise<{ id: string } | undefined>;
  onAppearance: (id: string, selection: { institutionId?: string; manualInstitutionName?: string }) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("checking");
  const [bankColor, setBankColor] = useState("#820AD1");
  const [balance, setBalance] = useState("");
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [institutionId, setInstitutionId] = useState<string>();
  const [manualInstitutionName, setManualInstitutionName] = useState("");

  async function handleSave() {
    const selectedInstitution = institutionId ? getInstitution(institutionId) : undefined;
    const displayName =
      name.trim() ||
      selectedInstitution?.name ||
      manualInstitutionName.trim() ||
      (kind === "cash" ? "Carteira" : "Conta");
    const apiKind = toApiAccountKind(kind);
    const initialBalanceCents = parseBRLToCents(balance);
    // ADR-018: bank/cash may open negative; credit_card must never be
    // negative — reject locally instead of sending a payload the API refuses.
    if (!isNegativeInitialBalanceAllowed(apiKind) && initialBalanceCents < 0) {
      setBalanceError("Cartão não aceita saldo inicial negativo.");
      return;
    }
    try {
      const created = await onAdd({
        name: displayName,
        kind: apiKind,
        initialBalanceCents,
        bankColor,
        institutionId: institutionId ?? null,
      });
      if (created?.id) onAppearance(created.id, institutionId ? { institutionId } : { manualInstitutionName });
      setName("");
      setBalance("");
      setBalanceError(null);
      onClose();
    } catch {
      // Save failed: sheet stays open with the typed values; the error is
      // surfaced by the page-level WriteErrorBanner (PayablesPage pattern).
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Nova conta">
      <div className="flex flex-col gap-4">
        <div>
          <InstitutionPicker onSelect={(institution) => { setInstitutionId(institution.id); setManualInstitutionName(""); setBankColor(institution.colors.primary); }} onManual={(value) => { setInstitutionId(undefined); setManualInstitutionName(value); setBankColor("#4A5568"); }} />
        </div>

        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Nome
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex: Nubank, Itaú..."
            className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none transition-colors focus:border-primary"
          />
        </fieldset>

        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Tipo
          </label>
          <div className="flex gap-1 rounded-[14px] bg-surface-2 p-1 border border-border-subtle">
            {ACCOUNT_KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => setKind(k.value)}
                className={`flex-1 rounded-[10px] py-2 text-center text-[12px] font-bold transition-all ${
                  kind === k.value
                    ? "bg-surface-1 text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Saldo inicial
          </label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[16px] font-bold text-text-muted">
              R$
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={balance}
              onChange={(e) => {
                const raw = e.target.value;
                // ADR-018: keep a leading "-" so a negative initial balance
                // survives masking; only the digit count is limited.
                if (raw.replace(/\D/g, "").length > 12) return;
                setBalance(formatInputBRL(raw));
                if (balanceError) setBalanceError(null);
              }}
              placeholder="0,00"
              aria-invalid={balanceError !== null}
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 py-3 pl-11 pr-3.5 font-mono tabular-nums text-[16px] font-bold text-text-primary outline-none transition-colors focus:border-primary"
            />
            {balanceError && (
              <p role="alert" className="mt-1.5 text-[12px] font-semibold text-danger">
                {balanceError}
              </p>
            )}
          </div>
        </fieldset>

        <button
          type="button"
          onClick={handleSave}
          className="mt-2 w-full rounded-[14px] bg-primary py-3.5 text-center text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98]"
        >
          Salvar conta
        </button>
      </div>
    </BottomSheet>
  );
}

function AccountEditSheet({ open, account, appearance, onClose, onSave }: {
  open: boolean;
  account: { id: string; name: string; color?: string } | null;
  appearance?: { institutionId?: string; manualInstitutionName?: string };
  onClose: () => void;
  onSave: (id: string, name: string, selection: { institutionId?: string; manualInstitutionName?: string }) => void | Promise<void>;
}) {
  const [name, setName] = useState(account?.name ?? "");
  const initialInstitution = account
    ? getInstitution(appearance?.institutionId ?? "") ?? resolveInstitution({ name: account.name, color: account.color })
    : undefined;
  const [institution, setInstitution] = useState<Institution | undefined>(initialInstitution);
  const [institutionId, setInstitutionId] = useState<string | undefined>(initialInstitution?.id);
  const [manualName, setManualName] = useState(appearance?.manualInstitutionName ?? "");

  async function handleSave() {
    if (!account || !name.trim()) return;
    try {
      await onSave(account.id, name.trim(), institutionId ? { institutionId } : { manualInstitutionName: manualName });
      onClose();
    } catch {
      // Save failed: sheet stays open with the typed value.
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Editar conta">
      <div className="flex flex-col gap-4">
        <InstitutionPicker value={institution} onSelect={(selected) => { setInstitution(selected); setInstitutionId(selected.id); setManualName(""); }} onManual={(value) => { setInstitution(undefined); setInstitutionId(undefined); setManualName(value); }} />
        <fieldset>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Nome
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none focus:border-primary"
          />
        </fieldset>
        <button
          type="button"
          onClick={handleSave}
          className="w-full rounded-[14px] bg-primary py-3.5 text-center text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98]"
        >
          Salvar
        </button>
      </div>
    </BottomSheet>
  );
}

function AccountDetailSheet({
  account,
  appearance,
  miniHistory,
  open,
  onClose,
  onEdit,
  onDeactivate,
}: {
  account: { id: string; name: string; balanceCents: number; kind: string; color?: string } | null;
  appearance?: { institutionId?: string; manualInstitutionName?: string };
  miniHistory: { id: string; description: string; amountCents: number; date: string; kind: string }[];
  open: boolean;
  onClose: () => void;
  onEdit: (id: string, name: string) => void;
  onDeactivate: (id: string, name: string) => void;
}) {
  if (!account) return null;

  function kindLabel(kind: string): string {
    switch (kind) {
      case "credit_card": return "Cartão";
      case "checking": return "Conta corrente";
      case "savings": return "Poupança";
      case "investment": return "Investimento";
      case "cash": return "Dinheiro";
      case "bank": return "Conta";
      default: return "Outro";
    }
  }

  const { institution } = resolveAccountPresentation(account as Account, appearance);
  const accentColor = institution?.colors.primary;
  return (
    <BottomSheet open={open} onClose={onClose} title="Detalhes da conta">
      <div className="flex flex-col gap-4">
        {/* Header with bank identity */}
        <div
          className="flex items-center gap-3 rounded-[16px] border border-border-subtle bg-surface-2 p-3.5"
          style={
            accentColor
              ? {
                  background: `linear-gradient(135deg, ${accentColor}14, var(--surface-2))`,
                  borderColor: `${accentColor}30`,
                }
              : undefined
          }
        >
          {account.kind === "cash" && !institution ? (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-1 text-text-secondary shadow-xs" aria-hidden="true">
              <Wallet size={20} strokeWidth={2} />
            </span>
          ) : (
            <InstitutionMark institution={institution} size="md" />
          )}
          <div className="flex-1 min-w-0">
            <div className="truncate text-[14px] font-bold text-text-primary">{account.name}</div>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
              <span>{kindLabel(account.kind)}</span>
              {institution && (
                <>
                  <span className="h-1 w-1 rounded-full bg-border-subtle" />
                  <span className="font-semibold text-text-secondary">{institution.name}</span>
                </>
              )}
            </div>
          </div>
          <div className="font-mono tabular-nums text-[15px] font-bold text-text-primary">
            {formatBRL(account.balanceCents)}
          </div>
        </div>

        {/* Mini history */}
        {miniHistory.length > 0 && (
          <div className="border-t border-border-subtle pt-3">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-text-muted">
              Últimos lançamentos
            </div>
            <div className="space-y-1 rounded-[14px] border border-border-subtle bg-surface-2 p-2">
              {miniHistory.map((tx) => {
                const amountColor =
                  tx.kind === "expense"
                    ? "var(--color-danger)"
                    : tx.kind === "income"
                      ? "var(--color-primary)"
                      : "var(--color-info)";
                const prefix =
                  tx.kind === "expense"
                    ? "−"
                    : tx.kind === "income"
                      ? "+"
                      : "";
                return (
                  <div key={tx.id} className="flex items-center justify-between py-1 px-2 border-b border-border-subtle/50 last:border-none">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-text-primary">{tx.description}</span>
                      <span className="text-[10px] text-text-muted">
                        {new Date(tx.date + "T12:00:00").toLocaleDateString("pt-BR")}
                      </span>
                    </div>
                    <span className="font-mono tabular-nums text-[12px] font-bold" style={{ color: amountColor }}>
                      {prefix}
                      {formatBRL(tx.amountCents)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* CTA to records */}
        <Link
          href={`/registros?accountId=${account.id}`}
          className="flex items-center justify-center gap-2 rounded-[14px] border border-border-subtle bg-surface-2 py-3.5 text-center text-[14px] font-bold text-text-primary hover:bg-surface-3 transition-colors"
        >
          <FileText size={16} />
          Ver todos os registros
        </Link>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onEdit(account.id, account.name)}
            className="flex-1 rounded-[14px] border border-border-subtle bg-surface-2 py-3 text-center text-[13px] font-bold text-text-primary hover:bg-surface-3 transition-colors"
          >
            Editar conta
          </button>
          <button
            type="button"
            onClick={() => onDeactivate(account.id, account.name)}
            className="flex-1 rounded-[14px] bg-danger-tint border border-danger/20 py-3 text-center text-[13px] font-bold text-danger hover:bg-danger-tint/80 transition-colors"
          >
            Desativar conta
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

export default function AccountsPage({ embedded = false }: { embedded?: boolean }) {
  const { accounts, transactions, loading, error, writeError, clearWriteError, retryWriteError, addAccount, updateAccount, deactivateAccount } = useAppState();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailAccount, setDetailAccount] = useState<(typeof accounts)[0] | null>(null);
  const [editAccount, setEditAccount] = useState<{ id: string; name: string; color?: string } | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<{ id: string; name: string } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const workspaceId = useWorkspaceSafe()?.activeWorkspace?.id ?? "default";
  const appearance = useAccountAppearance(workspaceId);
  useEffect(() => {
    for (const account of accounts) {
      const patch = {
        ...(account.institutionId ? { institutionId: account.institutionId } : {}),
        ...(account.cardProductId ? { cardProductId: account.cardProductId } : {}),
      };
      if (Object.keys(patch).length) writeAccountAppearance(workspaceId, account.id, patch);
    }
  }, [accounts, workspaceId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("accountId");
    if (id) {
      const account = accounts.find((a) => a.id === id);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (account) setDetailAccount(account);
    }
  }, [accounts]);

  const checkingAccounts = useMemo(
    () => accounts.filter((a) => a.kind !== "credit_card"),
    [accounts],
  );
  const appearanceFor = (accountId: string, accountName: string) =>
    appearance.map[accountId] ?? Object.entries(appearance.map).find(([key]) => normalize(key) === normalize(accountName))?.[1];

  if (loading) {
    return (
      <div className={embedded ? "flex flex-1 flex-col bg-bg" : "flex min-h-dvh flex-col bg-bg"}>
        {!embedded && <StatusBar />}
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-border-subtle border-t-primary" />
            <span className="text-[13px] font-semibold text-text-muted">Carregando...</span>
          </div>
        </div>
      </div>
    );
  }

  const totalBalance = checkingAccounts.reduce(
    (s, a) => s + a.balanceCents,
    0,
  );

  function getMiniHistory(accountId: string) {
    return transactions
      .filter((t) => t.accountId === accountId)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);
  }

  return (
    <div className={embedded ? "flex flex-1 flex-col bg-bg" : "flex min-h-dvh flex-col bg-bg"}>
      {!embedded && <StatusBar />}
      <main className={embedded ? "flex flex-1 flex-col pt-4" : "flex flex-1 flex-col pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8"}>
        {!embedded && (
          <PageHeader
            title="Contas"
            action={
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[12px] font-bold text-white shadow-sm hover:bg-primary-hover active:scale-95 transition-all"
              >
                <Plus size={15} strokeWidth={2.4} />
                Nova
              </button>
            }
          />
        )}

        {error && (
          <div className="mx-5 mb-3 rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger">
            ⚠ {error}
          </div>
        )}

        <WriteErrorBanner message={writeError} onDismiss={clearWriteError} onRetry={retryWriteError ?? undefined} />

        <StaleBanner domains={["accounts", "transactions"]} />

        <div className="px-5 sm:px-8 lg:px-12">
          {/* Total balance card */}
          <div
            className="mb-4 flex items-center justify-between gap-3 overflow-hidden rounded-[20px] px-5 py-5 text-white shadow-card"
            style={{
              background: "linear-gradient(165deg, #0F6B45, #0A3A28)",
            }}
          >
            <div>
              <div className="mb-1 text-[12px] font-medium text-white/70">
                Saldo somado
              </div>
              <div className="mb-1 font-mono tabular-nums text-[28px] font-bold tracking-tight text-white">
                {formatBRL(totalBalance)}
              </div>
              <div className="text-[11px] font-medium text-white/70">
                {checkingAccounts.length}{" "}
                {checkingAccounts.length === 1 ? "conta" : "contas"}
              </div>
            </div>
            {embedded && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="flex flex-none items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[12px] font-bold text-[#0A3A28] shadow-sm transition-all hover:bg-white/90 active:scale-95"
              >
                <Plus size={15} strokeWidth={2.4} />
                Nova
              </button>
            )}
          </div>

          {/* Account cards with bank identity */}
          <div className="flex flex-col gap-3">
            {checkingAccounts.map((acc) => {
              const institution = resolveAccountPresentation(acc, appearanceFor(acc.id, acc.name)).institution;
              const accentColor = institution?.colors.primary;
              return (
                <button
                  type="button"
                  key={acc.id}
                  data-testid="account-card"
                  data-account-id={acc.id}
                  data-bank={institution?.id ?? "custom"}
                  data-highlighted={detailAccount?.id === acc.id ? "true" : "false"}
                  onClick={() => setDetailAccount(acc)}
                  className={`relative w-full overflow-hidden rounded-[18px] border bg-surface-1 px-4 py-3.5 pr-11 shadow-card transition-all text-left hover:bg-surface-2/60 ${
                    detailAccount?.id === acc.id
                      ? "border-primary ring-2 ring-primary/30"
                      : "border-border-subtle"
                  }`}
                  style={
                    accentColor
                      ? {
                          borderColor: detailAccount?.id === acc.id ? undefined : `${accentColor}26`,
                          background: `linear-gradient(90deg, ${accentColor}0F 0%, transparent 45%), var(--surface-1)`,
                        }
                      : undefined
                  }
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 top-0 h-full w-[4px]"
                    style={{ background: accentColor ?? "var(--color-border-medium)" }}
                  />
                  <div className="flex items-center gap-3">
                    {acc.kind === "cash" && !institution ? (
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-text-secondary" aria-hidden="true">
                        <Wallet size={20} strokeWidth={2} />
                      </span>
                    ) : (
                      <InstitutionMark institution={institution} size="md" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-[14px] font-bold text-text-primary">
                        {acc.name}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
                        <span>
                          {acc.kind === "credit_card"
                            ? "Cartão"
                            : acc.kind === "checking"
                              ? "Conta corrente"
                              : acc.kind === "savings"
                                ? "Poupança"
                                : acc.kind === "investment"
                                  ? "Investimento"
                                  : acc.kind === "cash"
                                    ? "Dinheiro"
                                    : acc.kind === "bank"
                                      ? "Conta"
                                      : "Outro"}
                        </span>
                        {institution && (
                          <>
                            <span className="h-1 w-1 rounded-full bg-border-subtle" />
                            <span className="truncate font-semibold text-text-secondary">
                              {institution.name}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="font-mono tabular-nums text-[14px] font-bold text-text-primary">
                      {formatBRL(acc.balanceCents)}
                    </div>
                  </div>
                  {/* chevron */}
                  <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-text-muted">
                    <ChevronRight size={16} />
                  </div>
                </button>
              );
            })}
            {checkingAccounts.length === 0 && (
              <div className="rounded-[18px] border border-dashed border-border-subtle bg-surface-1 px-4 py-8 text-center text-[13px] text-text-muted">
                Nenhuma conta cadastrada. Toque em Nova.
              </div>
            )}
          </div>
        </div>
      </main>

      <AccountFormSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onAdd={async ({ name, kind, initialBalanceCents, bankColor, institutionId }) => addAccount({ name, kind, initialBalanceCents, institutionId } as Parameters<typeof addAccount>[0] & { bankColor: string })}
        onAppearance={(id, selection) => appearance.set(id, selection)}
      />

      <AccountEditSheet
        key={`${editAccount?.id ?? ""}:${editAccount ? appearanceFor(editAccount.id, editAccount.name)?.institutionId ?? "" : ""}`}
        open={editOpen}
        account={editAccount}
        appearance={editAccount ? appearanceFor(editAccount.id, editAccount.name) : undefined}
        onClose={() => {
          setEditOpen(false);
          setEditAccount(null);
        }}
        onSave={async (id, name, selection) => {
          await updateAccount(id, { name, institutionId: selection.institutionId ?? null });
          appearance.set(id, selection);
        }}
      />

      <AccountDetailSheet
        account={detailAccount}
        appearance={detailAccount ? appearanceFor(detailAccount.id, detailAccount.name) : undefined}
        miniHistory={detailAccount ? getMiniHistory(detailAccount.id) : []}
        open={detailAccount !== null}
        onClose={() => setDetailAccount(null)}
        onEdit={() => {
          setDetailAccount(null);
          setEditAccount(detailAccount);
          setEditOpen(true);
        }}
        onDeactivate={(id, name) => {
          setDetailAccount(null);
          setConfirmDeactivate({ id, name });
        }}
      />

      <ConfirmActionDialog
        open={confirmDeactivate !== null}
        title="Desativar conta"
        message={`Tem certeza que deseja desativar a conta "${confirmDeactivate?.name ?? ""}"? Esta ação pode ser desfeita.`}
        confirmLabel="Desativar"
        danger
        onConfirm={() => {
          if (confirmDeactivate) deactivateAccount(confirmDeactivate.id);
          setConfirmDeactivate(null);
        }}
        onCancel={() => setConfirmDeactivate(null)}
      />
    </div>
  );
}
