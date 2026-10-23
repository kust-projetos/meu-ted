import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { ConversationOrchestrator, normalizeRestTurn, type AuthenticatedIdentity } from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { initializeMutationDraftSchema, SqlMutationDraftStore } from '../src/mutations/mutation-draft.js';

const identity: AuthenticatedIdentity = { actorId:'actor-desc', workspaceId:'ws-desc', role:'member', deviceId:'device-desc' };
const tx = { id:'11111111-1111-4111-8111-111111111111', scopeId:identity.workspaceId, description:'Mercado', amountCents:1200, date:'2026-10-20', accountId:'22222222-2222-4222-8222-222222222222', kind:'expense' as const };

const setup = (transactions = [tx], failFirstProposal = false) => {
  const db = new DatabaseSync(':memory:');
  const sql = { exec<T>(query:string,...bindings:unknown[]):Iterable<T> { const stmt=db.prepare(query); if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query)||/\bRETURNING\b/i.test(query)) return stmt.all(...bindings as never[]) as T[]; stmt.run(...bindings as never[]); return [] as T[]; }, transactionSync:<T>(fn:()=>T)=>fn() };
  initializeMutationDraftSchema(sql as never);
  const requests: Array<{method:string;path:string;body?:unknown;idempotencyKey?:string}> = [];
  let proposalAttempts=0;
  const api = new MutationApiClient({request:vi.fn(async(method:string,path:string,options:never)=>{
    const opts=options as unknown as {body?:unknown;idempotencyKey?:string}; requests.push({method,path,body:opts.body,idempotencyKey:opts.idempotencyKey});
    if (method==='POST'&&path==='/pending-operations/v2/propose') { proposalAttempts+=1; if(failFirstProposal&&proposalAttempts===1)throw new Error('simulated lost proposal response'); return {id:'proposal-1',existing:proposalAttempts>1,summary:'description update',operation:{id:'proposal-1',expiresAt:'2026-10-23T00:00:00.000Z'}}; }
    if (method==='GET'&&path==='/pending-operations/v2/active') return {items:[],total:0};
    throw new Error(`unexpected ${method} ${path}`);
  }) as never});
  const store = new SqlMutationDraftStore(sql as never);
  const orchestrator = new ConversationOrchestrator({ mutationApiClient:api, entityReader:{listAccounts:async()=>[],listCategories:async()=>[],listTransactions:async()=>transactions}, draftStore:store, draftNow:()=>Date.parse('2026-10-23T00:00:00Z'), responseProvider:vi.fn(async()=>{throw new Error('model must not decide this flow')}), evidenceProvider:vi.fn(async()=>({version:'1',items:[]}) as never), events:()=>undefined });
  return {orchestrator,requests,store};
};

describe('transactions.update real Agent orchestration path',()=>{
  it('preserves the cancellation-looking text as a literal new description',async()=>{
    const h=setup();
    const result=await h.orchestrator.runTurn(normalizeRestTurn({text:'altere a descrição do lançamento Mercado para Cancele o rascunho',intentionId:'desc-cancel-literal'},identity));
    expect(result.mutation?.status).toBe('proposed');
    expect(h.requests.find((r)=>r.path==='/pending-operations/v2/propose')?.body).toMatchObject({tool:'transactions.update',normalizedArgs:{transactionId:tx.id,description:'Cancele o rascunho',expectedDescription:'Mercado'}});
  });
  it('resolves an exact authorized transaction and proposes only description fields manually',async()=>{
    const h=setup();
    const result=await h.orchestrator.runTurn(normalizeRestTurn({text:'altere a descrição do lançamento Mercado para Feira semanal',intentionId:'desc-intent-1'},identity));
    expect(result.mutation).toMatchObject({operationId:'proposal-1',status:'proposed'});
    const call=h.requests.find((r)=>r.path==='/pending-operations/v2/propose');
    expect(call?.body).toMatchObject({tool:'transactions.update',normalizedArgs:{transactionId:tx.id,description:'Feira semanal',expectedDescription:'Mercado'}});
    expect((call?.body as {normalizedArgs:Record<string,unknown>}).normalizedArgs).not.toHaveProperty('amountCents');
    expect(result.policy?.authorizationMode).toBe('manual');
  });

  it('does not choose a duplicate exact description or use a malformed transaction read as empty',async()=>{
    const h=setup();
    h.orchestrator = new ConversationOrchestrator({ mutationApiClient:new MutationApiClient({request:vi.fn(async()=>({items:[],total:2})) as never}), entityReader:{listAccounts:async()=>[],listCategories:async()=>[],listTransactions:async()=>[tx,{...tx,id:'33333333-3333-4333-8333-333333333333'}]}, draftStore:h.store, draftNow:()=>Date.parse('2026-10-23T00:00:00Z'), responseProvider:vi.fn(async()=>{throw new Error('not used')}), evidenceProvider:vi.fn(async()=>({version:'1',items:[]}) as never),events:()=>undefined });
    const ambiguous=await h.orchestrator.runTurn(normalizeRestTurn({text:'altere a descrição do lançamento Mercado para Feira',intentionId:'desc-intent-2'},identity));
    expect(ambiguous.mutation).toBeUndefined();
    expect(h.requests.some((r)=>r.path==='/pending-operations/v2/propose')).toBe(false);
  });

  it('persists a missing description slot and fills only that slot on follow-up',async()=>{
    const h=setup();
    const first=await h.orchestrator.runTurn(normalizeRestTurn({text:'altere a descrição do lançamento Mercado',intentionId:'desc-slot-1'},identity));
    expect(first.mutation).toBeUndefined();
    expect(first.clarification?.missingFields).toContain('description');
    const second=await h.orchestrator.runTurn(normalizeRestTurn({text:'para Cancelada',intentionId:'desc-slot-2'},identity));
    expect(second.mutation).toMatchObject({operationId:'proposal-1',status:'proposed'});
    expect(h.requests.find((r)=>r.path==='/pending-operations/v2/propose')?.body).toMatchObject({tool:'transactions.update',normalizedArgs:{transactionId:tx.id,description:'Cancelada',expectedDescription:'Mercado'}});
  });

  it('persists an ambiguous target and binds a follow-up choice to one authoritative row',async()=>{
    const second={...tx,id:'33333333-3333-4333-8333-333333333333',amountCents:1500};
    const h=setup([tx,second]);
    const first=await h.orchestrator.runTurn(normalizeRestTurn({text:'altere a descrição do lançamento Mercado para Feira',intentionId:'desc-choice-1'},identity));
    expect(first.mutation).toBeUndefined();
    expect(first.response?.text).toMatch(/R\$ 12,00.*R\$ 15,00/);
    const secondTurn=await h.orchestrator.runTurn(normalizeRestTurn({text:'R$ 15,00 em 20/10/2026',intentionId:'desc-choice-2'},identity));
    expect(secondTurn.mutation).toMatchObject({operationId:'proposal-1',status:'proposed'});
    expect(h.requests.find((r)=>r.path==='/pending-operations/v2/propose')?.body).toMatchObject({tool:'transactions.update',normalizedArgs:{transactionId:second.id,description:'Feira',expectedDescription:'Mercado'}});
  });

  it('replays an unknown proposal with the same persisted key and args before any mutable target read',async()=>{
    const h=setup([tx],true);
    const turn=normalizeRestTurn({text:'altere a descrição do lançamento Mercado para Feira semanal',intentionId:'desc-replay-1'},identity);
    const first=await h.orchestrator.runTurn(turn);
    expect(first.mutation).toBeUndefined();
    const proposing=h.store.listProposing({workspaceId:identity.workspaceId,actorId:identity.actorId,deviceId:identity.deviceId??null},Date.parse('2026-10-23T00:00:00Z'));
    expect(proposing).toHaveLength(1);
    const firstKey=h.requests[0]?.idempotencyKey;
    const replay=await h.orchestrator.runTurn(turn);
    expect(replay.mutation).toMatchObject({operationId:'proposal-1',status:'proposed'});
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.idempotencyKey).toBe(firstKey);
    expect((h.requests[1]?.body as {normalizedArgs?:unknown}).normalizedArgs).toEqual({transactionId:tx.id,description:'Feira semanal',expectedDescription:'Mercado'});
  });
});
