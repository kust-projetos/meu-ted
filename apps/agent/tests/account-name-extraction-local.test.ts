/**
 * account-name-extraction-local (TASK_ID: ted-local-account-name) — RED tests
 * for the browser-observed bug: 'crie conta QA Aurora banco saldo 1000'
 * extracted name "QA Aurora banco" (bare kind marker leaked into the draft
 * name) and left kind missing, so the follow-up 'banco' confirmed a polluted
 * name. A second prompt ('... do tipo bank ... de R$') polluted the name with
 * structural tokens. Fixed source must extract name "QA Aurora", kind bank
 * and opening 100000 in the complete utterance (no kind question when the
 * kind is already explicit), while preserving legitimate names (Banco do
 * Brasil, Banco Inter, Nubank, Itaú) and numbered names, and never stripping
 * "Banco" out of a real bank name.
 */
import { describe, expect, it } from 'vitest';
import {
  extractAccountName,
  hasStructuralBankMarker,
  parseAccountBalance,
  parseAccountCreation,
  parseAccountKind,
} from '../src/mutations/account-creation.js';

describe('ted-local-account-name: structural kind markers', () => {
  it('(1) RED-core: "crie conta QA Aurora banco saldo 1000" → QA Aurora + bank + 100000', () => {
    const parsed = parseAccountCreation('crie conta QA Aurora banco saldo 1000');
    expect(parsed.isCreation).toBe(true);
    expect(parsed.name).toBe('QA Aurora');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(100000);
    expect(parsed.balanceExplicit).toBe(true);
  });

  it('(2) "do tipo bank ... de R$" tokens do not pollute the name', () => {
    const parsed = parseAccountCreation('crie conta QA Aurora do tipo bank com saldo de R$ 1000');
    expect(parsed.name).toBe('QA Aurora');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(100000);
  });

  it('(3) "bank" variant: "criar conta QA Aurora bank com saldo 1000"', () => {
    const parsed = parseAccountCreation('criar conta QA Aurora bank com saldo 1000');
    expect(parsed.name).toBe('QA Aurora');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(100000);
  });

  it('(4) "tipo corrente" no longer leaks into the name (kind still bank)', () => {
    expect(extractAccountName('criar conta reserva tipo corrente com saldo 10')).toBe('reserva');
    expect(extractAccountName('criar conta reserva do tipo corrente com saldo 10')).toBe('reserva');
    expect(parseAccountKind('criar conta reserva tipo corrente com saldo 10')).toBe('bank');
  });

  it('(5) structural detector: trailing banco is explicit, leading Banco is a name', () => {
    expect(hasStructuralBankMarker('crie conta QA Aurora banco saldo 1000')).toBe(true);
    expect(hasStructuralBankMarker('crie conta QA Aurora do tipo bank com saldo de R$ 1000')).toBe(true);
    expect(hasStructuralBankMarker('criar conta Banco do Brasil com saldo 100')).toBe(false);
    expect(hasStructuralBankMarker('criar conta Banco Inter com saldo 200')).toBe(false);
    expect(hasStructuralBankMarker('criar conta Nubank com saldo 145')).toBe(false);
  });
});

describe('ted-local-account-name: legitimate names preserved', () => {
  it('(6) "Banco do Brasil" keeps its name and still asks kind', () => {
    const parsed = parseAccountCreation('criar conta Banco do Brasil com saldo 100');
    expect(parsed.name).toBe('Banco do Brasil');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(7) "Banco Inter" keeps its name and still asks kind', () => {
    const parsed = parseAccountCreation('criar conta Banco Inter com saldo 200');
    expect(parsed.name).toBe('Banco Inter');
    expect(parsed.accountKind).toBeUndefined();
  });

  it('(8) "Nubank" never fills kind (bank substring is a name, not an answer)', () => {
    const parsed = parseAccountCreation('criar conta Nubank com saldo 145');
    expect(parsed.name).toBe('Nubank');
    expect(parsed.accountKind).toBeUndefined();
  });

  it('(9) "Itaú" keeps spelling and still fills bank (itau-kind-bank exception)', () => {
    const parsed = parseAccountCreation('criar conta Itaú com saldo 145');
    expect(parsed.name).toBe('Itaú');
    expect(parsed.accountKind).toBe('bank');
  });

  it('(10) numbered names keep their number: "Reserva 3 com saldo 100"', () => {
    const parsed = parseAccountCreation('criar conta Reserva 3 com saldo 100');
    expect(parsed.name).toBe('Reserva 3');
    expect(parsed.initialBalanceCents).toBe(10000);
    expect(parsed.accountKind).toBeUndefined();
  });

  it('(11) "Caixa" is not a known-bank inference (minimal scope: only itau)', () => {
    const parsed = parseAccountCreation('criar conta Caixa com saldo 50');
    expect(parsed.name).toBe('Caixa');
    expect(parsed.accountKind).toBeUndefined();
  });
});

describe('ted-local-account-name: balance guards (ADR-018, no defaults)', () => {
  it('(12) signed/zero balances stay explicit values', () => {
    expect(parseAccountBalance('criar conta reserva com saldo zero')).toMatchObject({ cents: 0, explicit: true });
    expect(parseAccountBalance('criar conta devedora com saldo negativo de 50')).toMatchObject({
      cents: -5000,
      explicit: true,
    });
  });

  it('(13) invalid balance never defaults: "saldo alto" stays missing', () => {
    expect(parseAccountBalance('criar conta reserva com saldo alto')).toBeUndefined();
    const parsed = parseAccountCreation('criar conta reserva com saldo alto');
    expect(parsed.name).toBe('reserva');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(14) ambiguous "saldo 10 20" stays missing (no invention)', () => {
    expect(parseAccountBalance('criar conta reserva com saldo 10 20')).toBeUndefined();
  });
});

describe('ted-local-account-name: confirmations/negations never create names', () => {
  it('(15) short affirmatives and confirm-create texts yield no name', () => {
    expect(extractAccountName('sim')).toBeUndefined();
    expect(extractAccountName('quero sim')).toBeUndefined();
    expect(extractAccountName('pode criar')).toBeUndefined();
    expect(extractAccountName('sim, pode criar')).toBeUndefined();
  });

  it('(16) short negations yield no name', () => {
    expect(extractAccountName('não')).toBeUndefined();
    expect(extractAccountName('não quero')).toBeUndefined();
    expect(extractAccountName('cancela')).toBeUndefined();
    expect(extractAccountName('cancelar')).toBeUndefined();
  });
});

describe('ted-local-account-name round2: explicitly named wins, no silent inference', () => {
  it('(17) quoted name wins: "Aurora Banco" keeps Banco, kind asked', () => {
    const parsed = parseAccountCreation('crie conta "Aurora Banco" com saldo 100');
    expect(parsed.name).toBe('Aurora Banco');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(18) "chamada" names win: chamada Aurora Banco keeps Banco, kind asked', () => {
    const parsed = parseAccountCreation('crie conta chamada Aurora Banco com saldo 100');
    expect(parsed.name).toBe('Aurora Banco');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(19) distant alternative is not a balance: "...saldo 100 ou, se eu estiver lembrando corretamente, 200" asks', () => {
    const text = 'criar conta Reserva banco saldo 100 ou, se eu estiver lembrando corretamente, 200';
    expect(parseAccountBalance(text)).toBeUndefined();
    const parsed = parseAccountCreation(text);
    expect(parsed.name).toBe('Reserva');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(20) foreign currency never converts: "saldo USD 100" stays missing', () => {
    const parsed = parseAccountCreation('criar conta Reserva 3 banco saldo USD 100');
    expect(parsed.initialBalanceCents).toBeUndefined();
    expect(parsed.name).toBe('Reserva 3');
    expect(parseAccountBalance('criar conta Reserva com saldo em dólares 100')).toBeUndefined();
    expect(parseAccountBalance('criar conta Reserva com saldo EUR 50')).toBeUndefined();
  });

  it('(21) approximation never converts: "saldo aproximadamente 100" stays missing', () => {
    expect(parseAccountBalance('criar conta Reserva 3 com saldo aproximadamente 100')).toBeUndefined();
    expect(parseAccountBalance('criar conta Reserva com saldo uns 100')).toBeUndefined();
    expect(parseAccountBalance('criar conta Reserva com saldo cerca de 100')).toBeUndefined();
    const parsed = parseAccountCreation('criar conta Reserva 3 com saldo aproximadamente 100');
    expect(parsed.name).toBe('Reserva 3');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(22) textual zero consumes no name numbers: "Reserva 3 com saldo zero"', () => {
    const parsed = parseAccountCreation('criar conta Reserva 3 com saldo zero');
    expect(parsed.name).toBe('Reserva 3');
    expect(parsed.initialBalanceCents).toBe(0);
    expect(parsed.balanceExplicit).toBe(true);
  });
});

describe('ted-local-account-name round3: shared light segmentation, name spans win', () => {
  it('(23) "nome" introducer: name intact, kind asked', () => {
    const parsed = parseAccountCreation('crie conta nome Aurora Banco com saldo 100');
    expect(parsed.name).toBe('Aurora Banco');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(24) "de nome" introducer: name intact, kind asked', () => {
    const parsed = parseAccountCreation('crie conta de nome Aurora Banco com saldo 100');
    expect(parsed.name).toBe('Aurora Banco');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(25) explicit external tipo still fills kind outside the named span', () => {
    const parsed = parseAccountCreation('crie conta chamada Aurora Banco do tipo bank com saldo 100');
    expect(parsed.name).toBe('Aurora Banco');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(26) quoted "tipo bank" is a literal name: intact, no kind', () => {
    const parsed = parseAccountCreation('criar conta "tipo bank" com saldo 100');
    expect(parsed.name).toBe('tipo bank');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(27) quoted "Reserva USD": USD is name content, outer balance fills', () => {
    const parsed = parseAccountCreation('criar conta "Reserva USD" com saldo 100');
    expect(parsed.name).toBe('Reserva USD');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(28) zero with alternative stays missing: "saldo zero ou100"', () => {
    expect(parseAccountBalance('criar conta Reserva com saldo zero ou100')).toBeUndefined();
    const parsed = parseAccountCreation('criar conta Reserva com saldo zero ou100');
    expect(parsed.name).toBe('Reserva');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(29) negated zero clarifies nothing: "saldo não é zero, é 100" asks', () => {
    expect(parseAccountBalance('criar conta Reserva com saldo não é zero, é 100')).toBeUndefined();
    const parsed = parseAccountCreation('criar conta Reserva com saldo não é zero, é 100');
    expect(parsed.name).toBe('Reserva');
    expect(parsed.initialBalanceCents).toBeUndefined();
    expect(parsed.balanceExplicit).toBe(false);
  });

  it('(29b) legitimate negatives still sign: "saldo negativo de 50", "saldo -50"', () => {
    expect(parseAccountBalance('criar conta devedora com saldo negativo de 50')).toMatchObject({
      cents: -5000,
      explicit: true,
    });
    expect(parseAccountBalance('criar conta devedora com saldo -50')).toMatchObject({
      cents: -5000,
      explicit: true,
    });
  });

  it('(30) quoted "negativo" is name content: balance stays positive', () => {
    const parsed = parseAccountCreation('criar conta "Reserva negativo" com saldo 100');
    expect(parsed.name).toBe('Reserva negativo');
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(31) quoted numbered name without balance: no invention', () => {
    const parsed = parseAccountCreation('criar conta "Reserva 3"');
    expect(parsed.name).toBe('Reserva 3');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(32) quoted "carteira" is name content: no cash inference', () => {
    const parsed = parseAccountCreation('criar conta "Reserva carteira" com saldo 100');
    expect(parsed.name).toBe('Reserva carteira');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(33) quoted "Saldo zero" is a name: outer balance fills', () => {
    const parsed = parseAccountCreation('criar conta "Saldo zero" com saldo 100');
    expect(parsed.name).toBe('Saldo zero');
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(34) zero with foreign currency stays missing: "saldo zero USD"', () => {
    expect(parseAccountBalance('criar conta Reserva com saldo zero USD')).toBeUndefined();
    const parsed = parseAccountCreation('criar conta Reserva com saldo zero USD');
    expect(parsed.name).toBe('Reserva');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(35) attached "Conta360" is never split mid-word', () => {
    const parsed = parseAccountCreation('criar conta Conta360 com saldo 100');
    expect(parsed.name).toBe('Conta360');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(36) later "Conta" names: "Conta 360" keeps its name', () => {
    const parsed = parseAccountCreation('criar conta Conta 360 com saldo 100');
    expect(parsed.name).toBe('Conta 360');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(37) fresh-turn foreign amounts stay missing: "US$100", "100 dolares"', () => {
    expect(parseAccountBalance('criar conta Reserva saldo US$100')).toBeUndefined();
    expect(parseAccountBalance('criar conta Reserva com saldo 100 dolares')).toBeUndefined();
    expect(parseAccountCreation('criar conta Reserva saldo US$100').name).toBe('Reserva');
    expect(parseAccountCreation('criar conta Reserva com saldo 100 dolares').name).toBe('Reserva');
  });

  it('(38) supported "R$" attaches: "saldo R$100" fills exactly', () => {
    const parsed = parseAccountCreation('criar conta Reserva com saldo R$100');
    expect(parsed.name).toBe('Reserva');
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(39) explicit external tipo with "nome": kind fills outside the named span', () => {
    const parsed = parseAccountCreation('crie conta nome Aurora Banco do tipo bank com saldo 100');
    expect(parsed.name).toBe('Aurora Banco');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(40) quoted kind answer stays a name: bare "banco" fills kind via allowBare', () => {
    expect(parseAccountKind('banco', { allowBare: true })).toBe('bank');
    expect(parseAccountKind('"banco"', { allowBare: true })).toBeUndefined();
  });
});

describe('ted-local-account-name round-final: token origin and certainty', () => {
  it('(41) attached name digit is never a balance: "Reserva3 ... saldo ainda não sei"', () => {
    const parsed = parseAccountCreation('crie conta Reserva3 banco com saldo ainda não sei');
    expect(parsed.name).toBe('Reserva3');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBeUndefined();
    expect(parsed.balanceExplicit).toBe(false);
  });

  it('(42) attached "Conta360" with uninformative balance stays missing', () => {
    const parsed = parseAccountCreation('criar conta Conta360 com saldo a informar');
    expect(parsed.name).toBe('Conta360');
    expect(parsed.accountKind).toBeUndefined();
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(43) negated zero fragment asks: "saldo não está zerado"', () => {
    expect(parseAccountBalance('criar conta Reserva com saldo não está zerado')).toBeUndefined();
    const parsed = parseAccountCreation('criar conta Reserva com saldo não está zerado');
    expect(parsed.name).toBe('Reserva');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(44) negated sign fragment asks: "saldo não negativo de 50"', () => {
    expect(parseAccountBalance('criar conta Reserva com saldo não negativo de 50')).toBeUndefined();
    const parsed = parseAccountCreation('criar conta Reserva com saldo não negativo de 50');
    expect(parsed.name).toBe('Reserva');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(45) approximated textual zero asks: "saldo aproximadamente zero"', () => {
    expect(parseAccountBalance('criar conta Reserva com saldo aproximadamente zero')).toBeUndefined();
    const parsed = parseAccountCreation('criar conta Reserva com saldo aproximadamente zero');
    expect(parsed.name).toBe('Reserva');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(46) attached name digit is never consumed: "Reserva1000 banco 100"', () => {
    const parsed = parseAccountCreation('crie conta Reserva1000 banco 100');
    expect(parsed.name).toBe('Reserva1000');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(47) spaced alternative cuts the clause: "Reserva banco saldo zero ou 100"', () => {
    expect(parseAccountBalance('criar conta Reserva banco com saldo zero ou 100')).toBeUndefined();
    const parsed = parseAccountCreation('criar conta Reserva banco com saldo zero ou 100');
    expect(parsed.name).toBe('Reserva');
    expect(parsed.initialBalanceCents).toBeUndefined();
  });

  it('(48) attached cue fills: "banco saldo1000" keeps name, kind and 100000', () => {
    const parsed = parseAccountCreation('crie conta QA Aurora banco saldo1000');
    expect(parsed.name).toBe('QA Aurora');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(100000);
  });

  it('(49) pre-clause sign word does not sign: "Reserva negativo com saldo 50"', () => {
    const parsed = parseAccountCreation('crie conta Reserva negativo com saldo 50');
    expect(parsed.name).toBe('Reserva negativo');
    expect(parsed.initialBalanceCents).toBe(5000);
  });

  it('(50) quoted/de-nome "negativo" with exact outer balance stays positive', () => {
    expect(parseAccountCreation('criar conta "Reserva negativo" com saldo 50').initialBalanceCents).toBe(5000);
    expect(parseAccountCreation('criar conta de nome Reserva negativo com saldo 50').initialBalanceCents).toBe(
      5000,
    );
  });

  it('(51) "MeuSaldo" is not a cue: pre-clause sign does not sign', () => {
    const parsed = parseAccountCreation('crie conta MeuSaldo negativo banco com saldo 50');
    expect(parsed.name).toBe('MeuSaldo negativo');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(5000);
  });

  it('(52) "MeuSaldo banco saldo1000": cue is the real one, name intact', () => {
    const parsed = parseAccountCreation('criar conta MeuSaldo banco saldo1000');
    expect(parsed.name).toBe('MeuSaldo');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(100000);
  });

  it('(53) NFD name keeps its digits (decomposed e + combining acute)', () => {
    const nfdCafe = 'Café'.normalize('NFD');
    expect(nfdCafe).not.toBe(nfdCafe.normalize('NFC'));
    expect(nfdCafe).toBe('Café');
    const parsed = parseAccountCreation(`crie conta Reserva 100 ${nfdCafe} banco saldo100`);
    expect(parsed.name).toBe(`Reserva 100 ${nfdCafe}`);
    expect(parsed.initialBalanceCents).toBe(10000);
  });

  it('(54) attached repeat control: "Reserva100 banco 100"', () => {
    const parsed = parseAccountCreation('crie conta Reserva100 banco 100');
    expect(parsed.name).toBe('Reserva100');
    expect(parsed.accountKind).toBe('bank');
    expect(parsed.initialBalanceCents).toBe(10000);
  });
});
