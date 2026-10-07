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
export type { MemoryToolContext } from './memory/tools.js';
export {
  FORGET_PROPOSAL_TTL_MS,
  FORGET_DECISION_TTL_MS,
  casForgetProposalStatus,
  findForgetDecision,
  forgetContentHash,
  getForgetProposal,
  initializeForgetProposalSchema,
  insertForgetProposal,
  isUnpublishedForgetExpiry,
  listActiveForgetProposals,
  listForgetProposalsForActor,
  makeForgetPreview,
  markForgetProposalExpired,
  recordForgetDecision,
  revertUnpublishedForgetProposals,
  supersedeActiveForgetProposals,
} from './memory/store.js';
export type { ForgetDecisionOutcome, ForgetProposalRecord, ForgetProposalStatus } from './memory/store.js';
export {
  cancelForgetMemory,
  confirmForgetMemory,
  FORGET_COPY,
  isForgetCancellationText,
  isForgetConfirmationText,
  isForgetManagementTurn,
  isForgetRequestText,
  proposeForgetMemory,
  renderForgetProposalQuestion,
} from './memory/forget-proposals.js';
export type {
  CancelForgetOutcome,
  ConfirmForgetOutcome,
  ProposeForgetOutcome,
} from './memory/forget-proposals.js';
export {
  fitSkills,
  renderInjectedSkills,
  renderSkillBodyBounded,
  SKILL_BUDGET_CHARS,
  SKILL_TRUNCATION_MARKER,
} from './select-skill.js';
export type { SkillFit } from './select-skill.js';
// A18/R17: restricted declarative user skills + promotion candidates.
export {
  USER_SKILL_RULE_FIELDS,
  USER_SKILL_FORBIDDEN_FIELDS,
  USER_SKILL_MERCHANT_MAX,
  USER_SKILL_CATEGORY_MAX,
  USER_SKILL_NOTE_MAX,
  UserSkillRuleError,
  parseUserSkillRule,
  assertUserSkillRule,
} from './user-skills/schema.js';
export type { UserSkillRule, UserSkillRuleErrorCode, UserSkillRuleParseResult } from './user-skills/schema.js';
export {
  initializeUserSkillsSchema,
  isCoreSkillName,
  recordSkillCandidate,
  recordReplayEvidence,
  recordSafetyReport,
  getSkillCandidate,
  listSkillCandidates,
  listActiveUserSkills,
  listUserSkillVersions,
  deactivateUserSkillVersion,
  revokeUserSkillVersion,
  userSkillKeywords,
} from './user-skills/store.js';
export type {
  ReplayEvidence,
  SkillSafetyReport,
  PromotionEvidence,
  SkillCandidate,
  SkillCandidateStatus,
  UserSkillScope,
  UserSkillVersion,
  UserSkillsSql,
  UserSkillWriteResult,
  UserSkillWriteErrorCode,
  RevokeResult,
} from './user-skills/store.js';
export { promoteSkillCandidate, runPeriodicUserSkillSweep } from './user-skills/promotion.js';
export type { PromotionResult, PromotionRejection, UserSkillSweepResult } from './user-skills/promotion.js';
export {
  resolveUserSkillCategory,
  toSelectableSkill,
  toSelectableSkills,
  USER_SKILL_CATALOG_MAX_CHARS,
  USER_SKILL_DATA_MARKER,
} from './user-skills/resolve.js';
export type { CategoryCatalogEntry, UserSkillResolution } from './user-skills/resolve.js';
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
export {
  WEB_EVIDENCE_PROMPT_CHARS,
  WEB_EVIDENCE_EXCERPT_MAX_CHARS,
  WEB_EVIDENCE_MAX_SOURCES,
  WEB_EVIDENCE_NOTICE,
  WEB_EVIDENCE_NO_SOURCE_MESSAGE,
  WEB_EVIDENCE_QUERY_REDACTED_MESSAGE,
  buildWebEvidenceEnvelope,
  filterExternalResults,
  renderEvidenceForPrompt,
  sanitizeExternalQuery,
} from './web-evidence.js';
export type {
  WebEvidenceEnvelope,
  WebEvidenceSource,
  WebEvidenceSourceInput,
  ExternalResultItem,
} from './web-evidence.js';
export {
  ANALYTICS_BASES,
  ANALYTICS_BOUNDARY,
  ANALYTICS_EVIDENCE_CHARS,
  ANALYTICS_EVIDENCE_UNAVAILABLE_PREFIX,
  ANALYTICS_QUERY_REJECTIONS,
  DEFAULT_ANALYTICS_BASIS,
  MAX_SAFE_CENTS,
  PERIOD_IGNORING_TOOLS,
  declareAnalyticsEnvelope,
  normalizeAnalyticsQuery,
  renderAnalyticsEvidence,
} from './analytics-envelope.js';
export type {
  AnalyticsBasis,
  AnalyticsEffectivePeriod,
  AnalyticsEnvelopeResult,
  AnalyticsQueryInput,
  AnalyticsQueryRejection,
  DeclareAnalyticsEnvelopeOptions,
  NormalizeAnalyticsQueryResult,
  NormalizedAnalyticsQuery,
  PeriodIgnoringTool,
  RenderAnalyticsEvidenceOptions,
} from './analytics-envelope.js';

import { buildSystemPrompt, INSTRUCTIONS_VERSION } from './instructions.js';
import { skillCatalogLines } from './skills/index.js';
import type { Skill } from './skills/index.js';
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
  opts?: {
    webEnv?: WebEnv;
    hooks?: CognitiveHooks;
    skillBudgetChars?: number;
    /**
     * A18 (R17): active user skills, already projected to the `Skill` shape
     * by `toSelectableSkills`. They compete in the same keyword score and the
     * same budget; they never reach the tool catalog (`selectToolsFor` only
     * resolves names that exist in the core catalog) nor the skill catalog
     * lines, so core skills and capabilities stay exactly as they were.
     */
    userSkills?: readonly Skill[];
  },
): AssembledCognition => {
  const fit = fitSkills(lastUserMessage, opts?.skillBudgetChars, opts?.userSkills);
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
