import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { createConversationStore } from '../src/conversations.mjs';
import { createPendingClient } from '../src/pending-client.mjs';
import { createGatewayServer } from '../src/server.mjs';
import { createUndoStore } from '../src/undo-store.mjs';
import { agentEmptyProofCanonical } from '../src/workspace-attestation.mjs';
import { approvedTmpRoot } from './helpers/tmp-root.mjs';

const workspaceId = 'H_A', actorId = 'actor-A', deviceId = 'dev-A';
const identity = { workspace: workspaceId, actorId, deviceId };
const opId = '123e4567-e89b-42d3-a456-426614174000';

it('routes Pending V2, undo, and empty-attestation through loopback stubs with safe DTOs', async (t) => {
  const receipt={mutationId:'mut-1',mutationKind:'categories.create',status:'succeeded',affectedTargets:['categories'],operationId:opId};
  let outcome = { operationId: opId, tool: 'categories.create', status: 'succeeded', receipt, expectedContext:{tool:'categories.create'} };
  const apiCalls = [];
  let confirmHttpStatus = 200;
  let unreadableOutcome = false;
  const api = http.createServer(async (req, res) => {
    const chunks=[]; for await (const c of req) chunks.push(c);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    apiCalls.push({path:req.url,headers:req.headers,body});
    const data = req.url === '/auth/agent/pending-token' ? { token: 'delegated-secret-never-return', expiresAt:new Date(Date.now()+60000).toISOString() }
      : req.url === '/pending-operations/v2/propose' ? { id: opId, existing: false }
      : req.url === '/pending-operations/v2/active' ? { items: [{ id: opId, status:'proposed', tool:'categories.create', createdAt:'now', expiresAt:'later', payableId:'drop', extra:'drop', presentation: { title: 'API' } }, { id:'bad', tool:'missing-status' }], total: 2 }
      : req.url.endsWith('/confirm') ? { id: opId, status: 'confirmed', attestation: 'x'.repeat(40) }
      : req.url.endsWith('/retry') ? { id: opId, status: 'confirmed', attestation: 'y'.repeat(40) }
      : req.url.endsWith('/cancel') ? { id: opId, status: 'cancelled' }
      : req.url.endsWith('/outcome') ? (unreadableOutcome ? { broken:true } : outcome)
      : req.url === '/pending-operations/undo' ? { undone: true, receipt: { id: 'undo-receipt' } }
      : req.url === '/internal/agent/empty-attestations' ? { attestationId: opId } : {};
    res.writeHead(req.url === '/internal/agent/empty-attestations' ? 201 : req.url.endsWith('/confirm') ? confirmHttpStatus : 200, {'content-type':'application/json'});
    res.end(JSON.stringify(data));
  });
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>api.close(resolve)));
  const addr=api.address();
  const client=createPendingClient({apiBaseUrl:`http://127.0.0.1:${addr.port}`,pendingMintToken:'m'.repeat(40),workspaceDeletionServiceToken:'d'.repeat(40)});
  assert.equal(Object.hasOwn(client,'workspaceDeletionSecret'),false);
  const conversations=createConversationStore({persistDir:approvedTmpRoot('pending-routes-conv')});
  const undo=createUndoStore({persistDir:approvedTmpRoot('pending-routes-undo')});
  let currentIdentity=identity;
  const gw=createGatewayServer({resolveIdentity:async()=>currentIdentity,store:conversations,promptHost:{chat:async()=>({})},createRuntimeSession:async()=>({runtimeSessionId:'unused'}),pendingClient:client,undoStore:undo,
    workspaceDeletionSecret:'h'.repeat(40),categoryMemoryStoreOverride:{countByWorkspace:()=>0,close:()=>{}}});
  t.after(()=>gw.close());
  const listen=await gw.listen();
  const base=`http://127.0.0.1:${listen.port}/agents/finance-chat-agent/${workspaceId}/rpc`;
  const publicBodies=[];
  const call=async (path,method='GET',body)=>{const response=await fetch(`${base}/${path}`,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});publicBodies.push(await response.clone().text());return response;};

  const proposal={tool:'categories.create',intentionId:'intent-1',normalizedArgs:{name:'Food',kind:'expense'}};
  const badProposal=await call('pending-operations/propose','POST',{...proposal,summary:'display only'});
  assert.equal(badProposal.status,400);
  assert.equal(apiCalls.some(c=>c.path==='/pending-operations/v2/propose'),false);
  const proposed=await call('pending-operations/propose','POST',proposal);
  assert.deepEqual(await proposed.json(),{id:opId,existing:false});
  const key=apiCalls.find(c=>c.path==='/pending-operations/v2/propose').headers['idempotency-key'];
  assert.equal(key,createHash('sha256').update(`${workspaceId}:intent-1:categories.create`).digest('hex'));
  assert.deepEqual((await (await call('pending-operations/active')).json()),{items:[{id:opId,status:'proposed',tool:'categories.create',createdAt:'now',expiresAt:'later',presentation:{title:'API'}}],total:1});
  const tooLongDecision=await call(`pending-operations/${opId}/decision`,'POST',{decision:'confirm',requestId:'r'.repeat(241)});
  assert.equal(tooLongDecision.status,400);
  const malformedOperation=await call('pending-operations/%E0%A4%A/decision','POST',{decision:'confirm',requestId:'id'});
  assert.equal(malformedOperation.status,400);
  const malformedWorkspace=await fetch(`http://127.0.0.1:${listen.port}/agents/finance-chat-agent/%E0%A4%A/rpc/pending-operations/active`);
  assert.equal(malformedWorkspace.status,400);
  const confirm=await call(`pending-operations/${opId}/decision`,'POST',{decision:'confirm',requestId:'intent-1'});
  assert.equal(confirm.status,200); assert.deepEqual(await confirm.json(),{operationId:opId,status:'succeeded',receipt});
  confirmHttpStatus=409;
  const replay=await call(`pending-operations/${opId}/decision`,'POST',{decision:'confirm',requestId:'intent-replay'});
  assert.equal(replay.status,200); assert.deepEqual(await replay.json(),{operationId:opId,status:'succeeded',receipt});
  outcome={operationId:opId,tool:'categories.create',status:'expired',expectedContext:{tool:'categories.create'}};
  const expired=await call(`pending-operations/${opId}/decision`,'POST',{decision:'confirm',requestId:'intent-expired'});
  assert.deepEqual(await expired.json(),{operationId:opId,status:'expired'});
  unreadableOutcome=true;
  const unreadable=await call(`pending-operations/${opId}/decision`,'POST',{decision:'confirm',requestId:'intent-unreadable'});
  assert.equal(unreadable.status,502); assert.equal((await unreadable.json()).code,'agent.execution_outcome_unknown');
  unreadableOutcome=false;
  confirmHttpStatus=200;
  outcome={operationId:opId,tool:'categories.create',status:'succeeded'};
  const noReceipt=await call(`pending-operations/${opId}/decision`,'POST',{decision:'confirm',requestId:'intent-2'});
  assert.equal(noReceipt.status,502); assert.equal((await noReceipt.json()).code,'agent.execution_outcome_unknown');
  outcome={operationId:opId,tool:'categories.create',status:'executing'};
  const uncertain=await call(`pending-operations/${opId}/decision`,'POST',{decision:'retry',requestId:'intent-3'});
  assert.equal(uncertain.status,502); assert.equal((await uncertain.json()).code,'agent.execution_outcome_unknown');
  outcome={operationId:opId,tool:'categories.create',status:'failed',failureCode:'in_use',expectedContext:{tool:'categories.create'}};
  const failed=await call(`pending-operations/${opId}/decision`,'POST',{decision:'retry',requestId:'intent-5'});
  assert.deepEqual(await failed.json(),{operationId:opId,status:'failed',failureCode:'in_use'});
  const cancelled=await call(`pending-operations/${opId}/decision`,'POST',{decision:'cancel',requestId:'intent-4'});
  assert.deepEqual(await cancelled.json(),{operationId:opId,status:'cancelled'});
  const attested=await call(`workspace/${workspaceId}/attest-empty`,'POST',{inventoryVersion:'a'.repeat(64)});
  assert.deepEqual(await attested.json(),{attestationId:opId});
  const deposit=apiCalls.find(c=>c.path==='/internal/agent/empty-attestations');
  assert.equal(deposit.headers['x-agent-service-token'],'d'.repeat(40));
  assert.equal(deposit.body.proof.hmac,createHmac('sha256','h'.repeat(40)).update(agentEmptyProofCanonical(workspaceId,'a'.repeat(64),{sessions:0,messages:0,memories:0,attachments:0},deposit.body.proof.expiresAt)).digest('hex'));
  undo.create({requestId:'undo-request',workspaceId,actorId,deviceId,targetLastOperationId:opId});
  undo.create({requestId:'cancel-request',workspaceId,actorId,deviceId,targetLastOperationId:opId});
  undo.create({requestId:'undo-executing-expired',workspaceId,actorId,deviceId,targetLastOperationId:opId});
  undo.transition('undo-executing-expired',{workspaceId,actorId,deviceId},'proposed','executing');
  undo.update('undo-executing-expired',{workspaceId,actorId,deviceId},{expiresAt:new Date(Date.now()-1000).toISOString()});
  const firstUndoProposal=undo.proposeForConversation({requestId:'undo-auto-1',workspaceId,actorId,deviceId,conversationId:'conv-1'});
  const reusedUndoProposal=undo.proposeForConversation({requestId:'undo-auto-2',workspaceId,actorId,deviceId,conversationId:'conv-1'});
  assert.equal(firstUndoProposal.requestId,'undo-auto-1');
  assert.equal(reusedUndoProposal.requestId,'undo-auto-1');
  assert.equal(Object.hasOwn(firstUndoProposal,'targetLastOperationId'),false);
  assert.deepEqual((await (await call('undo/active')).json()).total,3);
  const undone=await call('undo/decision','POST',{decision:'confirm',requestId:'undo-request'});
  assert.equal((await undone.json()).status,'confirmed');
  const undoReplay=await call('undo/decision','POST',{decision:'confirm',requestId:'undo-request'});
  assert.equal((await undoReplay.json()).status,'confirmed');
  const electedUndo=await call('undo/decision','POST',{decision:'confirm',requestId:'undo-auto-1'});
  assert.equal((await electedUndo.json()).status,'confirmed');
  const undoApiCall=apiCalls.find(c=>c.path==='/pending-operations/undo'&&!Object.hasOwn(c.body,'lastOperationId'));
  assert.ok(undoApiCall, 'API elects the actor’s latest reversible operation when target omitted');
  const undoCancel=await call('undo/decision','POST',{decision:'cancel',requestId:'cancel-request'});
  assert.equal((await undoCancel.json()).status,'cancelled');
  assert.deepEqual((await (await call('undo/active')).json()).total,0);
  const cancelReplay=await call('undo/decision','POST',{decision:'confirm',requestId:'cancel-request'});
  assert.equal(cancelReplay.status,409);
  const missing=await call('undo/decision','POST',{decision:'confirm',requestId:'missing'});
  assert.equal(missing.status,404);
  const tooLongUndo=await call('undo/decision','POST',{decision:'confirm',requestId:'u'.repeat(241)});
  assert.equal(tooLongUndo.status,400);
  const expiredExecuting=await call('undo/decision','POST',{decision:'confirm',requestId:'undo-executing-expired'});
  assert.equal(expiredExecuting.status,409);
  assert.equal((await expiredExecuting.json()).code,'undo.executing');
  assert.equal(undo.get('undo-executing-expired',{workspaceId,actorId,deviceId}).status,'executing');
  currentIdentity={...identity,actorId:'other-actor'};
  const foreign=await call('undo/decision','POST',{decision:'confirm',requestId:'undo-request'});
  assert.equal(foreign.status,403);
  currentIdentity=identity;
  const undoNonEmpty=await call(`workspace/${workspaceId}/attest-empty`,'POST',{inventoryVersion:'a'.repeat(64)});
  assert.equal(undoNonEmpty.status,409); assert.equal((await undoNonEmpty.json()).code,'agent.workspace_not_empty');
  conversations.create({workspace:workspaceId,ownerActor:actorId,deviceId});
  const nonEmpty=await call(`workspace/${workspaceId}/attest-empty`,'POST',{inventoryVersion:'a'.repeat(64)});
  assert.equal(nonEmpty.status,409);
  assert.equal((await nonEmpty.json()).code,'agent.workspace_not_empty');
  assert.equal(apiCalls.find(c=>c.path==='/auth/agent/pending-token').headers['x-agent-pending-service-token'],'m'.repeat(40));
  assert.ok(!publicBodies.join('\n').includes('delegated-secret-never-return'));
  assert.throws(()=>undo.get('undo-request',{workspaceId,actorId:'other',deviceId}),e=>e.code==='auth.workspace_forbidden');
  assert.throws(()=>undo.get('undo-request',{workspaceId:'other',actorId,deviceId}),e=>e.code==='auth.workspace_forbidden');
  assert.throws(()=>undo.get('undo-request',{workspaceId,actorId,deviceId:'other'}),e=>e.code==='auth.workspace_forbidden');
});

it('service secrets are independent and missing credentials fail before fetch', async () => {
  let calls=0;
  const client=createPendingClient({apiBaseUrl:'http://127.0.0.1:3001',fetchImpl:async()=>{calls++;return new Response('{}');}});
  await assert.rejects(client.mintToken({workspaceId,actorId,deviceId,requestId:'r'}),e=>e.code==='pending.unavailable');
  await assert.rejects(client.depositEmptyAttestation({actorId,proof:{}}),e=>e.code==='agent.attestation_unavailable');
  const mintOnly=createPendingClient({apiBaseUrl:'http://127.0.0.1:3001',pendingMintToken:'m'.repeat(40),fetchImpl:async()=>{calls++;return new Response('{}');}});
  await assert.rejects(mintOnly.depositEmptyAttestation({actorId,proof:{}}),e=>e.code==='agent.attestation_unavailable');
  const deletionOnly=createPendingClient({apiBaseUrl:'http://127.0.0.1:3001',workspaceDeletionServiceToken:'d'.repeat(40),fetchImpl:async()=>{calls++;return new Response('{}');}});
  await assert.rejects(deletionOnly.mintToken({workspaceId,actorId,deviceId,requestId:'r'}),e=>e.code==='pending.unavailable');
  assert.equal(calls,0);
});

it('maps Pending upstream HTTP statuses without exposing response details', async () => {
  let status = 400;
  const client = createPendingClient({
    apiBaseUrl: 'http://127.0.0.1:3001',
    fetchImpl: async () => new Response(JSON.stringify({ secret: 'must-not-leak' }), {
      status, headers: { 'x-private': 'must-not-leak' },
    }),
  });
  for (const [httpStatus, code] of [[400,'pending.upstream_400_propose'],[403,'pending.upstream_403_propose'],[404,'pending.upstream_404_propose'],[409,'pending.upstream_409_propose'],[500,'pending.upstream_5xx_propose'],[503,'pending.upstream_5xx_propose']]) {
    status = httpStatus;
    await assert.rejects(client.propose({ ...identity, token:'t', tool:'categories.create', normalizedArgs:{} }), error => {
      assert.equal(error.code, code);
      assert.equal(error.message, 'pending operation request failed');
      assert.equal(error.effectMayHaveOccurred, httpStatus < 500);
      assert.equal(JSON.stringify(error).includes('must-not-leak'), false);
      return true;
    });
  }
  status = 401;
  await assert.rejects(client.get({ ...identity, token:'t', id:opId }), error =>
    error.code === 'pending.upstream_401_get' && error.effectMayHaveOccurred === false);
  status = 429;
  await assert.rejects(client.get({ ...identity, token:'t', id:opId }), error =>
    error.code === 'pending.upstream_429_get' && error.effectMayHaveOccurred === false);
});
