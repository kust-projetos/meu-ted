import { describe, expect, it } from 'vitest';
import { validateGroundedClaims } from '../../src/evidence/grounding-validator.js';
import type { EvidenceEnvelope } from '../../src/evidence/evidence-envelope.js';

const isoNow = () => new Date().toISOString();

const moneyEnvelope = (data: unknown): EvidenceEnvelope => ({
  version: '1',
  items: [{ ref: 'api', source: 'api.balance', retrievedAt: isoNow(), status: 'ok', data }],
});

/**
 * Review fixes (track Agent, item (2) regressões): cada caso abaixo é um
 * achado do review forte, reproduzido no caminho real (sem aspas de
 * blindagem, sem fixture impossível).
 */
describe('REVIEW — achado 1 (P1): frase natural multi-token não é rejeitada', () => {
  it('aceita "Na conta principal está tudo certo." com accountName Conta principal', () => {
    const result = validateGroundedClaims(
      'Na conta principal está tudo certo.',
      moneyEnvelope({ accountName: 'Conta principal' }),
      [],
    );
    expect(result.valid).toBe(true);
  });

  it('aceita "No cartão Nubank está tudo certo." com accountName Nubank', () => {
    const result = validateGroundedClaims(
      'No cartão Nubank está tudo certo.',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    );
    expect(result.valid).toBe(true);
  });

  it('negação em outra oração não rejeita o nome ("mas não consegui consultar as despesas")', () => {
    const result = validateGroundedClaims(
      'A conta "Nubank" está ativa, mas não consegui consultar as despesas.',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    );
    expect(result.valid).toBe(true);
  });
});

describe('REVIEW — achado 2 (P1): consulta ao conteúdo do anexo usa o caminho real', () => {
  it('admite figura do bloco com atribuição ao áudio e envelope financeiro vazio por contrato', () => {
    // Caminho real do runAttachmentContentQuery
    // (conversation-orchestrator.ts): envelope { items: [] }, zero leituras
    // financeiras, figura admitida só como citação do documento.
    const envelope: EvidenceEnvelope = { version: '1', items: [] };
    const result = validateGroundedClaims('O áudio informa R$ 42,50.', envelope, [
      'compra no mercado valor 42,50 R$ pago',
    ]);
    expect(result.valid).toBe(true);
  });

  it('o mesmo envelope vazio por contrato NÃO prova estado registrado', () => {
    const envelope: EvidenceEnvelope = { version: '1', items: [] };
    const result = validateGroundedClaims('Seu saldo é R$ 42,50.', envelope, [
      'compra no mercado valor 42,50 R$ pago',
    ]);
    expect(result.valid).toBe(false);
    expect(result.counts.money).toBeGreaterThanOrEqual(1);
  });
});

describe('REVIEW — achado 3 (P2): multi-token exige limite de entidade', () => {
  it('rejeita "Nubank Premium" contra evidência "Nubank PremiumPlus"', () => {
    const result = validateGroundedClaims(
      'O "Nubank Premium" está ativo.',
      moneyEnvelope({ accountName: 'Nubank PremiumPlus' }),
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.counts.name).toBeGreaterThanOrEqual(1);
  });
});

describe('REVIEW re-review — achado 1 (HIGH): NAME_CUT não reduz nome composto', () => {
  it('rejeita "A conta Mercado Pago está ativa." contra evidência "Mercado Livre" (sem aspas)', () => {
    const result = validateGroundedClaims(
      'A conta Mercado Pago está ativa.',
      moneyEnvelope({ accountName: 'Mercado Livre' }),
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.counts.name).toBeGreaterThanOrEqual(1);
  });
});

describe('REVIEW re-review — achado 2 (MEDIUM): negação vinculada à entidade', () => {
  it('aceita "A conta Nubank não tem despesas." (negativa de atributo)', () => {
    const result = validateGroundedClaims(
      'A conta Nubank não tem despesas.',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    );
    expect(result.valid).toBe(true);
  });

  it('aceita "Não há despesas na conta Nubank." (negativa de atributo)', () => {
    const result = validateGroundedClaims(
      'Não há despesas na conta Nubank.',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    );
    expect(result.valid).toBe(true);
  });

  it('rejeita "Não encontrei a conta Nubank." (negativa de existência, sem aspas)', () => {
    const result = validateGroundedClaims(
      'Não encontrei a conta Nubank.',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.counts.name).toBeGreaterThanOrEqual(1);
  });
});
describe('REVIEW re-review — achado MEDIUM: nome da ocorrência nunca conta como ATTRIBUTE_NOUN', () => {
  it('rejeita "Não encontrei a conta Pagamentos." com accountName Pagamentos (existência negada)', () => {
    const result = validateGroundedClaims(
      'Não encontrei a conta Pagamentos.',
      moneyEnvelope({ accountName: 'Pagamentos' }),
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.counts.name).toBeGreaterThanOrEqual(1);
  });

  it('rejeita "Não encontrei a conta Saldo." com accountName Saldo (existência negada)', () => {
    const result = validateGroundedClaims(
      'Não encontrei a conta Saldo.',
      moneyEnvelope({ accountName: 'Saldo' }),
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.counts.name).toBeGreaterThanOrEqual(1);
  });

  it('mantém "não tem despesas" como negativa de atributo (válido)', () => {
    const result = validateGroundedClaims(
      'A conta Nubank não tem despesas.',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    );
    expect(result.valid).toBe(true);
  });

  it('mantém "Não há despesas na conta Nubank" como negativa de atributo (válido)', () => {
    const result = validateGroundedClaims(
      'Não há despesas na conta Nubank.',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    );
    expect(result.valid).toBe(true);
  });
});
describe('REVIEW — achado 4 (P2): cada ocorrência tem seu próprio escopo', () => {
  it('rejeita quando a segunda ocorrência nega ("Não encontrei a conta Nubank")', () => {
    const result = validateGroundedClaims(
      'A conta "Nubank" está ativa. Não encontrei a conta "Nubank".',
      moneyEnvelope({ accountName: 'Nubank' }),
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.counts.name).toBeGreaterThanOrEqual(1);
  });
});
