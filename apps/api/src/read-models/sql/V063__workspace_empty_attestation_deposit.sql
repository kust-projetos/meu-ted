-- V063 — FIX-WS-D2-R5: depósito server-side da prova de vazio Agent→API.
--
-- ADITIVA: UMA tabela nova; nenhuma tabela existente é alterada em dados
-- ou estrutura. A prova HMAC do lado Agent (SQLite/R2 do Agent) nunca
-- cruza o browser: o Agent deposita DIRETAMENTE na API (server-to-server,
-- rota interna autenticada por service token) e o browser recebe SÓ o
-- handle opaco (UUID). O delete consome o depósito com join server-side
-- (workspace + versão vinculada + expiração + não-consumido), single-use
-- (`consumed_at`).
--
-- Sem remoção física de linhas, sem cascata, sem tocar em audit: o
-- depósito é evidência de barreira (expira curto, 5 min) e morre por
-- expiração lógica (nunca reutilizável após `consumed_at`).
--
-- DOWN-MIGRATION: apenas DROP da tabela nova — SEGURO somente se nenhum
-- delete-vazio R5 estiver em voo (fail-closed: verifique antes).

CREATE TABLE IF NOT EXISTS workspace_empty_attestations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id      UUID NOT NULL REFERENCES households(id),
    inventory_version CHAR(64) NOT NULL CHECK (inventory_version ~ '^[0-9a-f]{64}$'),
    counts            JSONB NOT NULL,
    expires_at        TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at       TIMESTAMPTZ
);
