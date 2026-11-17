# Meu Ted — API autoritativa

API Fastify (TypeScript, Kysely, Postgres) em `apps/api`.
Única fonte da verdade financeira: workspace, ator e device
resolvidos sempre server-side; nunca confiar em claim do cliente.

- Toda mutação financeira exige `Idempotency-Key` com records
  de idempotência e tratamento de concorrência.
- Fluxo TED via PendingOperation V2 (proposta confirmada +
  capability delegada estreita); sob a emenda de 2026-11-16 do
  ADR-031, o chamador delegado pode ser o Agent ou o runtime OpenCode B
  via `/auth/agent/autoexec-token`; atestação nunca vai ao browser,
  workspace/ator/device sempre server-side e API como autoridade.
- Processo web é verify-only para migrations. Job explícito em
  `docs/runbooks/api-migration-v2.md`; sem migration/restart
  de produção a partir daqui.
- Comandos: `pnpm --filter meu-ted-api lint|typecheck|test`,
  `test:integration` e `build` (detalhes no README local).
- Regras financeiras (saldos bank/cash, undo, auditoria) e
  gates de conclusão: ver `AGENTS.md` da raiz (canônico).
