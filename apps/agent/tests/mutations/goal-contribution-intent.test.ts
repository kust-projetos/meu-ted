import { describe, expect, it } from 'vitest';
import { isGoalContributionIntent } from '../../src/mutations/goal-contribution-intent.js';

describe('goal contribution intent', () => {
  it.each(['Aportar R$ 50 na meta viagem', 'Guardar 100 na reserva', 'Quero contribuir com R$ 20 no objetivo'])('detects a contribution: %s', (text) => {
    expect(isGoalContributionIntent(text)).toBe(true);
  });
  it.each(['Quanto falta para a meta viagem?', 'Como está minha meta?', 'Criar nova meta viagem', 'Cancelar aporte na meta', 'Comprei R$ 50 no cartão', 'R$ 50 na meta viagem'])('rejects non-contribution: %s', (text) => {
    expect(isGoalContributionIntent(text)).toBe(false);
  });
});
