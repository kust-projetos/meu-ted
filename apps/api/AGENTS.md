# Meu Ted — API autoritativa

API Fastify (TypeScript, Kysely, Postgres) em `apps/api`.
Única fonte da verdade financeira: workspace, ator e device
resolvidos sempre server-side; nunca confiar em claim do cliente.

- Toda mutação financeira exige `Idempotency-Key` com records
  de idempotência e tratamento de concorrência.
- Fluxo TED via PendingOperation V2 (proposta confirmada +
  capability delegada estreita); execução V2 só pela fronteira
  delegada do Agent; atestação nunca vai ao browser.
- Processo web é verify-only para migrations. Job explícito em
  `docs/runbooks/api-migration-v2.md`; sem migration/restart
  de produção a partir daqui.
- Comandos: `pnpm --filter meu-ted-api lint|typecheck|test`,
  `test:integration` e `build` (detalhes no README local).
- Regras financeiras (saldos bank/cash, undo, auditoria) e
  gates de conclusão: ver `AGENTS.md` da raiz (canônico).
