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

/**
 * F5: an injected body is never allowed to exceed the ceiling, not even when a
 * single winner is chosen: workspace-derived values (a category name, an alias)
 * reach this renderer, so the ceiling is the last line of defence.
 */
export const SKILL_TRUNCATION_MARKER = '\n[conteudo truncado pelo limite de tamanho]';

/**
 * Renders one skill body bounded to `maxChars`, cutting on a line boundary when
 * possible so the truncation never leaves a half-written step in the prompt.
 */
export const renderSkillBodyBounded = (skill: Skill, maxChars: number): string => {
  const body = renderSkillBody(skill);
  if (body.length <= maxChars) return body;
  const marker = SKILL_TRUNCATION_MARKER;
  if (maxChars <= marker.length) return body.slice(0, Math.max(0, maxChars));
  const room = maxChars - marker.length;
  const kept = body.slice(0, room);
  const lastBreak = kept.lastIndexOf('\n');
  const safe = lastBreak > 0 ? kept.slice(0, lastBreak) : kept;
  return `${safe.trimEnd()}${marker}`;
};

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
  /**
   * F5: the exact text `renderInjectedSkills` produces, already bounded by the
   * budget. Present so the ceiling is observable and testable per body without
   * re-deriving the truncation.
   */
  injectedText: string | null;
};

/**
 * A18 (R17): active user skills join the SAME keyword score and the SAME
 * budget - there is no second selection or budget mechanism. They are appended
 * after the core catalog so a score tie never displaces a core skill, and an
 * empty/absent list keeps today's behavior byte for byte.
 */
export const fitSkills = (
  lastUserMessage: string,
  budgetChars = SKILL_BUDGET_CHARS,
  userSkills: readonly Skill[] = [],
): SkillFit => {
  // R06/A06: the generative path reads the same informal language the
  // deterministic parser does — one shared abbreviation table, not a second
  // private copy of it. Well-formed messages are returned unchanged.
  const haystack = normalize(expandMutationVerbs(lastUserMessage ?? ''));
  const catalog: readonly Skill[] = userSkills.length === 0 ? ALL_SKILLS : [...ALL_SKILLS, ...userSkills];
  let selected: Skill | null = null;
  let best = 0;
  for (const skill of catalog) {
    const score = skillScore(skill, haystack);
    if (score > best) {
      best = score;
      selected = skill;
    }
  }
  const allBodies = catalog.map(renderSkillBody).join('\n\n');
  if (allBodies.length <= budgetChars) {
    // Everything fits: inject all, ordered with the winner first.
    const ordered = selected
      ? [selected, ...catalog.filter((skill) => skill !== selected)]
      : [...catalog];
    return {
      selected,
      injected: ordered,
      injectedAll: true,
      injectedChars: allBodies.length,
      injectedText: allBodies,
    };
  }
  // F5: the winner is bounded by the SAME ceiling — an oversized body (a
  // workspace-derived value inside it) is truncated, never injected whole.
  const winnerBody = selected ? renderSkillBodyBounded(selected, budgetChars) : '';
  return {
    selected,
    injected: selected ? [selected] : [],
    injectedAll: false,
    injectedChars: winnerBody.length,
    injectedText: winnerBody.length === 0 ? null : winnerBody,
  };
};

export const renderInjectedSkills = (fit: SkillFit): string | null => {
  if (fit.injected.length === 0) return null;
  // The bounded text computed by `fitSkills`; recomputing it here would let the
  // ceiling be bypassed by the caller that renders the prompt.
  return fit.injectedText;
};
