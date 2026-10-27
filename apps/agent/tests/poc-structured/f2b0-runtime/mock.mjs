import http from 'node:http'
import { appendFile } from 'node:fs/promises'

const log = process.env.F2B0_MOCK_LOG
const connLog = process.env.F2B0_CONN_LOG
const mode = process.env.F2B0_MODE
const model = process.env.F2B0_MODEL
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  let parsed
  try { parsed = JSON.parse(body) } catch { parsed = {} }
  await appendFile(log, `${JSON.stringify({ mode, method: req.method, path: req.url, model: parsed.model ?? null, messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0, messageRoles: Array.isArray(parsed.messages) ? parsed.messages.map((x) => x.role) : [], toolsCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0, toolNames: Array.isArray(parsed.tools) ? parsed.tools.map((x) => x.function?.name ?? x.name ?? 'unknown') : [], authorizationPresent: Boolean(req.headers.authorization) })}\n`)
  if (mode === 'reset') { req.socket.destroy(); return }
  if (mode === 'timeout') { await new Promise((resolve) => setTimeout(resolve, 1200)); res.end('{}'); return }
  if (mode === 'stream') { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '500' }); res.flushHeaders(); res.write(`data: {"id":"mock","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n`); await new Promise((resolve) => setTimeout(resolve, 120)); req.socket.destroy(); return }
  const status = Number(mode)
  if (status >= 400) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock failure', type: 'mock_failure', code: 'mock_failure' } })); return }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: {"id":"mock","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n`)
  res.write(`data: {"id":"mock","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`)
  res.end('data: [DONE]\n\n')
})
server.on('connection', (socket) => {
  void appendFile(connLog, `${JSON.stringify({ mode, accepted: true })}\n`)
  if (mode === 'proxy-refused') { socket.destroy(); return }
})
server.listen(43191, '127.0.0.1', () => process.stdout.write('READY\n'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
