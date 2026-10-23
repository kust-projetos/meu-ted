import { describe, expect, it } from 'vitest';
import { render, screen } from '@/lib/test-utils';
import { TedMessage } from '../TedMessage';
import type { AgentMessage } from '@/lib/api/agent-client';

const base:AgentMessage={
  id:'assistant-description-update',actorId:'ted',role:'assistant',content:'Proposta analisada.',createdAt:'2026-10-23T00:00:00.000Z',isOwn:false,
  proposalOperationId:'00000000-0000-4000-8000-000000000001',proposalTool:'transactions.update',
  terminalOutcome:{operationId:'00000000-0000-4000-8000-000000000001',tool:'transactions.update',status:'succeeded',receipt:{
    mutationId:'mutation-description-update',mutationKind:'transactions.update',status:'succeeded',affectedTargets:['transactions'],operationId:'00000000-0000-4000-8000-000000000001',entity:{type:'transaction',id:'11111111-1111-4111-8111-111111111111'},
  },expectedContext:{tool:'transactions.update',entityId:'11111111-1111-4111-8111-111111111111'}},
};

describe('TedMessage transactions.update terminal copy',()=>{
  it('uses the precise success copy only for a verified succeeded receipt',()=>{
    render(<TedMessage message={base} isCurrentUser={false}/>);
    expect(screen.getByRole('note',{name:'Resultado da operação'})).toHaveTextContent('Descrição do lançamento alterada com sucesso.');
  });

  it('does not present a failure as a successful description change',()=>{
    render(<TedMessage message={{...base,terminalOutcome:{operationId:base.proposalOperationId!,tool:'transactions.update',status:'failed'}}} isCurrentUser={false}/>);
    expect(screen.getByRole('note',{name:'Resultado da operação'})).toHaveTextContent('Não foi possível concluir a operação.');
    expect(screen.queryByText('Descrição do lançamento alterada com sucesso.')).not.toBeInTheDocument();
  });
});
