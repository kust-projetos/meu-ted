import { describe, expect, it } from 'vitest';
import { isExplicitConfirmation } from '../src/agent-config/tools.js';
import { classifyFastPath, routeIntent } from '../src/orchestration/intent-router.js';
import { resolveConfirmation } from '../src/mutations/confirmation-resolver.js';

// P0 #174 — negação interpretada como confirmação (TDD RED→GREEN).
// Negações/contradições NUNCA roteiam para confirmation nem autorizam execute.
// Confirmações legítimas continuam funcionando.
describe('P0 #174 negation safety (RED)', () => {
  it.each([
    'não confirmo',
    'não autorizo',
    'não quero confirmar',
    'sim, mas não confirme',
    'não cancela',
    'não registre',
    'NAO CONFIRMO',
    'na\u0303o confirmo',
    'nunca confirme',
    'jamais autorizo',
  ])('classifyFastPath(%s) nunca é confirm', (text) => {
    expect(classifyFastPath(text).kind).not.toBe('confirm');
  });

  it.each([
    'não confirmo',
    'não autorizo',
    'não quero confirmar',
    'sim, mas não confirme',
    'não cancela',
    'não registre',
  ])('routeIntent com decisionText de negação nunca resulta confirmation', (text) => {
    expect(routeIntent(text, text).mode).not.toBe('confirmation');
  });

  it.each([
    'não confirmo',
    'não autorizo',
    'sim, mas não confirme',
    'NAO CONFIRMO',
    'nunca confirme',
    'jamais autorizo',
  ])(
    'isExplicitConfirmation(%s) é false',
    (text) => {
      expect(isExplicitConfirmation(text)).toBe(false);
    },
  );

  it('isExplicitConfirmation com NFD (n+a+U+0303+o) é false', () => {
    expect(isExplicitConfirmation('na\u0303o confirmo')).toBe(false);
  });

  it('resolveConfirmation(negação) nunca confirma', () => {
    expect(resolveConfirmation('não confirmo', ['op-1']).kind).not.toBe('confirm');
  });

  it('confirmações legítimas continuam funcionando', () => {
    expect(classifyFastPath('confirmo').kind).toBe('confirm');
    expect(classifyFastPath('sim, confirmo').kind).toBe('confirm');
    expect(classifyFastPath('autorizo').kind).toBe('confirm');
    expect(routeIntent('confirmo', 'confirmo').mode).toBe('confirmation');
    expect(isExplicitConfirmation('confirmo o pagamento')).toBe(true);
    expect(isExplicitConfirmation('sim, pode fazer')).toBe(true);
    expect(resolveConfirmation('sim', ['op-1']).kind).toBe('confirm');
  });
});
