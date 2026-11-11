# Codex - login via browser (plano Coding)

> **Status (2026-11-10):** `apps/codex-broker` foi removido do monorepo.
> Procedimento histórico; não existe broker local para autenticar.

Fluxo mínimo viável para autenticar o provider `openai-codex-subscription`
(Catalogo: **Codex (plano Coding)**) no broker privado, no mesmo espírito do
login de `pi dev` / `opencode`: o operador aprova no browser, o broker guarda
a sessão em arquivo local com modo `0600`.

## Pré-requisitos

- Broker acessível (`CODEX_BROKER_ORIGIN`) com Cloudflare Access configurado
  (`CODEX_BROKER_ACCESS_CLIENT_ID/SECRET`) e chave de assinatura
  (`CODEX_BROKER_REQUEST_SIGNING_KEY`).
- Cache local em `/var/lib/codex-auth/auth.json` (diretório `0700`).

## Passo a passo

1. Iniciar o login (retorna URI de verificação + código do usuário):
   ```bash
   curl -s -X POST "$CODEX_BROKER_ORIGIN/auth/login" \
     -H "cf-access-client-id: $CODEX_BROKER_ACCESS_CLIENT_ID" \
     -H "cf-access-client-secret: $CODEX_BROKER_ACCESS_CLIENT_SECRET" \
     -H 'content-type: application/json' -d '{}' | jq .
   ```
2. Abrir `verificationUri` no browser, conferir o `userCode` e aprovar com a
   conta que possui o plano Coding.
3. Concluir com o `code` retornado pelo redirect (via ferramenta local que
   escuta o callback `localhost`, ou colando o código):
   ```bash
   curl -s -X POST "$CODEX_BROKER_ORIGIN/auth/callback" \
     -H "cf-access-client-id: $CODEX_BROKER_ACCESS_CLIENT_ID" \
     -H "cf-access-client-secret: $CODEX_BROKER_ACCESS_CLIENT_SECRET" \
     -H 'content-type: application/json' \
     -d '{"code":"<oauth-code>","state":"<state-do-passo-1>"}' | jq .
   ```
4. Conferir o status (metadados apenas, sem token):
   ```bash
   curl -s "$CODEX_BROKER_ORIGIN/auth/status" \
     -H "cf-access-client-id: $CODEX_BROKER_ACCESS_CLIENT_ID" \
     -H "cf-access-client-secret: $CODEX_BROKER_ACCESS_CLIENT_SECRET" | jq .
   ```
   Esperado: `{"auth":{"authenticated":true,"reauthRequired":false,...}}`.

## Segurança

- O token **nunca** aparece em log nem em resposta HTTP — somente no arquivo
  `auth.json` (`0600`, escrita atômica `fsync+rename`).
- Sem `codeExchange` configurado no deploy, `/auth/callback` falha fechado
  com `502 login_exchange_failed` (o broker nunca finge um login).
- Revogação: `POST /auth/logout` (com envelope HMAC) grava
  `{"reauthRequired": true}`; o broker passa a responder
  `401 codex_reauth_required`.
- No app **Meu Ted**, o provider Codex exibe status via `/auth/status` e usa
  entrada manual de model id (sem listagem pública de modelos).

## Troubleshooting

| Sintoma | Causa provável | Ação |
|---|---|---|
| `login_unknown_state` (400) | state errado ou broker reiniciado (pendências são em memória) | Repetir o passo 1 |
| `login_expired` (410) | passaram 10 min sem concluir | Repetir o passo 1 |
| `codex_reauth_required` (401) no chat | sessão expirada/revogada | Refazer o login |
| `insecure_file_permissions` | `auth.json` fora de `0600` (POSIX) | `chmod 0600` + novo login |
