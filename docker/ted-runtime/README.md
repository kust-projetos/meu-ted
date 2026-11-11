# TED runtime (OpenCode) — alvo de produção

Runtime conversacional do Meu TED na VPS Contabo, atrás do Traefik existente.

## Superfície

| Item | Valor |
|---|---|
| Container | `ted-runtime` (imagem `ted-runtime:main`) |
| Rede interna | `proxy` (Traefik) + `pi-finance-postgres_default` (API) |
| Porta | `3101` — **nenhuma porta publicada no host** |
| Rota | `https://ted-gateway.synkroo.com.br` (TLS via `certresolver=cf`) |
| Estado | volume `ted_runtime_data` em `/data` (`TED_RUNTIME_HOME`) |
| API | `http://pi-finance-api:3001` (DNS interno, allowlist exata) |

O gateway aceita origem não-loopback **somente** com
`TED_GATEWAY_ALLOW_NON_LOOPBACK=1` e origem de API listada em
`TED_API_ALLOWED_ORIGINS` (match exato). Nenhuma interface administrativa é
exposta: o listener serve apenas `/agents/finance-chat-agent/<ws>/rpc/{chat,history,session/new}`.

## Segredos

- `OPENCODE_GO_API_KEY`: injetado pelo ambiente do host no `docker compose`
  (nunca na imagem, nunca no Git). O perfil `live` remove a chave herdada do
  ambiente e espelha apenas o alias preservado para o provider.

## Operação

```bash
# host: /home/deploy/infra/ted-runtime
export OPENCODE_GO_API_KEY=...        # sessão do operador; não persistir em arquivo
docker compose -f docker-compose.yml --project-name ted-runtime up -d --build
docker compose -f docker-compose.yml --project-name ted-runtime ps
docker compose -f docker-compose.yml --project-name ted-runtime logs -f --tail 100
```

## Atualização da config persistida (`opencode.json`)

O bootstrap grava `opencode.json` no home isolado
(`/data/.ted-home-prod/config/opencode.json`) e **recusa sobrescrever** um
conteúdo divergente — proteção contra trabalho do operador. Qualquer mudança
de código que altere `tedConfig` (permissões, policies, modelo) muda o conteúdo
esperado; sem atualizar o arquivo, o container entra em crash-loop com
`writeTedConfig: opencode.json already exists with different content`.

Recuperação (após sincronizar os fontes, antes do rebuild; rode da raiz do
repositório, onde `apps/ted-runtime/src/bootstrap.mjs` resolve):

```bash
MP=/var/lib/docker/volumes/ted_runtime_data/_data/.ted-home-prod/config

# 1) backup da config vigente
docker run --rm -v ted_runtime_data:/data ted-runtime:main \
  bash -c "cp -a $MP/opencode.json $MP/opencode.json.bak-$(date +%Y%m%d)"

# 2) grava o conteúdo esperado (perfil live, P3 writes ligado) — gerado pelo
#    próprio bootstrap, nunca escrito à mão
node -e "import('./apps/ted-runtime/src/bootstrap.mjs').then(m=>process.stdout.write(JSON.stringify(m.tedConfig('live',{p3Writes:true}),null,2)+'\n'))" \
  | docker run -i --rm -v ted_runtime_data:/data ted-runtime:main \
    bash -c "cat > $MP/opencode.json"
```

Nunca apague o volume inteiro: as conversas ficam no SQLite em `/data`.

## Rollback

1. **PWA (imediato, sem dados):** `TED_OPENCODE_RUNTIME_KILL_SWITCH=1` nas vars do
   PWA. Toda conversa P2 volta ao A0, inclusive as com pin `opencode.*`, e o pin
   é expirado. Operações pendentes vivem na API (por workspace), então a troca
   de runtime não duplica nem perde nada.
2. **Runtime:** `docker compose --project-name ted-runtime down` — o A0 segue
   atendendo; nenhum dado financeiro é copiado ou restaurado ao alternar runtime.

## Verificação

```bash
docker exec ted-runtime node -e "fetch('http://127.0.0.1:3101/').then(r=>console.log(r.status))"  # 404 esperado (rota desconhecida)
curl -sI https://ted-gateway.synkroo.com.br/ | head -1                                             # HTTP/2 404
```
