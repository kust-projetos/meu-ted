import http from 'node:http'
import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { classifyAuthorizationHeader, headerShape, OFFICIAL_HEADERS, validateLoopbackMockRequest, verifyOfficialHeaderProof } from './request-contract.mjs'

let expectedProof = null
let providerRequestCount = 0
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/__expect') {
    let text = ''
    for await (const chunk of req) text += chunk
    let proof
    try { proof = JSON.parse(text) } catch { res.writeHead(400).end(); return }
    if (!Array.isArray(proof.names) || proof.names.some((name) => !OFFICIAL_HEADERS.includes(name)) || typeof proof.mac !== 'string' || !/^[a-f0-9]{64}$/.test(proof.mac)) { res.writeHead(400).end(); return }
    expectedProof = { names: proof.names, mac: proof.mac }
    res.writeHead(204).end()
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  let body = {}
  try { body = JSON.parse(raw) } catch {}
  const targetValid = validateLoopbackMockRequest(`http://127.0.0.1:43193${req.url}`, req.method)
  const proof = expectedProof ? verifyOfficialHeaderProof(req.headers, expectedProof, Buffer.from(process.env.DIAG_HEADER_PROOF_KEY, 'base64url')) : { namesMatch: false, valuesMatch: false, matches: false }
  expectedProof = null
  const transportValid = targetValid && proof.matches
  providerRequestCount += 1
  const userMessages = Array.isArray(body.messages) ? body.messages.filter((item) => item.role === 'user') : []
  const userText = userMessages.map((item) => typeof item.content === 'string' ? item.content : Array.isArray(item.content) ? item.content.map((part) => part.text ?? '').join('') : '')
  await appendFile(process.env.DIAG_MOCK_LOG, `${JSON.stringify({ method: req.method, path: req.url, headers: headerShape(req.headers), model: body.model ?? null, messageRoles: Array.isArray(body.messages) ? body.messages.map((item) => item.role) : [], userInputSha256: createHash('sha256').update(JSON.stringify(userText)).digest('hex'), userMessageCount: userMessages.length, toolCount: Array.isArray(body.tools) ? body.tools.length : 0, officialHeaderNamesMatch: proof.namesMatch, officialHeaderValuesMatch: proof.valuesMatch, officialHeaderProofMatches: proof.matches, transportValid, authorizationClass: classifyAuthorizationHeader(req.headers, process.env.OPENCODE_PASSWORD, 'public') })}\n`)
  if (!transportValid || providerRequestCount !== 1) { res.writeHead(400).end(); return }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end('data: {"id":"mock","object":"chat.completion.chunk","created":0,"model":"deepseek-v4.1-flash-free","choices":[{"index":0,"delta":{"role":"assistant","content":"mock-only"},"finish_reason":null}]}\n\ndata: {"id":"mock","object":"chat.completion.chunk","created":0,"model":"deepseek-v4.1-flash-free","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
})
server.listen(43193, '127.0.0.1', () => process.stdout.write('READY\n'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
