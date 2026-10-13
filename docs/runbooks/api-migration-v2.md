# Runbook — API V2: migration, verify e restart

Este procedimento mantém o processo web em modo `verify-only`. O processo web
nunca cria tabela, altera coluna ou executa migration.

## Sequência controlada

1. Confirmar o backup e registrar um identificador não secreto.
2. Executar o job explícito em uma única réplica, com
   `DB_MIGRATION_MODE=apply BACKUP_CONFIRMED=true BACKUP_ID=<id> pnpm --dir
   apps/api exec tsx src/scripts/migrate-job.ts`.
   O job exige o marcador de banco de teste quando executado localmente,
   registra o backup e usa advisory lock; uma segunda execução falha sem SQL.
3. Verificar schema e checksums com o mesmo `DATABASE_URL` usando a API em
   modo de inicialização. A verificação é somente leitura e bloqueia readiness
   quando o ledger diverge ou está incompleto.
4. Reiniciar a API somente após o job terminar e a verificação passar. O
   endpoint `/health` indica processo vivo; `/ready` só existe após o bootstrap
   completo.

## Falhas e rollback

- Ausência de `DATABASE_URL`, segredo, workspace, admin ou origin HTTPS em
  produção encerra o processo antes de readiness.
- Divergência de checksum exige auditoria e nova migration aditiva; nunca edite
  uma migration aplicada.
- Em rollback de aplicação, mantenha o ledger e as migrations V2; não reative
  `[EXEC_ACTION]`, write sem confirmação ou qualquer bypass de capability.

## Pré-swap obrigatório — ledger × manifesto (lição do incidente 13/10)

Antes de qualquer swap/rollback de imagem da API na VPS, passo obrigatório:

1. Ler o ledger de migrations aplicado no banco
   (`SELECT version ... FROM _migrations` ou o verificador de schema).
2. Ler o manifesto da imagem-alvo (versões V0xx que ela contém).
3. Só fazer o swap se `manifesto(imagem-alvo) ⊇ ledger(banco)`.
   Rollback para imagem com manifesto < ledger é **inválido sob o startup
   guard atual**: o processo recusa readiness e a API entra em crash-loop
   (foi o que estendeu o outage de 13/10 após o `FST_ERR_DUPLICATED_ROUTE`
   do release `3c3a3f9`). Alternativas válidas: forward-fix compatível com
   o ledger atual, ou restore a partir de backup verificado.

Não execute este procedimento contra produção durante desenvolvimento da SPEC.
