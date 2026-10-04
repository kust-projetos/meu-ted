/**
 * Cognitive layer entry point (Part A, item 15).
 *
 * Part B hooks: `CognitiveHooks` reserves every extension point the
 * memory/compaction/learning part will need. Part A only threads
 * `memoryContext` into the prompt — nothing here reads or writes memory.
 */

export { INSTRUCTIONS_VERSION, TED_IDENTITY, TED_GOLDEN_RULE, TED_MUTATION_POLICY, TED_BOUNDARIES, TED_RESPONSE_DISCIPLINE, buildSystemPrompt, TED_SYSTEM_PROMPT_LEGACY } from './instructions.js';
export type { SystemPromptInput } from './instructions.js';
export { ALL_SKILLS, skillByName, skillCatalogLines } from './skills/index.js';
export type { Skill } from './skills/index.js';
export { memoriaSkill } from './skills/memoria.js';
export { initializeMemorySchema, isMemoryEnabled, setMemoryEnabled, rememberFact, recallMemories, renderMemoryBlock, containsCardNumber, textSimilarity, bumpTurnCount, MEMORY_BUDGET_CHARS, MEMORY_RECALL_LIMIT, isProhibitedFinancialMemory, isCurrentFinancialState, MEMORY_UNTRUSTED_PREAMBLE } from './memory/store.js';
export type { MemoryItem, MemoryKind, MemorySql, RememberResult } from './memory/store.js';
export { initializeSessionSchema, currentSession, endSession, listPastSessions, getSessionSummary } from './memory/sessions.js';
export type { ChatSession } from './memory/sessions.js';
export { COMPACT_THRESHOLD_MESSAGES, COMPACT_KEEP_RECENT, compactContext, extractiveSummary, toContextTurns } from './memory/compact.js';
export type { ContextTurn, CompactionResult, SummarizeFn } from './memory/compact.js';
export { LEARN_EVERY_TURNS, extractLearningsHeuristic, isDuplicateLearning, learnFromTurn } from './memory/learn.js';
export type { LearningCandidate, LearnTurnInput } from './memory/learn.js';
export { buildMemoryTools, MEMORY_TOOL_NAMES } from './memory/tools.js';
export { fitSkills, renderInjectedSkills, SKILL_BUDGET_CHARS } from './select-skill.js';
export type { SkillFit } from './select-skill.js';
export { PLAYBOOK_BODY, PLAYBOOK_SUMMARY_TOOLS } from './playbook.js';
export {
  TOOL_DESCRIPTIONS,
  RETIRED_MODEL_TOOLS,
  CORE_READ_TOOLS,
  MAX_EXPOSED_TOOLS,
  toolSkillMap,
  toolSkillLines,
  selectToolsFor,
  isExplicitConfirmation,
  hasMutationIntent,
  hasUndoIntent,
  buildApprovalRequest,
  buildExposedTools,
} from './tools.js';
export type { ToolExecutionContext, ExposedTool } from './tools.js';
export {
  WEB_UNAVAILABLE_MESSAGE,
  WEB_FETCH_ALLOWED_HOSTS_ENV,
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_MAX_CHARS,
  WEB_FETCH_MAX_BYTES,
  WebFetchBlockedError,
  createWebSearchProvider,
  isBlockedFetchHost,
  assertFetchableUrl,
  parseWebFetchAllowedHosts,
  resolveWebFetchAllowedHosts,
  webFetchUrl,
} from './web.js';
export type { WebSearchProvider, WebSearchResult, WebSearchResultItem, WebEnv, WebFetchResult } from './web.js';

import { buildSystemPrompt, INSTRUCTIONS_VERSION } from './instructions.js';
import { skillCatalogLines } from './skills/index.js';
import { fitSkills, renderInjectedSkills } from './select-skill.js';
import { PLAYBOOK_BODY } from './playbook.js';
import { selectToolsFor, toolSkillLines } from './tools.js';
import { createWebSearchProvider, resolveWebFetchAllowedHosts } from './web.js';
import type { WebEnv } from './web.js';

/**
 * Part B extension points. `memoryContext` is the only live slot in
 * Part A (injected verbatim when present); the rest document where
 * Part B will plug session compaction and learning without touching
 * the prompt assembly contract.
 */
export type CognitiveHooks = {
  /** Persistent-memory summary for this workspace (Part B supplies). */
  memoryContext?: string | null;
  /** Reserved: compact the running transcript into memory (Part B). */
  compactSession?: (transcript: string) => Promise<string>;
  /** Reserved: record durable learning from a turn (Part B). */
  learnFromTurn?: (turn: { input: string; output: string }) => Promise<void>;
};

export type AssembledCognition = {
  system: string;
  selectedSkill: string | null;
  injectedAllSkills: boolean;
  toolNames: string[];
  webAvailable: boolean;
  instructionsVersion: string;
};

export const assembleCognition = (
  lastUserMessage: string,
  opts?: { webEnv?: WebEnv; hooks?: CognitiveHooks; skillBudgetChars?: number },
): AssembledCognition => {
  const fit = fitSkills(lastUserMessage, opts?.skillBudgetChars);
  const webAvailable = createWebSearchProvider(opts?.webEnv ?? {}).available;
  // A11: `web_fetch` is restricted to the operator egress allowlist and is
  // unavailable while it is empty — the prompt must not promise more.
  const fetchHosts = resolveWebFetchAllowedHosts(opts?.webEnv).size;
  const toolNames = selectToolsFor(fit.injected.map((skill) => skill.name));
  const system = buildSystemPrompt({
    skillCatalog: skillCatalogLines(),
    activeSkillBody: renderInjectedSkills(fit),
    playbookBody: PLAYBOOK_BODY,
    toolCatalog: toolSkillLines(toolNames),
    webStatusLine: !webAvailable
      ? 'indisponível (sem chave configurada) — responda com os dados do workspace.'
      : fetchHosts > 0
        ? 'busca disponível; leitura de páginas apenas nos domínios autorizados.'
        : 'busca disponível; leitura de páginas indisponível (nenhum domínio autorizado) — só use web_search.',
    ...(opts?.hooks?.memoryContext ? { memoryContext: opts.hooks.memoryContext } : {}),
  });
  return {
    system,
    selectedSkill: fit.selected?.name ?? null,
    injectedAllSkills: fit.injectedAll,
    toolNames,
    webAvailable,
    instructionsVersion: INSTRUCTIONS_VERSION,
  };
};
