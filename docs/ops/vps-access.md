# Acesso VPS — Meu Ted

## Fonte de configuração

Execute comandos a partir da raiz deste projeto. Configuração privada fica em `../vps-hostinger/.env`.

Nunca copie senha, token, chave privada ou valor de `.env` para este repositório.

### Bash/Git Bash

```bash
VPS_ENV=../vps-hostinger/.env
set -a
. "$VPS_ENV"
set +a
: "${VPS_IP:?VPS_IP ausente}"
: "${VPS_SSH_USER:?VPS_SSH_USER ausente}"
: "${VPS_SSH_KEY_PATH:?VPS_SSH_KEY_PATH ausente}"
```

### PowerShell

```powershell
$envFile = Resolve-Path ..\vps-hostinger\.env
$values = Get-Content $envFile |
  Where-Object { $_ -match '^\s*[^#\s][^=]*=' } |
  ConvertFrom-StringData
$VPS_IP = $values.VPS_IP
$VPS_SSH_USER = $values.VPS_SSH_USER
$VPS_SSH_KEY_PATH = $values.VPS_SSH_KEY_PATH
```

## Conexão

```bash
ssh -i "$VPS_SSH_KEY_PATH" "$VPS_SSH_USER@$VPS_IP"
```

Antes de alterar produção:

```bash
ssh -i "$VPS_SSH_KEY_PATH" "$VPS_SSH_USER@$VPS_IP" \
  'hostname; uptime; docker ps; docker compose ls; systemctl --failed'
```

## Pi-stack (histórico — Hostinger)

O `pi-stack` da Hostinger foi o ambiente operacional real até 2026-10-03. O
pi-financeiro foi removido da Hostinger nessa data (containers, volume e
imagens) e a produção atual roda na VPS Contabo; o `pi-stack` permanece aqui
apenas como referência histórica, não como destino de deploy ou auditoria.

```bash
ssh -t -i "$VPS_SSH_KEY_PATH" "$VPS_SSH_USER@$VPS_IP" \
  'docker exec -it pi-stack bash'
```

Se o nome não existir, descubra primeiro:

```bash
ssh -i "$VPS_SSH_KEY_PATH" "$VPS_SSH_USER@$VPS_IP" \
  'docker ps --format "table {{.Names}}\t{{.Status}}"; docker compose ls'
```

- Docker: inspecione compose, volumes e saúde antes de `up`, restart ou migração.
- systemd: confira status e journal antes de restart.
- PM2: confira `pm2 list` e logs; processos locais não são fonte de verdade.
- Banco: use `scripts/ssh-tunnel-postgres.bat` apenas quando túnel local for necessário.
- Deploy/rollback: identifique release, faça backup, execute uma mudança e valide healthcheck.
- Logs: nunca reproduza tokens, cookies, senhas, URLs de banco ou chaves.

## Topologia vigente

Backend de produção roda na VPS Contabo. PWA canônica na Cloudflare →
API autoritativa na Contabo; Agent TED na Cloudflare → mesma API. (O caminho
antigo WhatsApp → Evolution API → bridge → Pi RPC foi removido em `f640e84`
e permanece apenas como histórico.)

## Topologia conhecida (histórico)

Registro antigo (pré-2026-10-03): WhatsApp → Evolution API → bridge → Pi RPC →
Evolution API; PWA na Cloudflare e backend com `pi-stack` na Hostinger. Não
usar como topologia vigente — ver "Topologia vigente" acima.

## Operações destrutivas

Exigem confirmação explícita e backup verificado: `rm -rf`, drop/reset de banco, remoção de volume, rotação de credencial, alteração de firewall e encerramento amplo de processos.

SSH por chave é obrigatório; senha não é necessária.
