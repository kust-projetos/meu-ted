"use client";

import { describePendingOperationStatus, type SelfConfirmExecution } from "@/lib/api/agent-client";

/**
 * Resultado final, somente leitura, de uma operação confirmada e executada
 * pelo próprio agente (ADR-033). Não há Confirmar/Cancelar/Tentar novamente:
 * o resultado é apenas comunicado ao usuário. Um `succeeded` sem recibo
 * canônico válido é degradado a `unverified` na fronteira do cliente e nunca
 * chega aqui como sucesso.
 */
const deriveLabel = (execution: SelfConfirmExecution): string => {
  if (execution.tool.includes("cards.statement.pay")) return "Pagamento de fatura";
  if (execution.tool.includes("transactions.update")) return "Alterar descrição do lançamento";
  if (execution.tool.includes("transactions.transfer.create")) return "Transferência";
  if (execution.tool.includes("categories.create")) return "Criar categoria";
  if (execution.tool.includes("categories.update")) return "Renomear categoria";
  if (execution.tool.includes("categories.deactivate")) return "Desativar categoria";
  if (execution.tool.includes("accounts.update")) return "Renomear conta";
  if (execution.tool.includes("deactivate")) return "Desativar conta";
  if (execution.tool.includes("income")) return "Receita";
  if (execution.tool.includes("expense")) return "Despesa";
  if (execution.tool.includes("account")) return "Conta";
  return "Operação financeira";
};

export function TedExecutionCard({ execution }: { execution: SelfConfirmExecution }) {
  const label = deriveLabel(execution);

  if (execution.status === "succeeded") {
    return (
      <div
        role="status"
        data-testid="ted-execution-card"
        data-execution-status="succeeded"
        className="my-2 rounded-[14px] border border-border-subtle bg-surface-2 p-3 text-xs text-text-secondary"
      >
        <strong className="text-primary">✅ Operação registrada: {label}</strong>
        <div className="mt-0.5">Recibo validado — conclusão confirmada.</div>
      </div>
    );
  }

  if (execution.status === "failed") {
    return (
      <div
        role="status"
        data-testid="ted-execution-card"
        data-execution-status="failed"
        className="my-2 rounded-[14px] border border-danger/30 bg-danger-tint p-3 text-xs text-danger"
      >
        <strong>Não foi possível concluir a operação — {describePendingOperationStatus("failed")}.</strong>
        <div className="mt-0.5">{label}</div>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-testid="ted-execution-card"
      data-execution-status="unverified"
      className="my-2 rounded-[14px] border border-warning/30 bg-warning-tint p-3 text-xs text-text-secondary"
    >
      <strong className="text-warning">⏳ Não foi possível verificar a conclusão: {label}</strong>
      <div className="mt-0.5">Atualize o estado antes de tomar outra decisão.</div>
    </div>
  );
}
