# Meu Ted API

API Fastify autoritativa do Meu Ted. Ela é a única fonte da verdade para
dados financeiros, autenticação, autorização por workspace, auditoria e
pending operations V2.

## Limites de segurança

- Sessão, workspace, ator e dispositivo são validados no servidor.
- Mutações exigem `Idempotency-Key`; operações do TED V2 exigem capability
  delegada estreita e proposta confirmada.
- Atestações não são retornadas ao browser. A API aceita execução V2 somente
  pela fronteira delegada do Agent.
- Substituição atômica de propostas fica habilitada somente com `PENDING_V2_SUPERSEDE_ENABLED=1`.
- O processo web é verify-only para migrations. Use somente o job explícito
  descrito em [`../../docs/runbooks/api-migration-v2.md`](../../docs/runbooks/api-migration-v2.md).

## Desenvolvimento e validação

```bash
pnpm --filter meu-ted-api lint
pnpm --filter meu-ted-api typecheck
pnpm --filter meu-ted-api test
pnpm --filter meu-ted-api test:integration
pnpm --filter meu-ted-api build
```

Não execute migration de produção, restart de VPS ou deploy a partir deste
README. O procedimento operacional separado requer backup, lock e autorização.
