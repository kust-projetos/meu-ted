import { describe, expect, it } from 'vitest';
import {
  CATEGORY_DEACTIVATE_TOOL,
  hasCategoryDeactivateSignal,
  resolveCategoryDeactivateTarget,
} from '../src/mutations/category-deactivation.js';
import type { EntitySummary } from '../src/mutations/entity-resolver.js';
import { routeIntent } from '../src/orchestration/intent-router.js';

const catalog: EntitySummary[] = [
  { id: 'cat-jade', name: 'QA Viagem Jade', kind: 'expense', isActive: true, scopeId: 'ws' },
  { id: 'cat-other', name: 'QA Viagem Jade', kind: 'income', isActive: true, scopeId: 'ws' },
  { id: 'parent-food', name: 'QA Alimentação', kind: 'expense', isActive: true, scopeId: 'ws' },
  { id: 'cat-jade-child', name: 'QA Viagem Jade', kind: 'expense', isActive: true, scopeId: 'ws', parentId: 'parent-food' },
  { id: 'cat-inactive', name: 'QA Antiga', kind: 'expense', isActive: false, scopeId: 'ws' },
  { id: 'cat-orphan', name: 'QA Órfã', kind: 'expense', isActive: true, scopeId: 'ws', parentId: 'missing-parent' },
  { id: 'foreign', name: 'QA Viagem Jade', kind: 'expense', isActive: true, scopeId: 'other' },
];

describe('category deactivation intent', () => {
  it('recognizes explicit deactivation but not category deletion or account deactivation', () => {
    expect(CATEGORY_DEACTIVATE_TOOL).toBe('categories.deactivate');
    expect(hasCategoryDeactivateSignal('desative a categoria QA Viagem Jade')).toBe(true);
    expect(hasCategoryDeactivateSignal('pare de usar a categoria QA Viagem Jade')).toBe(true);
    expect(hasCategoryDeactivateSignal('não desative a categoria QA Viagem Jade')).toBe(false);
    expect(hasCategoryDeactivateSignal('exclua a categoria QA Viagem Jade')).toBe(false);
    expect(hasCategoryDeactivateSignal('desative a conta da categoria QA Viagem Jade')).toBe(false);
    expect(routeIntent('desative a categoria QA Viagem Jade').requestedOperations.map((operation) => operation.name)).toContain('categories.deactivate');
    expect(routeIntent('apague a categoria QA Viagem Jade').ambiguity).toBe('unsupported_category_mutation');
  });

  it('resolves only one exact active in-scope category; homonyms clarify, no partial/foreign fallback', () => {
    expect(resolveCategoryDeactivateTarget('desative a categoria QA Viagem Jade', catalog, 'ws')).toMatchObject({ kind: 'ambiguous' });
    expect(resolveCategoryDeactivateTarget('desative a categoria QA Antiga', catalog, 'ws')).toMatchObject({ kind: 'none' });
    expect(resolveCategoryDeactivateTarget('desative a categoria QA Órfã', catalog, 'ws')).toMatchObject({ kind: 'none' });
    expect(resolveCategoryDeactivateTarget('desative a categoria Viagem', catalog, 'ws')).toMatchObject({ kind: 'none' });
    const unique = catalog.filter((row) => row.id !== 'cat-other' && row.id !== 'cat-jade-child');
    expect(resolveCategoryDeactivateTarget('desative a categoria QA Viagem Jade de despesa (em QA Alimentação)', catalog, 'ws')).toMatchObject({
      kind: 'resolved', category: { id: 'cat-jade-child' },
    });
    expect(resolveCategoryDeactivateTarget('desative a categoria QA Viagem Jade de receita (em QA Alimentação)', catalog, 'ws')).toMatchObject({ kind: 'none' });
    expect(resolveCategoryDeactivateTarget('desative a categoria QA Viagem Jade', unique, 'ws')).toMatchObject({
      kind: 'resolved', category: { id: 'cat-jade', name: 'QA Viagem Jade' },
    });
    expect(resolveCategoryDeactivateTarget('desative a categoria QA Viagem Jade', catalog, 'absent')).toMatchObject({ kind: 'none' });
  });
});
