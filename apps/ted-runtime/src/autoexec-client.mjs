const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function createAutoExecClient({ apiBaseUrl, allowedApiOrigins = [], serviceToken, fetchImpl = fetch, timeoutMs = 15000, mintPath = '/auth/agent/autoexec-token', serviceHeaderName = 'x-agent-autoexec-service-token' } = {}) {
  if (typeof serviceToken !== 'string' || serviceToken.length < 32) throw new Error('autoexec unavailable');
  let origin;
  try {
    const url = new URL(apiBaseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (url.pathname !== '/' || url.search || url.hash) ||
        (!LOOPBACK.has(host) && !allowedApiOrigins.includes(url.origin))) throw new Error();
    origin = url.origin;
  } catch { throw new Error('autoexec unavailable'); }

  async function request(path, { method = 'POST', body, token, service = false, identity, idempotencyKey, signal: externalSignal } = {}) {
    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    if (service) headers[serviceHeaderName] = serviceToken;
    else {
      headers.authorization = `Bearer ${token}`;
      headers['x-workspace-id'] = identity.workspaceId;
      headers['x-actor-id'] = identity.actorId;
      headers['x-device-id'] = identity.deviceId;
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    try {
      const response = await fetchImpl(`${origin}${path}`, { method, headers, body: JSON.stringify(body ?? {}), redirect: 'manual', signal });
      if (response.status >= 300 && response.status < 400) throw coded('upstream_error');
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw coded('upstream_error');
      return data;
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === 'AbortError') throw coded('uncertain');
      throw coded('upstream_error');
    } finally { clearTimeout(timer); }
  }
  const ident = (x) => ({ workspaceId: x.workspaceId, actorId: x.actorId, deviceId: x.deviceId });
  return {
    mint: (x) => request(mintPath, {
      body: { workspaceId: x.workspaceId, actorId: x.actorId, deviceId: x.deviceId, intentionId: x.intentionId },
      service: true, signal: x.signal,
    }),
    async propose(x) {
      const data = await request('/pending-operations/v2/propose', { token: x.token, identity: ident(x), idempotencyKey: x.idempotencyKey, body: { tool: 'categories.create', normalizedArgs: x.normalizedArgs }, signal: x.signal });
      if (typeof data.id !== 'string' || !data.id) throw coded('upstream_error');
      return { operationId: data.id, existing: data.existing === true };
    },
    async authorize(x) {
      const data = await request(`/pending-operations/v2/${encodeURIComponent(x.operationId)}/authorize`, { token: x.token, identity: ident(x), body: {}, signal: x.signal });
      if (data.id !== x.operationId || data.status !== 'confirmed' || typeof data.attestation !== 'string' || data.attestation.length < 32) throw coded('upstream_error');
      return { operationId: data.id, status: data.status, attestation: data.attestation };
    },
    execute: (x) => request(`/pending-operations/v2/${encodeURIComponent(x.operationId)}/execute`, { token: x.token, identity: ident(x), body: { attestation: x.attestation }, signal: x.signal }),
  };
}

function coded(code) { return Object.assign(new Error(code === 'uncertain' ? 'autoexec outcome uncertain' : 'autoexec request failed'), { code }); }
