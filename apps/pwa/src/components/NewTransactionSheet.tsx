"use client";

import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Calendar,
  Check,
  ChevronDown,
  CreditCard,
  Plus,
  Search,
  Wallet,
} from "lucide-react";
import { CategoryBadge } from "@/components/ui/CategoryBadge";
import BottomSheet from "./BottomSheet";
import { useFormDirtySafe } from "@/lib/unsaved-changes";
import type { Account, Category } from "@/lib/state/types";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { checkDuplicate, formatDuplicateWarning } from "@/lib/api/endpoints";
import { getFailedCommandId, newCommandId } from "@/lib/api/command-id";
import { isApiConfigured } from "@/lib/api/client";
import { splitInstallmentAmounts } from "@/lib/finance/installments";

export type SheetTab = "expense" | "income" | "transfer";

export interface SaveData {
  kind: SheetTab;
  amountCents: number;
  description: string;
  date: string;
  categoryId?: string;
  subcategoryId?: string;
  accountId?: string;
  /** H-01: preserves the card nature to the executor (account = Conta). */
  originKind?: "account" | "card";
  fromAccountId?: string;
  toAccountId?: string;
  installmentsTotal?: number;
  notes?: string;
  /**
   * #185: chave de idempotência da intent, mintada pelo sheet (uma por
   * intent, estável em retries/re-renders). Transporte puro: o executor a
   * repassa à camada commands (que a preserva verbatim); nunca entra no
   * estado React nem distingue intents por igualdade de payload.
   */
  idempotencyKey?: string;
}

type OriginKind = "account" | "card";

interface NewTransactionSheetProps {
  accounts: Account[];
  categories: Category[];
  onSave: (data: SaveData) => void | Promise<void>;
  onAddCategory?: (input: {
    name: string;
    kind: "expense" | "income";
    parentId?: string;
  }) => void;
  onAddAccount?: (input: {
    name: string;
    kind: "bank" | "cash" | "credit_card";
    initialBalanceCents: number;
  }) => void;
  onAddCard?: (input: {
    name: string;
    creditLimitCents: number;
    closingDay: number;
    dueDay: number;
  }) => void;
  initialTab?: SheetTab;
  initialDescription?: string;
  initialCategoryId?: string;
  initialSubcategoryId?: string;
  /** Most-used category ids (top 5) for the "Mais usadas" section. */
  recentCategoryIds?: string[];
}

function formatInputBRL(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "0,00";
  const padded = digits.padStart(3, "0");
  const intPart = padded.slice(0, -2);
  const decPart = padded.slice(-2);
  return `${parseInt(intPart, 10).toLocaleString("pt-BR")},${decPart}`;
}

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function parseBRLToCents(value: string): number {
  const cleaned = value.replace(/[.\s]/g, "").replace(",", ".");
  return Math.round(parseFloat(cleaned) * 100) || 0;
}

/** Invoice month for a card purchase: closing day decides the statement. */
export function invoiceMonthLabel(purchaseISO: string, closingDay: number): string {
  const purchase = new Date(`${purchaseISO}T12:00:00`);
  const rollsOver = purchase.getDate() > closingDay;
  const month = rollsOver ? (purchase.getMonth() + 1) % 12 : purchase.getMonth();
  const year = rollsOver && purchase.getMonth() === 11 ? purchase.getFullYear() + 1 : purchase.getFullYear();
  return new Date(year, month, 1).toLocaleDateString("pt-BR", { month: "long" });
}

// ── Inline creation form (reusable) ───

function InlineForm({
  onSave: handleInlineSave,
  onCancel,
  fields,
  saveLabel,
}: {
  onSave: () => void;
  onCancel: () => void;
  fields: ReactNode;
  saveLabel: string;
}) {
  return (
    <div className="rounded-[13px] border border-primary/30 bg-primary-tint p-3">
      {fields}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex min-h-[44px] flex-1 items-center justify-center rounded-[10px] border border-border bg-surface px-3 py-2 text-[12px] font-bold text-text-secondary"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={handleInlineSave}
          aria-label={saveLabel}
          className="flex min-h-[44px] flex-1 items-center justify-center rounded-[10px] bg-primary px-3 py-2 text-[12px] font-bold text-white"
        >
          Salvar
        </button>
      </div>
    </div>
  );
}

const INSTALLMENT_OPTIONS = [1, 2, 3, 6, 10, 12];

export default function NewTransactionSheet({
  accounts,
  categories,
  onSave,
  onAddCategory,
  onAddAccount,
  onAddCard,
  initialTab = "expense",
  initialDescription = "",
  initialCategoryId = "",
  initialSubcategoryId = "",
  recentCategoryIds = [],
}: NewTransactionSheetProps) {
  const { markDirty, markClean } = useFormDirtySafe();
  const [tab, setTab] = useState<SheetTab>(initialTab);
  const [amountDisplay, setAmountDisplay] = useState("");
  const [description, setDescription] = useState(initialDescription);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [subcategoryId, setSubcategoryId] = useState(() => {
    if (initialSubcategoryId) return initialSubcategoryId;
    return "";
  });
  const [categoryId, setCategoryId] = useState(() => {
    if (initialCategoryId) return initialCategoryId;
    if (initialSubcategoryId) {
      const parent = categories.find((c) => c.id === initialSubcategoryId)?.parentId;
      if (parent) return parent;
    }
    return "";
  });

  // #185: chave de idempotência por INTENT — mintada uma vez por montagem,
  // estável em re-renders e retries; rotacionada só em sucesso definitivo ou
  // draft genuinamente novo (troca de aba). Nunca por igualdade de payload.
  const commandIdRef = useRef<string | null>(null);
  if (commandIdRef.current === null) commandIdRef.current = newCommandId();
  function currentCommandId(): string {
    if (commandIdRef.current === null) commandIdRef.current = newCommandId();
    return commandIdRef.current;
  }
  // #185: lock síncrono (ref, não estado) + espelho em estado para disable
  // imediato do botão. O ref bloqueia o segundo toque antes de qualquer
  // await; o estado desabilita o botão no próximo render.
  const savingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);

  function rotateCommandId() {
    commandIdRef.current = newCommandId();
  }

  // B2: mutually exclusive origin — exactly one of account/card.
  const [originKind, setOriginKind] = useState<OriginKind>("account");
  const [originId, setOriginId] = useState("");
  const [fromAccountId, setFromAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");

  // Inline creation state
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [addingCard, setAddingCard] = useState(false);
  const [newName, setNewName] = useState("");
  const [newInitialBalance, setNewInitialBalance] = useState("");
  const [newCreditLimit, setNewCreditLimit] = useState("");
  const [newClosingDay, setNewClosingDay] = useState("15");
  const [newDueDay, setNewDueDay] = useState("25");

  // B1: picker sheets
  const [categorySheetOpen, setCategorySheetOpen] = useState(false);
  const [originSheetOpen, setOriginSheetOpen] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");

  // B3: installments (card origin only). 1 = à vista.
  const [installmentsCount, setInstallmentsCount] = useState(1);

  // B4: secondary details
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [notes, setNotes] = useState("");

  // Calendar
  const [calOpen, setCalOpen] = useState(false);
  const today = new Date();
  const [calYear, setCalYear] = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());

  const isTransfer = tab === "transfer";
  const isExpense = tab === "expense";
  const filteredAccounts = accounts.filter((a) => a.kind !== "credit_card");
  const creditCards = accounts.filter((a) => a.kind === "credit_card");
  const originOptions = originKind === "card" ? creditCards : filteredAccounts;

  // Categories: top-level only for picker; subcategories shown separately
  const filteredCategories = categories.filter(
    (c) => c.kind === tab && !c.parentId,
  );

  // Subcategories of the selected category
  const subcategories = categoryId
    ? categories.filter((c) => c.parentId === categoryId)
    : [];

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const selectedSubcategory = categories.find((c) => c.id === subcategoryId);
  const categoryPillLabel = selectedSubcategory
    ? `${selectedCategory?.name ?? ""} › ${selectedSubcategory.name}`
    : (selectedCategory?.name ?? "Selecionar");

  const selectedOrigin = accounts.find((a) => a.id === originId);
  const originDetail = selectedOrigin
    ? selectedOrigin.kind === "credit_card"
      ? selectedOrigin.closingDay !== undefined
        ? `Fecha dia ${selectedOrigin.closingDay}`
        : "Cartão de crédito"
      : `Saldo ${formatBRL(selectedOrigin.balanceCents)}`
    : "Selecionar";

  // B1: top-5 most used first, then the rest (both honoring search).
  const searchedCategories = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return filteredCategories;
    return filteredCategories.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      categories.some((s) => s.parentId === c.id && s.name.toLowerCase().includes(q)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categorySearch, categories, tab]);
  const topCategories = useMemo(() => {
    const byId = new Map(searchedCategories.map((c) => [c.id, c]));
    const top = recentCategoryIds
      .map((id) => byId.get(id))
      .filter((c): c is Category => c !== undefined)
      .slice(0, 5);
    const topIds = new Set(top.map((c) => c.id));
    return { top, rest: searchedCategories.filter((c) => !topIds.has(c.id)) };
  }, [searchedCategories, recentCategoryIds]);

  const dateLabel = new Date(date + "T12:00:00").toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Calendar helpers
  const calDaysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const calFirstDow = new Date(calYear, calMonth, 1).getDay();
  const calFirstShifted = calFirstDow === 0 ? 6 : calFirstDow - 1;
  const calCells: { day: number; isToday: boolean; isSelected: boolean }[] = [];
  for (let i = 0; i < calFirstShifted; i++)
    calCells.push({ day: 0, isToday: false, isSelected: false });
  for (let d = 1; d <= calDaysInMonth; d++) {
    const iso = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    calCells.push({
      day: d,
      isToday: iso === today.toISOString().slice(0, 10),
      isSelected: iso === date,
    });
  }
  const calLabel = new Date(calYear, calMonth).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });

  function selectCalDay(d: number) {
    setDate(
      `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    );
    setCalOpen(false);
  }

  function prevCalMonth() {
    if (calMonth === 0) {
      setCalMonth(11);
      setCalYear(calYear - 1);
    } else setCalMonth(calMonth - 1);
  }

  function nextCalMonth() {
    if (calMonth === 11) {
      setCalMonth(0);
      setCalYear(calYear + 1);
    } else setCalMonth(calMonth + 1);
  }

  const amountCents = parseBRLToCents(amountDisplay);
  const parcelado = !isTransfer && originKind === "card" && installmentsCount > 1;
  // L-01: same distribution as the backend (remainder on the last parcel).
  const installmentParts =
    parcelado && amountCents > 0 ? splitInstallmentAmounts(amountCents, installmentsCount) : null;
  const installmentCents = installmentParts ? installmentParts[0]! : amountCents;
  const lastInstallmentCents = installmentParts ? installmentParts[installmentParts.length - 1]! : amountCents;
  const installmentsUneven = installmentParts !== null && installmentCents !== lastInstallmentCents;

  function handleAmountInput(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, "");
    if (raw.length > 12) return;
    setAmountDisplay(formatInputBRL(raw));
  }

  const categoryKind: "expense" | "income" =
    tab === "income" ? "income" : "expense";

  /** "Cadastrar nova": creates a subcategory under the selected parent,
   * otherwise a top-level category. */
  function handleSaveCategory() {
    if (!newName.trim() || !onAddCategory) return;
    onAddCategory(
      categoryId
        ? { name: newName.trim(), kind: categoryKind, parentId: categoryId }
        : { name: newName.trim(), kind: categoryKind },
    );
    setNewName("");
    setAddingCategory(false);
  }

  function handleSaveAccount() {
    if (!newName.trim() || !onAddAccount) return;
    // ADR-018: bank accounts may open with a negative initial balance — a
    // leading "-" survives parsing instead of being stripped as non-digit.
    const trimmedBalance = newInitialBalance.trim();
    const magnitude = parseInt(trimmedBalance.replace(/\D/g, "") || "0", 10);
    const balance = trimmedBalance.startsWith("-") && magnitude !== 0 ? -magnitude : magnitude;
    onAddAccount({
      name: newName.trim(),
      kind: "bank",
      initialBalanceCents: balance,
    });
    setNewName("");
    setNewInitialBalance("");
    setAddingAccount(false);
  }

  function handleSaveCard() {
    if (!newName.trim() || !onAddCard) return;
    const limit = parseInt(newCreditLimit.replace(/\D/g, "") || "0", 10);
    onAddCard({
      name: newName.trim(),
      creditLimitCents: limit,
      closingDay: parseInt(newClosingDay, 10) || 15,
      dueDay: parseInt(newDueDay, 10) || 25,
    });
    setNewName("");
    setNewCreditLimit("");
    setAddingCard(false);
  }

  function switchOriginKind(next: OriginKind) {
    if (next === originKind) return;
    setOriginKind(next);
    // B2: mutual exclusivity — switching origin clears the previous pick…
    setOriginId("");
    // …and installments only exist on card origin.
    setInstallmentsCount(1);
    setOriginSheetOpen(false);
  }

  function resetDraft() {
    // Draft genuinamente novo (troca de aba limpa todos os campos) = nova
    // intent: rotaciona a chave para nunca reusar o id de um commit anterior
    // num payload distinto (#185 anti-falso-positivo).
    rotateCommandId();
    setCategoryId("");
    setSubcategoryId("");
    setOriginKind("account");
    setOriginId("");
    setFromAccountId("");
    setToAccountId("");
    setInstallmentsCount(1);
    setNotes("");
    setDetailsOpen(false);
    setCategorySheetOpen(false);
    setOriginSheetOpen(false);
    setCategorySearch("");
    setAddingCategory(false);
    setAddingAccount(false);
    setAddingCard(false);
    setAmountDisplay("");
    setDescription("");
  }

  // Duplicate-detector state
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [pendingData, setPendingData] = useState<SaveData | null>(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);

  /**
   * #185: executa o save com a chave da intent e faz a contabilidade da
   * chave. Sucesso definitivo → rotaciona (próxima intent, nova chave).
   * Falha → mantém a chave, adotando o id que a camada de escrita reportar
   * no erro (getFailedCommandId), para retry manual como replay, não novo
   * efeito — mas SÓ se a ref ainda apontar para a intent que acabou de
   * assentar. Se o usuário trocou de aba com o save em voo, resetDraft já
   * rotacionou a ref para a nova intent B e o erro tardio de A nunca pode
   * sobrescrevê-la (senão o próximo save de B reusaria a chave de A).
   * O lock (savingRef/isSaving) é gerenciado pelos chamadores.
   */
  async function runSave(data: SaveData): Promise<boolean> {
    try {
      await onSave(data);
      markClean();
      rotateCommandId();
      return true;
    } catch (e) {
      const failedId = getFailedCommandId(e);
      if (failedId && commandIdRef.current === data.idempotencyKey) {
        commandIdRef.current = failedId;
      }
      // Save failed: keep dirty + keep the intent key for retry.
      return false;
    }
  }

  const missingOrigin = !isTransfer && !originId;

  async function handleSave(force = false) {
    if (amountCents <= 0) return;
    let data: SaveData;
    if (isTransfer) {
      if (!fromAccountId || !toAccountId || fromAccountId === toAccountId)
        return;
      data = {
        kind: "transfer",
        amountCents,
        description,
        date,
        fromAccountId,
        toAccountId,
      };
    } else {
      // B2: origin is mandatory and exclusive by construction (single id).
      if (!originId) return;
      // H-01: income on a card is rejected (the API answers 422 as well).
      if (tab === "income" && originKind === "card") return;
      data = {
        kind: tab,
        amountCents,
        description,
        date,
        categoryId: subcategoryId || categoryId,
        subcategoryId: subcategoryId || undefined,
        accountId: originId,
        originKind,
      };
      if (parcelado) {
        data.installmentsTotal = installmentsCount;
      }
      const trimmedNotes = notes.trim();
      if (trimmedNotes) data.notes = trimmedNotes.slice(0, 2000);
    }
    // #185: a intent carrega a chave estável deste draft (retries e
    // confirmação forçada reusam a MESMA chave; ver runSave/rotateCommandId).
    data.idempotencyKey = currentCommandId();

    // #185: lock síncrono antes de qualquer await — o segundo toque na
    // janela de voo (pós-check, save pendente) retorna de imediato.
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      // Duplicate check before save (unless force:true bypass)
      if (!force && isApiConfigured() && description.trim()) {
        try {
          setCheckingDuplicate(true);
          const dupInput = isTransfer
            ? {
                kind: "transfer" as const,
                description: data.description,
                amountCents: data.amountCents,
                date: data.date,
                fromAccountId: data.fromAccountId,
                toAccountId: data.toAccountId,
              }
            : {
                kind: (data.kind === "income" ? "income" : "expense") as "expense" | "income",
                description: data.description,
                amountCents: data.amountCents,
                date: data.date,
                accountId: data.accountId,
              };
          const result = await checkDuplicate(dupInput);
          if (result.duplicate_detected && result.match) {
            const warning = formatDuplicateWarning(result.match, data.description);
            setDuplicateWarning(warning);
            setPendingData(data);
            return;
          }
        } catch {
          // Fail-open: on detection error, proceed to save.
        } finally {
          setCheckingDuplicate(false);
        }
      }

      await runSave(data);
    } finally {
      // O lock libera no settle; a CHAVE segue a regra de runSave (rotaciona
      // só em sucesso, mantém em falha/resposta desconhecida para retry).
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  async function handleForceConfirm() {
    // #185: confirmação duplicada ("Salvar mesmo assim" em duplo toque)
    // executa uma única vez; o dialog permanece aberto até o settle para o
    // segundo toque encontrar o lock, não um save novo.
    if (savingRef.current) return;
    const data = pendingData;
    if (!data) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const ok = await runSave(data);
      if (ok) {
        setDuplicateWarning(null);
        setPendingData(null);
      }
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  function handleDuplicateCancel() {
    setDuplicateWarning(null);
    setPendingData(null);
  }

  const tabs: { key: SheetTab; label: string }[] = [
    { key: "expense", label: "Despesa" },
    { key: "income", label: "Receita" },
    { key: "transfer", label: "Transferência" },
  ];

  const saveDisabled =
    amountCents <= 0 || checkingDuplicate || isSaving || missingOrigin ||
    (isTransfer && (!fromAccountId || !toAccountId || fromAccountId === toAccountId));

  return (
    <div className="flex flex-col gap-5" onChangeCapture={markDirty}>
      {/* Tabs */}
      <div className="flex gap-1 rounded-xl bg-fill-light p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              // Reset ALL draft fields when switching tabs. Without this,
              // amount/description leak across tabs (e.g. typing a Despesa
              // draft, switching to Transferência by mistake, and the wrong
              // amount/description silently carrying over).
              setTab(t.key);
              resetDraft();
            }}
            className={`flex-1 rounded-[10px] py-2.5 text-center text-[13px] font-bold transition-colors ${
              tab === t.key
                ? "bg-surface text-text-primary shadow-sm"
                : "text-text-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Valor */}
      <fieldset>
        <label htmlFor="nt-valor" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-muted">
          Valor
        </label>
        <div className="relative">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-[20px] font-semibold text-text-muted">
            R$
          </span>
          <input
            id="nt-valor"
            type="text"
            inputMode="numeric"
            value={amountDisplay}
            onChange={handleAmountInput}
            placeholder="0,00"
            className="w-full rounded-[13px] border border-border bg-surface py-3 pl-11 pr-3.5 font-mono text-[24px] font-semibold text-text-primary outline-none transition-colors focus:border-primary"
          />
        </div>
      </fieldset>

      {/* Data (custom calendar toggle) */}
      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">
          Data
        </div>
        <button
          type="button"
          aria-label={`Selecionar data: ${dateLabel}`}
          aria-expanded={calOpen}
          onClick={() => setCalOpen(!calOpen)}
          className="flex w-full items-center justify-between rounded-[13px] bg-surface px-3.5 py-3 text-left transition-colors"
          style={{
            border: `1.5px solid ${calOpen ? "var(--color-primary)" : "var(--color-border)"}`,
          }}
        >
          <span className="text-[16px] text-text-primary">{dateLabel}</span>
          <span className="flex items-center gap-1 text-text-muted">
            <Calendar size={16} />
            <ChevronDown size={14} className={`transition-transform ${calOpen ? "rotate-180" : ""}`} />
          </span>
        </button>
        {calOpen && (
          <div className="mt-1.5 rounded-[13px] border border-border bg-surface p-3">
            <div className="mb-2.5 flex items-center justify-between">
              <button
                onClick={prevCalMonth}
                type="button"
                className="rounded-[7px] px-2.5 py-1 text-[18px] text-text-secondary hover:bg-fill-light"
              >
                ‹
              </button>
              <span className="text-[13px] font-bold text-text-primary">
                {calLabel}
              </span>
              <button
                onClick={nextCalMonth}
                type="button"
                className="rounded-[7px] px-2.5 py-1 text-[18px] text-text-secondary hover:bg-fill-light"
              >
                ›
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center">
              {["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((d, i) => (
                <span
                  key={d}
                  className={`text-[9px] font-semibold ${i >= 5 ? "text-danger" : "text-text-muted"}`}
                >
                  {d}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {calCells.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={c.day === 0}
                  onClick={() => c.day > 0 && selectCalDay(c.day)}
                  className="min-h-[29px] rounded-[7px] text-center font-mono text-[12px] font-semibold transition-colors"
                  style={{
                    background: c.isSelected
                      ? "var(--color-primary)"
                      : c.isToday
                        ? "var(--color-fill-light)"
                        : "transparent",
                    color: c.isSelected
                      ? "#fff"
                      : c.isToday
                        ? "var(--color-primary)"
                        : "var(--color-text-primary)",
                  }}
                >
                  {c.day > 0 ? c.day : ""}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Descrição */}
      <fieldset>
        <label htmlFor="nt-descricao" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-muted">
          Descrição
        </label>
        <input
          id="nt-descricao"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ex: Aluguel, mercado..."
          className="w-full rounded-[13px] border border-border bg-transparent px-3.5 py-3 text-[16px] text-text-primary outline-none focus:border-primary"
        />
      </fieldset>

      {/* B1: Categoria (collapsible pill → BottomSheet) */}
      {!isTransfer && (
        <div>
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">
            Categoria
          </div>
          <button
            type="button"
            aria-label="Selecionar categoria"
            aria-expanded={categorySheetOpen}
            onClick={() => {
              setAddingCategory(false);
              setCategorySheetOpen(true);
            }}
            className="flex w-full items-center justify-between rounded-[13px] border border-border bg-surface px-3.5 py-3 text-left transition-colors focus:border-primary"
          >
            <span className="flex min-w-0 items-center gap-2">
              {selectedCategory || selectedSubcategory ? (
                <CategoryBadge name={selectedSubcategory?.name ?? selectedCategory?.name ?? ""} size={16} />
              ) : null}
              <span className={`truncate text-[15px] ${categoryId ? "font-semibold text-text-primary" : "text-text-muted"}`}>
                {categoryPillLabel}
              </span>
            </span>
            <ChevronDown size={16} className={`flex-none text-text-muted transition-transform ${categorySheetOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
      )}

      {/* B2: Origem — segmented toggle + collapsible selector */}
      {!isTransfer && (
        <div>
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">
            Origem
          </div>
          <div role="group" aria-label="Origem" className="flex h-9 gap-1 rounded-xl bg-fill-light p-1">
            {(
              [
                { key: "card", label: "Cartão", Icon: CreditCard },
                { key: "account", label: "Conta", Icon: Wallet },
              ] as const
            ).map(({ key, label, Icon }) => {
              // H-01: income never runs on a card (the API rejects it with
              // 422); the option is disabled instead of failing on save.
              const disabled = tab === "income" && key === "card";
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={originKind === key}
                  disabled={disabled}
                  title={disabled ? "Receitas usam conta" : undefined}
                  onClick={() => switchOriginKind(key)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-[10px] text-[13px] font-bold transition-colors ${
                    originKind === key
                      ? "bg-surface text-text-primary shadow-sm"
                      : "text-text-muted"
                  } ${disabled ? "opacity-40" : ""}`}
                >
                  <Icon size={15} />
                  {label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="Selecionar conta ou cartão"
            aria-expanded={originSheetOpen}
            onClick={() => {
              setAddingAccount(false);
              setAddingCard(false);
              setOriginSheetOpen(true);
            }}
            className="mt-2 flex w-full items-center justify-between rounded-[13px] border border-border bg-surface px-3.5 py-3 text-left transition-colors focus:border-primary"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] bg-fill-light text-text-secondary">
                {originKind === "card" ? <CreditCard size={16} /> : <Wallet size={16} />}
              </span>
              <span className="min-w-0">
                <span className={`block truncate text-[15px] ${selectedOrigin ? "font-semibold text-text-primary" : "text-text-muted"}`}>
                  {selectedOrigin?.name ?? "Selecionar"}
                </span>
                <span className="block truncate text-[11px] font-medium text-text-muted">
                  {originDetail}
                </span>
              </span>
            </span>
            <ChevronDown size={16} className={`flex-none text-text-muted transition-transform ${originSheetOpen ? "rotate-180" : ""}`} />
          </button>
          {missingOrigin && (
            <p className="mt-1.5 text-[12px] font-semibold text-text-muted">
              Escolha a origem para salvar.
            </p>
          )}
        </div>
      )}

      {/* B3: Parcelas — only for card origin */}
      {!isTransfer && originKind === "card" && (
        <fieldset>
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-muted">
            Parcelas
          </div>
          <div className="rounded-[13px] border border-border bg-fill-light px-3.5 py-3">
            <div className="flex flex-wrap gap-1.5">
              {INSTALLMENT_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={installmentsCount === n}
                  onClick={() => setInstallmentsCount(n)}
                  className={`rounded-[100px] px-3 py-1.5 text-[11px] font-bold transition-colors ${
                    installmentsCount === n
                      ? "bg-primary text-white"
                      : "bg-surface text-text-secondary"
                  }`}
                >
                  {n}x
                </button>
              ))}
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <span className="text-[12px] text-text-secondary">Personalizado:</span>
              <input
                type="number"
                inputMode="numeric"
                min={2}
                max={48}
                aria-label="Outro número de parcelas"
                value={
                  INSTALLMENT_OPTIONS.includes(installmentsCount)
                    ? ""
                    : installmentsCount
                }
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (n >= 2 && n <= 48) setInstallmentsCount(n);
                }}
                placeholder="18"
                className="w-[72px] rounded-[10px] border border-border bg-surface px-3 py-2 text-center font-mono text-[14px] font-semibold text-text-primary outline-none focus:border-primary"
              />
              <span className="text-[12px] text-text-secondary">× vezes</span>
            </div>
            {amountCents > 0 && installmentsCount > 1 && selectedOrigin && (
              <p className="mt-2.5 border-t border-border pt-2.5 text-[12px] text-text-secondary">
                {installmentsCount}x de {formatBRL(installmentCents)} na fatura de{" "}
                {invoiceMonthLabel(date, selectedOrigin.closingDay ?? 15)}
                {installmentsUneven && (
                  <> · última de {formatBRL(lastInstallmentCents)}</>
                )}
              </p>
            )}
          </div>
        </fieldset>
      )}

      {/* B4: secondary actions */}
      {!isTransfer && (
        <div className="rounded-[13px] border border-border bg-surface">
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen(!detailsOpen)}
            className="flex w-full items-center justify-between px-3.5 py-3 text-left"
          >
            <span className="text-[13px] font-bold text-text-secondary">Mais detalhes</span>
            <ChevronDown size={16} className={`text-text-muted transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
          </button>
          {detailsOpen && (
            <div className="px-3.5 pb-3.5">
              <label htmlFor="nt-observacoes" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-muted">
                Observações
              </label>
              <textarea
                id="nt-observacoes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="Ex: reembolsável, contexto da compra..."
                className="w-full resize-none rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-[14px] text-text-primary outline-none focus:border-primary"
              />
            </div>
          )}
        </div>
      )}

      {/* Transfer accounts */}
      {isTransfer && (
        <>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Origem (saída)
              </span>
              <button
                type="button"
                onClick={() => {
                  setAddingAccount(true);
                }}
                className="flex items-center gap-1 text-[11px] font-bold text-primary"
              >
                <Plus size={11} strokeWidth={2.8} />
                Nova
              </button>
            </div>

            {addingAccount && (
              <div className="mb-2">
                <InlineForm
                  onSave={handleSaveAccount}
                  onCancel={() => {
                    setAddingAccount(false);
                    setNewName("");
                    setNewInitialBalance("");
                  }}
                  saveLabel="Salvar conta"
                  fields={
                    <>
                      <input
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="Nome da conta"
                        className="mb-2 w-full rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                        autoFocus
                      />
                      <input
                        type="text"
                        inputMode="numeric"
                        value={newInitialBalance}
                        onChange={(e) => setNewInitialBalance(e.target.value)}
                        placeholder="Saldo inicial (R$)"
                        className="w-full rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                      />
                    </>
                  }
                />
              </div>
            )}

            <div className="mb-3 flex flex-wrap gap-[7px]">
              {filteredAccounts.map((acc) => {
                const selected = fromAccountId === acc.id;
                const color = acc.color ?? "#4A5568";
                const short = acc.name.slice(0, 2).toUpperCase();
                return (
                  <button
                    key={acc.id}
                    type="button"
                    onClick={() =>
                      setFromAccountId(acc.id === fromAccountId ? "" : acc.id)
                    }
                    className={`flex items-center gap-2 rounded-[100px] px-3.5 py-2 text-[12px] font-bold transition-colors ${selected ? "bg-primary text-white" : "bg-fill-light text-text-secondary"}`}
                  >
                    <span
                      className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] font-mono text-[8px] font-bold"
                      style={{ background: color, color: "#fff" }}
                    >
                      {short}
                    </span>
                    {acc.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Destino (entrada)
              </span>
            </div>
            <div className="flex flex-wrap gap-[7px]">
              {filteredAccounts.map((acc) => {
                const selected = toAccountId === acc.id;
                const color = acc.color ?? "#4A5568";
                const short = acc.name.slice(0, 2).toUpperCase();
                return (
                  <button
                    key={acc.id}
                    type="button"
                    onClick={() =>
                      setToAccountId(acc.id === toAccountId ? "" : acc.id)
                    }
                    className={`flex items-center gap-2 rounded-[100px] px-3.5 py-2 text-[12px] font-bold transition-colors ${selected ? "bg-primary text-white" : "bg-fill-light text-text-secondary"}`}
                  >
                    <span
                      className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] font-mono text-[8px] font-bold"
                      style={{ background: color, color: "#fff" }}
                    >
                      {short}
                    </span>
                    {acc.name}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Save button — sticky so it stays visible */}
      <div className="sticky bottom-0 -mx-1 bg-surface/95 px-1 pb-1 pt-2 backdrop-blur">
        <button
          onClick={() => handleSave(false)}
          disabled={saveDisabled}
          className="w-full rounded-[14px] bg-primary py-4 text-center text-[15px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {checkingDuplicate
            ? "Verificando..."
            : isSaving
              ? "Salvando..."
              : isTransfer
                ? "Transferir"
                : parcelado
                  ? `Salvar em ${installmentsCount}x`
                  : "Salvar"}
        </button>
      </div>

      {/* B1: category picker sheet */}
      <BottomSheet
        open={categorySheetOpen}
        onClose={() => {
          setCategorySheetOpen(false);
          setAddingCategory(false);
          setNewName("");
        }}
        title="Categoria"
      >
        <div className="flex flex-col gap-3 pb-2">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
              <Search size={15} />
            </span>
            <input
              type="text"
              aria-label="Buscar categoria"
              value={categorySearch}
              onChange={(e) => setCategorySearch(e.target.value)}
              placeholder="Buscar categoria"
              className="w-full rounded-[12px] border border-border bg-surface-2 py-2.5 pl-9 pr-3 text-[14px] text-text-primary outline-none focus:border-primary"
            />
          </div>

          {addingCategory ? (
            <InlineForm
              onSave={handleSaveCategory}
              onCancel={() => {
                setAddingCategory(false);
                setNewName("");
              }}
              saveLabel={categoryId ? "Salvar subcategoria" : "Salvar categoria"}
              fields={
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={categoryId ? "Nome da subcategoria" : "Nome da categoria"}
                  className="w-full rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                  autoFocus
                />
              }
            />
          ) : (
            onAddCategory && (
              <button
                type="button"
                onClick={() => setAddingCategory(true)}
                className="flex items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-primary/50 py-2.5 text-[13px] font-bold text-primary"
              >
                <Plus size={14} strokeWidth={2.6} />
                {categoryId
                  ? `Nova subcategoria em ${selectedCategory?.name ?? ""}`
                  : "Cadastrar nova"}
              </button>
            )
          )}

          {topCategories.top.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                Mais usadas
              </p>
              <div className="flex flex-col gap-1">
                {topCategories.top.map((cat) => (
                  <CategoryRow
                    key={cat.id}
                    cat={cat}
                    selected={categoryId === cat.id && !subcategoryId}
                    onSelect={() => {
                      setCategoryId(cat.id);
                      setSubcategoryId("");
                      setCategorySheetOpen(false);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-text-muted">
              Todas
            </p>
            <div className="flex flex-col gap-1">
              {topCategories.rest.map((cat) => {
                const subs = categories.filter((s) => s.parentId === cat.id);
                const expanded = categoryId === cat.id;
                return (
                  <div key={cat.id}>
                    <CategoryRow
                      cat={cat}
                      selected={expanded && !subcategoryId}
                      onSelect={() => {
                        if (expanded) {
                          setCategoryId("");
                          setSubcategoryId("");
                        } else {
                          setCategoryId(cat.id);
                          setSubcategoryId("");
                          if (subs.length === 0) setCategorySheetOpen(false);
                        }
                      }}
                    />
                    {expanded && subs.length > 0 && (
                      <div className="ml-6 mt-1 flex flex-wrap gap-1.5 pb-1">
                        {subs.map((sub) => {
                          const isSelected = subcategoryId === sub.id;
                          return (
                            <button
                              key={sub.id}
                              type="button"
                              onClick={() => {
                                setSubcategoryId(sub.id === subcategoryId ? "" : sub.id);
                                setCategorySheetOpen(false);
                              }}
                              className={`flex items-center gap-1 rounded-[100px] border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                                isSelected
                                  ? "border-primary bg-primary/10 font-bold text-primary"
                                  : "border-border-strong bg-fill-light text-text-secondary"
                              }`}
                            >
                              <CategoryBadge name={sub.name} size={12} />
                              {sub.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {topCategories.rest.length === 0 && topCategories.top.length === 0 && (
                <p className="py-3 text-center text-[12px] text-text-muted">
                  Nenhuma categoria encontrada.
                </p>
              )}
            </div>
          </div>
        </div>
      </BottomSheet>

      {/* B2: origin picker sheet */}
      <BottomSheet
        open={originSheetOpen}
        onClose={() => {
          setOriginSheetOpen(false);
          setAddingAccount(false);
          setAddingCard(false);
          setNewName("");
        }}
        title={originKind === "card" ? "Cartão" : "Conta"}
      >
        <div className="flex flex-col gap-3 pb-2">
          {originKind === "card" && onAddCard && (
            <button
              type="button"
              onClick={() => {
                setAddingCard(true);
                setAddingAccount(false);
              }}
              className="flex items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-primary/50 py-2.5 text-[13px] font-bold text-primary"
            >
              <Plus size={14} strokeWidth={2.6} />
              Novo cartão
            </button>
          )}
          {originKind === "account" && onAddAccount && (
            <button
              type="button"
              onClick={() => {
                setAddingAccount(true);
                setAddingCard(false);
              }}
              className="flex items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-primary/50 py-2.5 text-[13px] font-bold text-primary"
            >
              <Plus size={14} strokeWidth={2.6} />
              Nova conta
            </button>
          )}

          {addingAccount && originKind === "account" && (
            <InlineForm
              onSave={handleSaveAccount}
              onCancel={() => {
                setAddingAccount(false);
                setNewName("");
                setNewInitialBalance("");
              }}
              saveLabel="Salvar conta"
              fields={
                <>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Nome da conta"
                    className="mb-2 w-full rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                    autoFocus
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    value={newInitialBalance}
                    onChange={(e) => setNewInitialBalance(e.target.value)}
                    placeholder="Saldo inicial (R$)"
                    className="w-full rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                  />
                </>
              }
            />
          )}

          {addingCard && originKind === "card" && (
            <InlineForm
              onSave={handleSaveCard}
              onCancel={() => {
                setAddingCard(false);
                setNewName("");
                setNewCreditLimit("");
              }}
              saveLabel="Salvar cartão"
              fields={
                <>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Nome do cartão"
                    className="mb-2 w-full rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                    autoFocus
                  />
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={newCreditLimit}
                      onChange={(e) => setNewCreditLimit(e.target.value)}
                      placeholder="Limite (R$)"
                      className="w-full rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                    />
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={newClosingDay}
                      onChange={(e) => setNewClosingDay(e.target.value)}
                      placeholder="Fechamento"
                      className="w-full rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                    />
                  </div>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={newDueDay}
                    onChange={(e) => setNewDueDay(e.target.value)}
                    placeholder="Vencimento"
                    className="w-full rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                  />
                </>
              }
            />
          )}

          <div className="flex flex-col gap-1">
            {originOptions.map((acc) => {
              const selected = originId === acc.id;
              const detail =
                acc.kind === "credit_card"
                  ? acc.closingDay !== undefined
                    ? `Fecha dia ${acc.closingDay}`
                    : "Cartão de crédito"
                  : `Saldo ${formatBRL(acc.balanceCents)}`;
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => {
                    setOriginId(acc.id);
                    setOriginSheetOpen(false);
                  }}
                  className={`flex items-center gap-2.5 rounded-[12px] border px-3 py-2.5 text-left transition-colors ${
                    selected ? "border-primary bg-primary/5" : "border-border-subtle"
                  }`}
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-fill-light text-text-secondary">
                    {acc.kind === "credit_card" ? <CreditCard size={17} /> : <Wallet size={17} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-bold text-text-primary">
                      {acc.name}
                    </span>
                    <span className="block truncate text-[11px] font-medium text-text-muted">
                      {detail}
                    </span>
                  </span>
                  {selected && <Check size={17} className="flex-none text-primary" />}
                </button>
              );
            })}
            {originOptions.length === 0 && (
              <p className="py-3 text-center text-[12px] text-text-muted">
                {originKind === "card"
                  ? "Nenhum cartão cadastrado. Crie o primeiro acima."
                  : "Nenhuma conta cadastrada. Crie a primeira acima."}
              </p>
            )}
          </div>
        </div>
      </BottomSheet>

      <ConfirmActionDialog
        open={duplicateWarning !== null}
        title="Lançamento parecido encontrado"
        message={duplicateWarning ?? ""}
        confirmLabel="Salvar mesmo assim"
        cancelLabel="Cancelar"
        onConfirm={handleForceConfirm}
        onCancel={handleDuplicateCancel}
      />
    </div>
  );
}

function CategoryRow({
  cat,
  selected,
  onSelect,
}: {
  cat: Category;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-[12px] border px-3 py-2.5 text-left transition-colors ${
        selected ? "border-primary bg-primary/5" : "border-border-subtle"
      }`}
    >
      <CategoryBadge name={cat.name} size={18} />
      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-text-primary">
        {cat.name}
      </span>
      {selected && <Check size={16} className="flex-none text-primary" />}
    </button>
  );
}
