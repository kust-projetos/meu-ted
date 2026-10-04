/**
 * Skill selection (Part A, item 15).
 *
 * Simple keyword heuristic over the last user message: each skill scores
 * one point per matched keyword fragment. The winner is injected whole;
 * when everything fits the token budget, all skills go in and selection
 * only orders relevance. Pure function — trivially testable, no network.
 */

import { ALL_SKILLS, renderSkillBody, type Skill } from './skills/index.js';
import { expandMutationVerbs } from '../mutations/semantic-interpretation.js';

/** Char budget above which only the winning skill is injected whole. */
export const SKILL_BUDGET_CHARS = 6000;

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const skillScore = (skill: Skill, haystack: string): number => {
  let score = 0;
  for (const keyword of skill.keywords) {
    if (haystack.includes(normalize(keyword))) score += 1;
  }
  return score;
};

export type SkillFit = {
  /** Winner by heuristic (null when nothing matched). */
  selected: Skill | null;
  /** Full bodies to inject: winner only, or all when under budget. */
  injected: Skill[];
  /** True when the whole set fit the budget. */
  injectedAll: boolean;
  /** Total chars of the injected bodies (for the size test). */
  injectedChars: number;
};

export const fitSkills = (lastUserMessage: string, budgetChars = SKILL_BUDGET_CHARS): SkillFit => {
  // R06/A06: the generative path reads the same informal language the
  // deterministic parser does — one shared abbreviation table, not a second
  // private copy of it. Well-formed messages are returned unchanged.
  const haystack = normalize(expandMutationVerbs(lastUserMessage ?? ''));
  let selected: Skill | null = null;
  let best = 0;
  for (const skill of ALL_SKILLS) {
    const score = skillScore(skill, haystack);
    if (score > best) {
      best = score;
      selected = skill;
    }
  }
  const allBodies = ALL_SKILLS.map(renderSkillBody).join('\n\n');
  if (allBodies.length <= budgetChars) {
    // Everything fits: inject all, ordered with the winner first.
    const ordered = selected
      ? [selected, ...ALL_SKILLS.filter((skill) => skill !== selected)]
      : [...ALL_SKILLS];
    return { selected, injected: ordered, injectedAll: true, injectedChars: allBodies.length };
  }
  return {
    selected,
    injected: selected ? [selected] : [],
    injectedAll: false,
    injectedChars: selected ? renderSkillBody(selected).length : 0,
  };
};

export const renderInjectedSkills = (fit: SkillFit): string | null => {
  if (fit.injected.length === 0) return null;
  return fit.injected.map(renderSkillBody).join('\n\n');
};
