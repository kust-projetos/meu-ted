# Ativação controlada de `categories.create`

## Estado observado

No baseline de produção `9dc5d1c`:

- Gateway: `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0`.
- `TED_RUNTIME_CATEGORY_AUTOEXEC_MINT_TOKEN` está provisionado fora do
  repositório. Com a flag em `0`, o gateway não cria cliente de autoexecução.
- API: `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1` e
  `TED_RISK_BASED_AUTOEXECUTE=on` (valor preexistente). Isso, isoladamente,
  não ativa a execução no gateway.
- A autoexecução de `categories.create` permanece **inativa**. V2.1 não está
  homologada integralmente: P5 segue inconclusiva, conforme
  [VALIDATION.md](VALIDATION.md) e [HOMOLOGATION.md](HOMOLOGATION.md).

## Pré-requisitos e limites

Antes de qualquer ativação, cumprir
[`docs/runbooks/ted-runtime-paridade-flags.md`](../../runbooks/ted-runtime-paridade-flags.md):

- O dono da conversa (pin B) é obrigatório.
- A capability deve ser restrita a `categories.create`; não ampliar o escopo
  do cliente/token dedicado.
- O token dedicado deve permanecer fora do repositório, logs e instruções.
- Preservar a política server-side da API, que continua sendo a autoridade de
  execução.
- **Nunca habilitar autoexecução de movimentações financeiras.**

## Sequência proposta

1. Obter aprovação da homologação P5, com evidência de `/propose` e `/active`.
   P5 permanece inconclusiva; os resultados sintéticos não substituem essa
   aprovação.
2. Validar deterministicamente a jornada C em ambiente sintético e registrar
   evidência. O probe deve incluir
   `proposalIntentFound`, `intentEligible` e
   `wouldAttemptAutoexecAssumingNoCorrection`. Considerar os ajustes de
   instrumentação do probe em #452 e #453; estes não alteram produto ou
   política.
3. Somente após os gates anteriores e autorização específica do operador,
   alterar controladamente a flag do gateway para habilitar
   `categories.create`, registrando a tag de rollback
   `ted-runtime:rollback-pre-9dc5d1c`.
4. Executar smoke pós-flip, verificando a capability e o escopo permitidos,
   pin B e funcionamento das rotas relevantes; interromper se qualquer
   invariante ou resposta esperada falhar.
5. Monitorar a operação. Abortar diante de execução sem pin B, capability
   fora de `categories.create`, divergência da política da API, erro de
   `/propose` ou `/active`, ou qualquer tentativa de autoexecutar
   movimentação financeira. Não ampliar o escopo para contornar falhas.

## Gate e rollback

**Nenhuma flag de produção foi alterada nesta missão.** Qualquer flip exige
autorização específica e separada do operador. As issues #440 (homologação P5)
e #441 (ativação controlada/jornada C) permanecem abertas; não declarar a
V2.1 homologada.

Para rollback, restaurar `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0` e usar a
tag de rollback registrada. O rollback não requer nem autoriza exclusão de
dados.
