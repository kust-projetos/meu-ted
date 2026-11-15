"use client";

import { useState, useEffect } from "react";
import BottomSheet from "@/components/BottomSheet";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { useAppState } from "@/lib/state/app-state-context";
import { useFormDirtySafe } from "@/lib/unsaved-changes";
import type { Transaction } from "@/lib/state/types";

function formatInputBRL(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  const padded = digits.padStart(3, "0");
  const intPart = padded.slice(0, -2);
  const decPart = padded.slice(-2);
  return `${parseInt(intPart, 10).toLocaleString("pt-BR")},${decPart}`;
}

function parseInputBRL(value: string): number {
  const digits = value.replace(/\D/g, "");
  if (!digits) return 0;
  return parseInt(digits, 10);
}

interface TransactionEditSheetProps {
  open: boolean;
  transaction: Transaction | null;
  onClose: () => void;
}

export function TransactionEditSheet({
  open,
  transaction,
  onClose,
}: TransactionEditSheetProps) {
  const { updateTransaction, categories, accounts } = useAppState();
  const { markDirty, markClean, isDirty } = useFormDirtySafe();
  const isTransfer = transaction?.kind === "transfer";

  const [description, setDescription] = useState("");
  const [date, setDate] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (transaction && open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDescription(transaction.description);
      setDate(transaction.date);
      setAmountStr(formatInputBRL(String(transaction.amountCents)));
      setCategoryId(transaction.categoryId ?? "");
      setAccountId(transaction.accountId);
      setNotes(transaction.notes ?? "");
      markClean();
    }
  }, [transaction, open, markClean]);

  const [discardOpen, setDiscardOpen] = useState(false);
  if (!transaction) return null;

  const filteredCategories = categories.filter(
    (c) => c.kind === (transaction.kind === "income" ? "income" : "expense"),
  );

  function handleClose() { markClean(); onClose(); }
  function confirmDiscard() { setDiscardOpen(false); handleClose(); }
  function requestClose() {
    if (!isDirty) return true;
    setDiscardOpen(true);
    return false;
  }

  const handleSave = async () => {
    if (!description.trim() || !date) return;

    const input: {
      description?: string;
      date?: string;
      amountCents?: number;
      accountId?: string;
      categoryId?: string;
      notes?: string;
    } = {
      description: description.trim(),
      date,
    };

    if (!isTransfer) {
      const parsed = parseInputBRL(amountStr);
      if (parsed > 0) input.amountCents = parsed;
      if (accountId) input.accountId = accountId;
      if (categoryId) input.categoryId = categoryId;
      const trimmedNotes = notes.trim();
      if (trimmedNotes) input.notes = trimmedNotes.slice(0, 2000);
    }

    try {
      await updateTransaction(transaction.id, input);
      markClean();
      onClose();
    } catch {
      // Save failed: keep dirty.
    }
  };

  return (
    <>
    <BottomSheet open={open} onClose={handleClose} onBeforeClose={requestClose} title="Editar lançamento">
      <div className="flex flex-col gap-4" onChangeCapture={markDirty}>
        {/* Description */}
        <div>
          <label htmlFor="te-descricao" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-muted">
            Descrição
          </label>
          <input
            id="te-descricao"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-[12px] border border-border bg-surface px-3.5 py-2.5 text-[13px] text-text-primary outline-none"
          />
        </div>

        {/* Date */}
        <div>
          <label htmlFor="te-data" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-muted">
            Data
          </label>
          <input
            id="te-data"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-[12px] border border-border bg-surface px-3.5 py-2.5 text-[13px] text-text-primary outline-none"
          />
        </div>

        {/* Amount (not for transfers) */}
        {!isTransfer && (
          <div>
            <label htmlFor="te-valor" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-muted">
              Valor (R$)
            </label>
            <input
              id="te-valor"
              type="text"
              inputMode="numeric"
              value={amountStr}
              onChange={(e) => setAmountStr(formatInputBRL(e.target.value))}
              placeholder="0,00"
              className="w-full rounded-[12px] border border-border bg-surface px-3.5 py-2.5 text-[13px] text-text-primary outline-none"
            />
          </div>
        )}

        {/* Category (not for transfers) */}
        {!isTransfer && (
          <div>
            <label htmlFor="te-categoria" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-muted">
              Categoria
            </label>
            <select
              id="te-categoria"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full rounded-[12px] border border-border bg-surface px-3.5 py-2.5 text-[13px] text-text-primary outline-none"
            >
              <option value="">Sem categoria</option>
              {filteredCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Account (not for transfers) */}
        {!isTransfer && (
          <div>
            <label htmlFor="te-conta" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-muted">
              Conta
            </label>
            <select
              id="te-conta"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full rounded-[12px] border border-border bg-surface px-3.5 py-2.5 text-[13px] text-text-primary outline-none"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.kind === "credit_card" ? `Cartão • ${a.name}` : `Conta • ${a.name}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Notes (not for transfers) */}
        {!isTransfer && (
          <div>
            <label htmlFor="te-observacoes" className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-muted">
              Observações
            </label>
            <textarea
              id="te-observacoes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Ex: reembolsável, contexto da compra..."
              className="w-full resize-none rounded-[12px] border border-border bg-surface px-3.5 py-2.5 text-[13px] text-text-primary outline-none"
            />
          </div>
        )}

        {/* Save */}
        <button
          type="button"
          onClick={handleSave}
          className="w-full rounded-[12px] bg-primary py-3 text-[13px] font-bold text-white transition-opacity active:opacity-80"
        >
          Salvar
        </button>
      </div>
    </BottomSheet>
    <ConfirmActionDialog open={discardOpen} title="Descartar alterações?" message="As alterações não salvas serão perdidas." confirmLabel="Descartar" cancelLabel="Continuar editando" danger onConfirm={confirmDiscard} onCancel={() => setDiscardOpen(false)} />
    </>
  );
}
