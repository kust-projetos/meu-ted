"use client";

import { useEffect, useState, useCallback } from "react";
import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import { fetchAuditLogs, type AuditLog, type AuditLogFilters } from "@/lib/api/endpoints";
import { FileText, Filter, RotateCcw } from "lucide-react";
import AdoptionMetrics from "@/features/reports/AdoptionMetrics";

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [operation, setOperation] = useState("");
  const [actorType, setActorType] = useState<"" | "device" | "user">("");

  const load = useCallback(async (filters: AuditLogFilters = {}) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAuditLogs({
        limit: 20,
        entityType: filters.entityType || undefined,
        entityId: filters.entityId || undefined,
        operation: filters.operation || undefined,
        actorType: filters.actorType || undefined,
      });
      setLogs(result.items);
      setTotal(result.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao carregar auditoria");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function handleFilter() {
    void load({
      entityType: entityType.trim() || undefined,
      entityId: entityId.trim() || undefined,
      operation: operation.trim() || undefined,
      actorType: actorType || undefined,
    });
  }

  function handleClear() {
    setEntityType("");
    setEntityId("");
    setOperation("");
    setActorType("");
    void load({});
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <StatusBar />
      <PageHeader title="Auditoria" />
      <main className="flex flex-1 flex-col gap-4 px-5 pb-[calc(9rem+env(safe-area-inset-bottom))] sm:px-8 lg:px-12 lg:pb-8">
        <AdoptionMetrics />
        {/* Filters */}
        <div className="rounded-[18px] border border-border-subtle bg-surface-1 p-4 shadow-card">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-text-muted">Filtros</div>
          <div className="grid grid-cols-2 gap-3">
            <fieldset>
              <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Tipo de entidade</label>
              <input
                type="text"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
                placeholder="ex: account"
                className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                data-testid="filter-entityType"
              />
            </fieldset>
            <fieldset>
              <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">ID da entidade</label>
              <input
                type="text"
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
                placeholder="uuid"
                className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-2.5 font-mono text-[12px] text-text-primary outline-none focus:border-primary"
                data-testid="filter-entityId"
              />
            </fieldset>
            <fieldset>
              <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Operação</label>
              <input
                type="text"
                value={operation}
                onChange={(e) => setOperation(e.target.value)}
                placeholder="ex: accounts.create"
                className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                data-testid="filter-operation"
              />
            </fieldset>
            <fieldset>
              <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Tipo de ator</label>
              <select
                value={actorType}
                onChange={(e) => setActorType(e.target.value as "" | "device" | "user")}
                className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-2.5 text-[13px] text-text-primary outline-none focus:border-primary"
                data-testid="filter-actorType"
              >
                <option value="">Todos</option>
                <option value="device">Dispositivo</option>
                <option value="user">Usuário</option>
              </select>
            </fieldset>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={handleFilter}
              className="flex items-center justify-center gap-1.5 flex-1 rounded-[14px] bg-primary py-3 text-[13px] font-bold text-white shadow-fab hover:bg-primary-hover active:scale-[0.98] transition-all"
              data-testid="filter-apply"
            >
              <Filter size={15} />
              Filtrar
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="flex items-center justify-center gap-1.5 flex-1 rounded-[14px] border border-border-subtle bg-surface-2 py-3 text-[13px] font-bold text-text-secondary hover:bg-surface-3 active:scale-[0.98] transition-all"
              data-testid="filter-clear"
            >
              <RotateCcw size={15} />
              Limpar
            </button>
          </div>
        </div>

        {error && <div className="rounded-[12px] bg-danger-tint px-4 py-2.5 text-[12px] font-semibold text-danger">{error}</div>}

        {loading ? (
          <div className="flex flex-1 items-center justify-center py-12">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-border-subtle border-t-primary" />
              <span className="text-[13px] font-semibold text-text-muted">Carregando auditoria...</span>
            </div>
          </div>
        ) : logs.length === 0 ? (
          <div className="py-12 text-center text-text-muted" data-testid="audit-empty">
            <div className="mb-2 flex h-12 w-12 mx-auto items-center justify-center rounded-full bg-surface-2 text-text-muted shadow-xs">
              <FileText size={22} />
            </div>
            <div className="text-[14px] font-bold text-text-primary">Nenhum registro</div>
            <div className="mt-1 text-[12px] text-text-muted">Nenhum log para os filtros selecionados.</div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5" data-testid="audit-list">
            <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Total: {total} · Exibindo {logs.length}</div>
            {logs.map((log) => (
              <div
                key={log.id}
                className="rounded-[16px] border border-border-subtle bg-surface-1 px-4 py-3.5 shadow-card"
                data-testid="audit-item"
                data-entity-type={(log.metadata?.entityType as string) ?? ""}
                data-entity-id={log.effectRef ?? ""}
                data-operation={log.operation}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-full bg-surface-2 border border-border-subtle px-2.5 py-0.5 font-mono text-[10px] font-bold text-text-secondary">{log.operation}</span>
                  <span className="font-mono text-[11px] font-medium text-text-muted">{new Date(log.createdAt).toLocaleString("pt-BR")}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-[12px] font-medium">
                  <span className="text-text-secondary">Ator: <b className="text-text-primary">{log.actorType === "device" ? "Dispositivo" : log.actorType === "user" ? "Usuário" : log.actorType}</b></span>
                  <span className="text-text-muted">·</span>
                  <span className="text-text-secondary">Evento: <b className="text-text-primary">{log.eventType}</b></span>
                </div>
                {log.metadata && typeof (log.metadata as Record<string, unknown>).entityType === "string" && (
                  <div className="mt-1 font-mono text-[11px] text-text-muted">
                    entidade: {String((log.metadata as Record<string, unknown>).entityType)} {log.effectRef ? `· ${log.effectRef}` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
