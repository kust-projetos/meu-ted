# Runtime Ownership Matrix

Matriz de ownership dos runtimes conversacionais do Meu TED. Substitui a
matriz histórica Pi/WhatsApp, removida com esses runtimes.

## Estados

| Pin da conversa | Runtime que responde | Escrita financeira | Estado |
|---|---|---|---|
| `agent` | A0 (`apps/agent`) | Somente via Pending V2 + confirmação | Rollback e conversas legadas |
| `opencode.<uuid>` | OpenCode (`apps/ted-runtime`) | Somente intenção → broker do A0 → Pending V2 | Principal |
| Sem pin + `TED_OPENCODE_RUNTIME_ENABLED=1` | OpenCode | Idem | Nova conversa |
| Sem pin + flag ausente/off | A0 | Idem | Default conservador |
| Qualquer pin + `TED_OPENCODE_RUNTIME_KILL_SWITCH=1` | A0 | Idem; pin expirado | Rollback imediato |

## Invariantes

1. **Um dono por turno:** a mesma intenção financeira nunca é disparada em A0
   e OpenCode. A seleção é server-side e persistida por conversa.
2. **Identidade server-side:** o gateway OpenCode resolve sessão, workspace e
   dispositivo na API; nunca aceita workspace do corpo ou de argumentos do
   modelo.
3. **Escrita não nasce no modelo:** o runtime OpenCode produz apenas uma
   intenção; o broker do A0 emite `financial.approval.propose` e a API
   mantém a autoridade, idempotência e recibo.
4. **Rollback sem migração de dados:** operações pendentes vivem na API por
   workspace, então alternar runtime não duplica nem perde nada.
5. **Falha fechada:** binding ausente, origem não listada, token inválido ou
   identidade divergente interrompem o turno antes de qualquer tool.
