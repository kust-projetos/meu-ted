-- V062 — D2 (ADR-027): delete só-vazio com registro de fechamento + tombstone.
--
-- ADITIVA: nenhuma tabela existente é alterada em dados; households ganha
-- o estado terminal 'deleted' (linha preservada como marcador, nunca
-- removida) e duas tabelas novas registram o fechamento e o tombstone
-- anti-reuso (id nunca reutilizado). Sem remoção física de linhas, sem
-- cascata: o apagamento de dados de domínio NÃO existe nesta migration —
-- purge com-dados permanece bloqueado até
-- retenção/exportação/política estarem definidas.
--
-- Auditoria e idempotência (audit_logs, operation_records,
-- idempotency_keys) são preservadas pelo delete: a prova de "vazio" cobre
-- dados de domínio + pendings/incertos/jobs + convites (ver
-- workspace-deletion.ts); evidência append-only nunca é removida para
-- "esvaziar".
--
-- DOWN-MIGRATION: apenas remoção das duas tabelas novas + reversão do CHECK
-- para ('active','archived') — SEGURO somente se nenhuma linha households
-- estiver com status 'deleted' (fail-closed: verifique antes).

-- NOTA (FIX CI card-store-idor): os guards abaixo são qualificados por
-- conrelid resolvido via search_path ('households'::regclass). Checar
-- SÓ conname (cluster-wide) quebra migrations com search_path alternativo:
-- o IF EXISTS enxerga o constraint de OUTRO schema e o DROP falha no
-- schema alvo ("constraint does not exist"). Conrelid + search_path mantêm
-- DROP e ADD consistentes no mesmo namespace, por schema.
DO $$
DECLARE
  households_oid OID := 'households'::regclass;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = households_oid AND conname = 'households_status_chk') THEN
    ALTER TABLE households DROP CONSTRAINT households_status_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = households_oid AND conname = 'households_status_chk') THEN
    ALTER TABLE households
      ADD CONSTRAINT households_status_chk
      CHECK (status IN ('active', 'archived', 'deleted'));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = households_oid AND conname = 'households_archive_timestamp_chk') THEN
    ALTER TABLE households DROP CONSTRAINT households_archive_timestamp_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = households_oid AND conname = 'households_archive_timestamp_chk') THEN
    ALTER TABLE households
      ADD CONSTRAINT households_archive_timestamp_chk
      CHECK ((status = 'active' AND archived_at IS NULL)
          OR (status = 'archived' AND archived_at IS NOT NULL)
          OR (status = 'deleted'));
  END IF;
END $$;

-- Registro durável de fechamento: quem, quando, sob qual inventário.
CREATE TABLE IF NOT EXISTS workspace_closure_log (
    household_id      UUID PRIMARY KEY REFERENCES households(id),
    closed_by         TEXT NOT NULL,
    action            TEXT NOT NULL DEFAULT 'workspace.delete'
                      CHECK (action = 'workspace.delete'),
    inventory_version CHAR(64) NOT NULL CHECK (inventory_version ~ '^[0-9a-f]{64}$'),
    agent_attestation TEXT NOT NULL DEFAULT 'unverified',
    closed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tombstone anti-reuso: o id excluído nunca volta a existir.
CREATE TABLE IF NOT EXISTS workspace_tombstones (
    household_id      UUID PRIMARY KEY REFERENCES households(id),
    deleted_by        TEXT NOT NULL,
    inventory_version CHAR(64) NOT NULL CHECK (inventory_version ~ '^[0-9a-f]{64}$'),
    deleted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_closure_log_closed_at_idx
  ON workspace_closure_log (closed_at);
