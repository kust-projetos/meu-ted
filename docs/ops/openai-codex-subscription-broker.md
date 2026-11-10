# OpenAI Codex Subscription Private Broker Runbook

> **Status (2026-11-10):** `apps/codex-broker` foi removido do monorepo.
> Este runbook permanece como registro histórico; o cliente opcional do A0
> falha fechado sem `CODEX_BROKER_ORIGIN` e signing key.

Este documento define os procedimentos de operação, governança de segurança e isolamento de runtime do **Codex Subscription Broker** (`apps/codex-broker`), utilizado como transporte privado e restrito para o assistente conversacional TED (`apps/agent`).

---

## 1. Topologia e Isolamento de Segurança

```
+-------------------+                    +-----------------------+                    +-------------------------+
|  apps/agent       | -- [CF Access] --> |  apps/codex-broker    | -- [Loopback] ---> |  Codex Runtime          |
|  (Cloudflare DO)  | -- [HMAC 30s]  --> |  (VPS Container/Root) |                    |  (/var/lib/codex-auth)  |
+-------------------+                    +-----------------------+                    +-------------------------+
```

1. **Envelope HMAC com TTL de 30 Segundos**:
   - Cada requisição originada do Worker assina o corpo com SHA-256 e gera um envelope `{kid, aud: 'pi-codex-broker', timestamp, nonce, requestId, bodySha256}`.
   - Nonces são consumidos atomicamente na memória do broker para impedir ataques de repetição (*anti-replay*).
2. **Cloudflare Access (Camada de Transporte)**:
   - Requisições externas são filtradas na borda por Service Tokens da Cloudflare (`CF-Access-Client-Id` e `CF-Access-Client-Secret`).
3. **Isolamento de Contêiner Rootless**:
   - Execução sob usuário não-root `appuser:10001` com `read_only: true` e `no-new-privileges: true`.
   - Único diretório gravável: `/var/lib/codex-auth` (modo estrito `0700` no diretório e `0600` no arquivo `auth.json`).

---

## 2. Status de Elegibilidade

> [!IMPORTANT]
> O provedor `openai-codex-subscription` permanece classificado como `eligibility: "experimental_blocked"` até a conclusão dos testes de paridade de ferramentas financeiras na Task 6. O painel administrativo e a API impedem sua ativação produtiva até lá.

---

## 3. Runbook Operacional

### 3.1 Verificação de Saúde e Autenticação
```bash
curl -s http://127.0.0.1:3005/health | jq .
```
Resposta esperada:
```json
{
  "status": "ready",
  "auth": {
    "authenticated": true,
    "reauthRequired": false,
    "modeVerified": true
  },
  "models": ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o3-mini"]
}
```

### 3.2 Reseed e Login Inicial
1. Efetue login via device code no terminal local seguro ou CLI oficial.
2. Salve o token resultante via persistência atômica `fsync+rename` no caminho `/var/lib/codex-auth/auth.json`.
3. Garanta permissões `chmod 0600 /var/lib/codex-auth/auth.json`.

### 3.3 Revogação e Logout
Em caso de suspeita de comprometimento ou expiração:
```bash
echo '{"reauthRequired": true}' > /var/lib/codex-auth/auth.json
chmod 0600 /var/lib/codex-auth/auth.json
```
O broker responderá imediatamente com `401 codex_reauth_required` sem realizar fallback silencioso.
