import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { createInMemoryReadModelStoreFromState } from '../../src/read-models/store.js';
import { requireApprovalToolContract } from '../../src/approvals/tool-registry.js';
import { isActionablePendingOperationPresentation } from '@pi-finance/llm-contracts';

const KEY_CAPABILITIES = ['financial.approval.propose','financial.approval.read','financial.approval.confirm','financial.approval.execute','financial.approval.retry','financial.approval.cancel','financial.approval.reconcile'];

const setup = async () => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = { iss:'pi-agent', aud:'pi-finance-api', sub:'actor', workspace:'ws', role:'owner', capabilities:KEY_CAPABILITIES, jti:randomUUID(), request:'r', deviceId:'dev', iat:1, exp:9999999999 };
    request.authenticatedContext = { householdId:'ws', actorId:'actor', authUserId:'actor', actorType:'user', deviceId:'dev', role:'owner' };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  const { state, writes } = createInMemoryStores();
  const account = await writes.createAccount('ws', { name:'Banco', kind:'bank', initialBalanceCents:0 });
  const suffix = randomUUID();
  const category = await writes.createCategory('ws', { name:`Compras ${suffix}`, kind:'expense' });
  const transaction = await writes.createExpense('ws', { description:'Mercado', amountCents:1200, date:'2026-10-20', accountId:account.id, categoryId:category.id });
  registerPendingOperationRoutes(app, {
    resolveToken: async () => ({ householdId:'ws', deviceId:'dev' }), v2Store, v2Only:true,
    v2Executor: async (operation) => requireApprovalToolContract(operation.tool).executor({ writes, workspaceId:operation.workspaceId, args:operation.normalizedArgs, idempotencyKey:operation.idempotencyKey, actorId:operation.actorId }),
    readModel: createInMemoryReadModelStoreFromState(state),
  });
  return { app, writes, state, transaction };
};

const propose = (app: FastifyInstance, key: string, normalizedArgs: unknown) => app.inject({
  method:'POST', url:'/pending-operations/v2/propose', headers:{'idempotency-key':key},
  payload:{ tool:'transactions.update', normalizedArgs },
});

describe('transactions.update proposal target gate', () => {
  it('requires an active same-workspace target with the exact current description; replay precedes the mutable read', async () => {
    const h = await setup();
    const key = randomUUID();
    const args = { transactionId:h.transaction.id, description:'Mercado semanal', expectedDescription:'Mercado' };
    const first = await propose(h.app, key, args);
    expect(first.statusCode).toBe(201);
    const active = await h.app.inject({ method:'GET', url:'/pending-operations/v2/active' });
    const item = (active.json().items as Array<{tool:string;presentation?:{title?:string;description?:string;expectedDescription?:string;transactionTargetId?:string;transactionAmountCents?:number;transactionDate?:string;transactionAccount?:{id:string;label:string}}}>).find((row)=>row.tool==='transactions.update');
    expect(item?.presentation).toMatchObject({ title:'Alterar descrição do lançamento', description:'Mercado semanal', expectedDescription:'Mercado', transactionTargetId:h.transaction.id, transactionAmountCents:1200, transactionDate:'2026-10-20', transactionAccount:{id:h.transaction.accountId,label:'Banco'} });
    expect(isActionablePendingOperationPresentation(item!.presentation as never)).toBe(true);
    const operationId=first.json().id as string;
    const confirmed=await h.app.inject({method:'POST',url:`/pending-operations/v2/${operationId}/confirm`,payload:{}});
    expect(confirmed.statusCode).toBe(200);
    const executed=await h.app.inject({method:'POST',url:`/pending-operations/v2/${operationId}/execute`,payload:{attestation:confirmed.json().attestation}});
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({status:'succeeded',execution:{status:'succeeded',operationId:h.transaction.id,receipt:{mutationKind:'transactions.update',operationId,entity:{type:'transaction',id:h.transaction.id}}}});
    const outcome=await h.app.inject({method:'GET',url:`/pending-operations/v2/${operationId}/outcome`});
    expect(outcome.json()).toMatchObject({status:'succeeded',expectedContext:{tool:'transactions.update',entityId:h.transaction.id}});
    const replay = await propose(h.app, key, args);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().existing).toBe(true);
    const stale = await propose(h.app, randomUUID(), args);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('transaction.description_conflict');
  });

  it('preserves current description whitespace byte-for-byte through validation, proposal hash replay, and execution',async()=>{
    const h=await setup();
    const target=h.state.transactions.find((row)=>row.id===h.transaction.id)!;
    target.description='  Mercado  ';
    const key=randomUUID();
    const args={transactionId:target.id,description:'  Feira  ',expectedDescription:'  Mercado  '};
    const first=await propose(h.app,key,args);
    expect(first.statusCode).toBe(201);
    expect(first.json().normalizedArgs).toMatchObject({expectedDescription:'  Mercado  ',description:'Feira'});
    const replay=await propose(h.app,key,args);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().existing).toBe(true);
    const normalizedReplay=await propose(h.app,key,{...args,expectedDescription:'Mercado'});
    expect(normalizedReplay.statusCode).toBe(409);
    expect(normalizedReplay.json().code).toBe('idempotency.conflict');
    const id=first.json().id as string;
    const confirmation=await h.app.inject({method:'POST',url:`/pending-operations/v2/${id}/confirm`,payload:{}});
    const executed=await h.app.inject({method:'POST',url:`/pending-operations/v2/${id}/execute`,payload:{attestation:confirmation.json().attestation}});
    expect(executed.statusCode).toBe(200);
    expect(h.state.transactions.find((row)=>row.id===target.id)?.description).toBe('Feira');
  });

  it('rejects another workspace target and does not accept generic financial patch fields', async () => {
    const h = await setup();
    const foreignAccount = await h.writes.createAccount('other', { name:`Outro ${randomUUID()}`, kind:'bank', initialBalanceCents:0 });
    const foreignCategory = await h.writes.createCategory('other', { name:`Outra ${randomUUID()}`, kind:'expense' });
    const foreign = await h.writes.createExpense('other', { description:'Mercado', amountCents:1200, date:'2026-10-20', accountId:foreignAccount.id, categoryId:foreignCategory.id });
    const foreignResponse = await propose(h.app, randomUUID(), { transactionId:foreign.id, description:'Novo', expectedDescription:'Mercado' });
    expect(foreignResponse.statusCode).toBe(404);
    const widened = await propose(h.app, randomUUID(), { transactionId:h.transaction.id, description:'Novo', expectedDescription:'Mercado', amountCents:1 });
    expect(widened.statusCode).toBe(422);
  });

  it('rejects a transfer before creating a manual proposal', async()=>{
    const h=await setup();
    const destination=await h.writes.createAccount('ws',{name:`Destino ${randomUUID()}`,kind:'bank',initialBalanceCents:0});
    const transfer=await h.writes.createTransfer('ws',{amountCents:100,date:'2026-10-20',description:'Transferência',fromAccountId:h.transaction.accountId,toAccountId:destination.id});
    const response=await propose(h.app,randomUUID(),{transactionId:transfer.id,description:'Novo texto',expectedDescription:'Transferência'});
    expect(response.statusCode).toBe(422);
  });

  it('drops stale target context from the active card instead of leaving Confirm actionable',async()=>{
    const h=await setup();
    const args={transactionId:h.transaction.id,description:'Feira',expectedDescription:'Mercado'};
    const proposed=await propose(h.app,randomUUID(),args);
    await h.writes.editTransactionDescription('ws',{...args,description:'Mercado alterado'},{idempotencyKey:randomUUID(),actorId:'actor'});
    const active=await h.app.inject({method:'GET',url:'/pending-operations/v2/active'});
    const item=(active.json().items as Array<{tool:string;presentation?:unknown}>).find((row)=>row.tool==='transactions.update');
    expect(item?.presentation).toBeDefined();
    expect(isActionablePendingOperationPresentation(item!.presentation as never)).toBe(false);
    expect(proposed.statusCode).toBe(201);
  });
});
