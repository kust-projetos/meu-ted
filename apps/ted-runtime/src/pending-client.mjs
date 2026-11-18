import { createHash } from 'node:crypto';
const LOOPBACK = new Set(['127.0.0.1','::1','localhost']);
const RECEIPT_KINDS = new Set(['transactions.expense.create','transactions.income.create','transactions.transfer.create','transactions.update','accounts.create','accounts.deactivate','accounts.update','categories.create','categories.update','categories.deactivate','cards.purchase.create','cards.statement.pay','payables.create','payables.pay','transaction.create','transaction.update','transaction.delete','transfer.create','payable.create','payable.update','payable.delete','payable.pay','payable.payment.undo']);
const REFRESH_TARGETS = new Set(['transactions','accounts','dashboard-summary','budgets','quick-insights','payables','statement','goals','categories','subscription','agent-conversation']);
function validReceipt(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!['mutationId','mutationKind','status','affectedTargets','operationId','entity'].includes(k))) return false;
  if (typeof value.mutationId!=='string'||!value.mutationId.trim()||!RECEIPT_KINDS.has(value.mutationKind)||value.status!=='succeeded'||!Array.isArray(value.affectedTargets)) return false;
  if (!value.operationId || typeof value.operationId!=='string') return false;
  if (value.entity!==undefined && (!value.entity||typeof value.entity.type!=='string'||typeof value.entity.id!=='string'||Object.keys(value.entity).some(k=>!['type','id'].includes(k)))) return false;
  return value.affectedTargets.every(x=>typeof x==='string'&&REFRESH_TARGETS.has(x));
}
function validOutcome(value,id) {
  const shared=['operationId','tool','status','expectedContext'];
  const statusFields={
    proposed:shared, confirmed:shared, executing:shared,
    succeeded:[...shared,'receipt'],
    failed:[...shared,'failureCode'],
    cancelled:shared, expired:shared, unverified:shared,
  }[value.status];
  if (!statusFields || Object.keys(value).some(k=>!statusFields.includes(k)) ||
      value.operationId!==id || typeof value.tool!=='string' || value.tool.length<1) return false;
  if (value.expectedContext!==undefined && (!value.expectedContext || typeof value.expectedContext.tool!=='string' ||
      Object.keys(value.expectedContext).some(k=>!['tool','entityId'].includes(k)) ||
      (value.expectedContext.entityId!==undefined&&typeof value.expectedContext.entityId!=='string'))) return false;
  if (value.status==='succeeded' && (!validReceipt(value.receipt)||!value.expectedContext||value.receipt.operationId!==id)) return false;
  if (value.status==='failed'&&value.failureCode!==undefined&&value.failureCode!=='in_use') return false;
  return true;
}
function upstreamOperation(path) {
  if (path === '/auth/agent/pending-token') return 'mint';
  if (path === '/pending-operations/v2/propose') return 'propose';
  if (path === '/internal/agent/empty-attestations') return 'deposit';
  if (path === '/pending-operations/undo') return 'undo';
  const action = path.match(/\/pending-operations\/v2\/(?:[^/]+\/)?(confirm|execute|cancel|retry|outcome|supersede)$/)?.[1];
  if (action) return action;
  if (/\/pending-operations\/v2\/(?:[^/]+|active)$/.test(path)) return 'get';
  return 'request';
}
export class PendingClientError extends Error { constructor(code='pending.upstream_error', effectMayHaveOccurred=true){ super('pending operation request failed'); this.name='PendingClientError'; this.code=code; this.effectMayHaveOccurred=effectMayHaveOccurred; } }
export function createPendingClient({ apiBaseUrl, allowedOrigins=[], pendingMintToken, workspaceDeletionServiceToken, fetchImpl=fetch, timeoutMs=15000 }={}) {
  let origin;
  try { const u=new URL(apiBaseUrl); const host=u.hostname.replace(/^\[|\]$/g,''); if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash||(!LOOPBACK.has(host)&&!allowedOrigins.includes(u.origin))) throw 0; origin=u.origin; } catch { throw new PendingClientError('pending.unavailable'); }
  async function request(path,{method='POST',body,token,identity,key,signal,serviceToken}={}) {
    if(serviceToken !== undefined && (typeof serviceToken !== 'string' || serviceToken.length < 32)) throw new PendingClientError(path.startsWith('/internal/') ? 'agent.attestation_unavailable' : 'pending.unavailable');
    const headers={accept:'application/json','content-type':'application/json'};
    if(serviceToken !== undefined) headers[path.startsWith('/internal/agent/') ? 'x-agent-service-token' : 'x-agent-pending-service-token']=serviceToken;
    else { headers.authorization=`Bearer ${token}`; headers['x-workspace-id']=identity.workspaceId; headers['x-actor-id']=identity.actorId; headers['x-device-id']=identity.deviceId; }
    if(key) headers['Idempotency-Key']=key;
    const ctrl=new AbortController(), timer=setTimeout(()=>ctrl.abort(),timeoutMs), joined=signal?AbortSignal.any([ctrl.signal,signal]):ctrl.signal;
    try { const r=await fetchImpl(origin+path,{method,headers,...(method==='GET'?{}:{body:JSON.stringify(body??{})}),redirect:'manual',signal:joined}); if(r.status>=300&&r.status<400) throw new PendingClientError(); const data=await r.json().catch(()=>null); if(!r.ok) { const code=r.status>=500?`pending.upstream_5xx_${upstreamOperation(path)}`:[400,401,403,404,409,429].includes(r.status)?`pending.upstream_${r.status}_${upstreamOperation(path)}`:'pending.upstream_error'; throw new PendingClientError(code,method!=='GET'&&r.status<500); } if(!data||typeof data!=='object') throw new PendingClientError(); return data; }
    catch(e){ if(e instanceof PendingClientError) throw e; throw new PendingClientError(signal?.aborted?'pending.cancelled':'pending.upstream_error'); } finally{clearTimeout(timer);}
  }
  const scoped=x=>({workspaceId:x.workspaceId,actorId:x.actorId,deviceId:x.deviceId});
  const auth=x=>({token:x.token,identity:scoped(x),signal:x.signal});
  return {
    mintToken: async x=>{ if(typeof pendingMintToken!=='string'||pendingMintToken.length<32) throw new PendingClientError('pending.unavailable'); const d=await request('/auth/agent/pending-token',{body:{workspaceId:x.workspaceId,actorId:x.actorId,deviceId:x.deviceId,requestId:x.requestId},serviceToken:pendingMintToken,signal:x.signal}); if(typeof d.token!=='string'||!d.token||typeof d.expiresAt!=='string'||!Number.isFinite(Date.parse(d.expiresAt))) throw new PendingClientError(); return d.token; },
    propose: async x=>{const d=await request('/pending-operations/v2/propose',{...auth(x),key:x.idempotencyKey,body:{tool:x.tool,normalizedArgs:x.normalizedArgs}}); if(typeof d.id!=='string'||typeof d.existing!=='boolean') throw new PendingClientError(); return d;},
    get: async x=>{const d=await request(`/pending-operations/v2/${encodeURIComponent(x.id)}`,{...auth(x),method:'GET'}); if(!d||d.id!==x.id||typeof d.tool!=='string'||!d.tool||typeof d.status!=='string'||!d.status||!d.normalizedArgs||typeof d.normalizedArgs!=='object'||Array.isArray(d.normalizedArgs)||Object.keys(d).some(k=>!['id','tool','status','normalizedArgs','proposalHash','expectedContext','createdAt','updatedAt','expiresAt'].includes(k))||typeof d.proposalHash!=='string'||! /^[0-9a-f]{64}$/.test(d.proposalHash)) throw new PendingClientError(); return {id:d.id,tool:d.tool,status:d.status,normalizedArgs:d.normalizedArgs,proposalHash:d.proposalHash};},
    supersede: async x=>{if(typeof x.id!=='string'||!x.id||typeof x.tool!=='string'||!x.tool||!x.normalizedArgs||typeof x.normalizedArgs!=='object'||Array.isArray(x.normalizedArgs)||typeof x.expectedProposalHash!=='string'||! /^[0-9a-f]{64}$/.test(x.expectedProposalHash)||typeof x.idempotencyKey!=='string'||!x.idempotencyKey) throw new PendingClientError('pending.invalid_args',false); const d=await request(`/pending-operations/v2/${encodeURIComponent(x.id)}/supersede`,{...auth(x),key:x.idempotencyKey,body:{tool:x.tool,normalizedArgs:x.normalizedArgs,expectedProposalHash:x.expectedProposalHash}}); if(!d||typeof d.id!=='string'||!d.id||typeof d.existing!=='boolean'||d.supersedes!==x.id||Object.keys(d).some(k=>!['id','existing','supersedes'].includes(k))) throw new PendingClientError(); return {id:d.id,existing:d.existing,supersedes:d.supersedes};},
    active: async x=>{const d=await request('/pending-operations/v2/active',{...auth(x),method:'GET'}); if(!Array.isArray(d.items)||!Number.isInteger(d.total)||d.total<0) throw new PendingClientError(); return d;},
    confirm: async x=>{const d=await request(`/pending-operations/v2/${encodeURIComponent(x.id)}/confirm`,{...auth(x),body:{intentionId:x.intentionId}}); if(d.id!==x.id||d.status!=='confirmed'||typeof d.attestation!=='string'||d.attestation.length<32) throw new PendingClientError(); return {id:d.id,status:d.status,attestation:d.attestation};},
    authorize: async x=>request(`/pending-operations/v2/${encodeURIComponent(x.id)}/authorize`,{...auth(x),body:{}}),
    execute: async x=>{const d=await request(`/pending-operations/v2/${encodeURIComponent(x.id)}/execute`,{...auth(x),body:{attestation:x.attestation,intentionId:x.intentionId}}); if(d.id!==x.id||!['succeeded','failed','executing','confirmed'].includes(d.status)) throw new PendingClientError(); return d;},
    retry: async x=>{const d=await request(`/pending-operations/v2/${encodeURIComponent(x.id)}/retry`,{...auth(x),body:{intentionId:x.intentionId}}); if(d.id!==x.id||typeof d.attestation!=='string'||d.attestation.length<32) throw new PendingClientError(); return {id:d.id,status:d.status,attestation:d.attestation};},
    cancel: async x=>{const d=await request(`/pending-operations/v2/${encodeURIComponent(x.id)}/cancel`,{...auth(x),body:{}}); if(d.id!==x.id||d.status!=='cancelled') throw new PendingClientError(); return d;},
    outcome: async x=>{const d=await request(`/pending-operations/v2/${encodeURIComponent(x.id)}/outcome`,{...auth(x),method:'GET'}); if(!validOutcome(d,x.id)) throw new PendingClientError(); return d;},
    undo: async x=>{const d=await request('/pending-operations/undo',{...auth(x),key:x.idempotencyKey,body:{lastOperationId:x.lastOperationId}}); if(!d||typeof d!=='object') throw new PendingClientError(); return d;},
    depositEmptyAttestation: async x=>{ if(typeof workspaceDeletionServiceToken!=='string'||workspaceDeletionServiceToken.length<32) throw new PendingClientError('agent.attestation_unavailable'); const d=await request('/internal/agent/empty-attestations',{body:{actorId:x.actorId,proof:x.proof},serviceToken:workspaceDeletionServiceToken,signal:x.signal}); if(typeof d.attestationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.attestationId)) throw new PendingClientError('agent.attestation_unavailable'); return {attestationId:d.attestationId}; },
  };
}
export const proposeIdempotencyKey=({workspaceId,intentionId,tool})=>createHash('sha256').update(`${workspaceId}:${intentionId}:${tool}`).digest('hex');
