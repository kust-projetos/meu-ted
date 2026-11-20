# Ativação controlada de `categories.create`

> **HISTÓRICO (2026-11-18):** as seções abaixo registram o estado no baseline
> `9dc5d1c`, quando a flag era `0` e P5 era INCONCLUSIVE/FAIL. O estado efetivo
> atual está em "Estado efetivo V2.1 (2026-11-19)" ao final deste documento.

## Estado observado (HISTÓRICO 2026-11-18)

No baseline de produção `9dc5d1c`:

- **HISTÓRICO (2026-11-18):** Gateway: `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0`.
- `TED_RUNTIME_CATEGORY_AUTOEXEC_MINT_TOKEN` está provisionado fora do
  repositório. Com a flag em `0`, o gateway não cria cliente de autoexecução.
- API: `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1` e
  `TED_RISK_BASED_AUTOEXECUTE=on` (valor preexistente). Isso, isoladamente,
  não ativa a execução no gateway.
- **HISTÓRICO (2026-11-18):** a autoexecução de `categories.create` permanecia
  **inativa**; V2.1 não estava homologada integralmente e rodadas P5 posteriores
  falharam (FAIL), conforme [VALIDATION.md](VALIDATION.md) e
  [HOMOLOGATION.md](HOMOLOGATION.md). Não descreve o estado atual.

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
   **HISTÓRICO (2026-11-18):** P5 permanece FAIL neste registro; os resultados
   sintéticos não substituem essa aprovação.
2. Validar deterministicamente a jornada C em ambiente sintético e registrar
   evidência. A resposta do gateway deve registrar `proposalObserved`; os
   diagnósticos do probe podem incluir `intentEligible` e
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

**HISTÓRICO (2026-11-18):** nenhuma flag de produção foi alterada naquela
missão; qualquer flip exigia autorização específica e separada do operador. As
issues #440 (homologação P5) e #441 (ativação controlada/jornada C) permaneciam
abertas. Não descreve o estado atual.

Para rollback, definir `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0` no host/`.env`
e usar a tag de rollback registrada (o compose versionado tem default `1`).
O rollback não requer nem autoriza exclusão de dados.

## Estado efetivo V2.1 (2026-11-19)

- Gateway: `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=1` (autorizado pelo operador
  em 2026-11-19); o compose interpola a variável com default `1`.
- API: `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1` e
  `TED_RISK_BASED_AUTOEXECUTE=on` (preexistente). Token dedicado provisionado
  fora do repositório; autoexecução restrita a `categories.create`, com dono da
  conversa (pin B).
- PRs **#455–#459** integrados; **P5 PASS** e **Jornada C PASS 4/4** em
  **ambiente sintético com LLM real**. **Smoke autenticado em produção (2026-11-20, Test Family): PASS** — login, conta, transação, extrato, TED lendo dado real e mutação por proposta com recibo único (`live-mobile-full`, 0 violações de workspace); `categories.create` por autoexec confirmado a partir do 2º turno da conversa (sem card; categoria lida como ativa pelo TED). Memória de categoria e preferência genérica entre sessões **não** validadas em produção (preferência genérica não é persistida por desenho).
- Esta seção substitui, para fins de estado atual, as afirmações históricas de
  flag `0` / P5 FAIL acima.
