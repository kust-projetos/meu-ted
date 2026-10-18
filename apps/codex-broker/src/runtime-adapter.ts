import { z } from 'zod';

export const ALLOWLISTED_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o1-mini',
  'o3-mini',
] as const;

export type AllowlistedModel = typeof ALLOWLISTED_MODELS[number];

export const ChatCompletionRequestSchema = z.object({
  model: z.enum(ALLOWLISTED_MODELS),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.string().max(32000),
    }),
  ).min(1).max(100),
  stream: z.boolean().optional(),
  requestId: z.string().min(1).max(128),
  intentionId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  actorId: z.string().min(1).max(128),
  temperature: z.number().min(0).max(2).optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

/**
 * Typed marker for the unwired runtime (BRK-01, T12e). The broker ships no
 * real Codex runtime: completion requests must fail closed with this error,
 * never resolve a fabricated completion. Follows the broker convention of
 * errors carrying a `code` (see browser-login.ts `login_*` errors).
 */
export const CODEX_RUNTIME_NOT_CONFIGURED = 'codex_runtime_not_configured';

export const codexRuntimeNotConfiguredError = (): Error & {
  code: string;
  statusCode: number;
} =>
  Object.assign(new Error(CODEX_RUNTIME_NOT_CONFIGURED), {
    code: CODEX_RUNTIME_NOT_CONFIGURED,
    statusCode: 503,
  });

export class CodexRuntimeAdapter {
  private readonly activeControllers = new Map<string, AbortController>();

  isModelAllowed(model: string): boolean {
    return ALLOWLISTED_MODELS.includes(model as AllowlistedModel);
  }

  cancelExecution(requestId: string): boolean {
    const controller = this.activeControllers.get(requestId);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(requestId);
      return true;
    }
    return false;
  }

  async executeCompletion(
    req: ChatCompletionRequest,
    authStatus: { authenticated: boolean; reauthRequired: boolean },
  ): Promise<{
    id: string;
    model: string;
    choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }> {
    if (!authStatus.authenticated || authStatus.reauthRequired) {
      throw new Error('codex_reauth_required');
    }

    if (!this.isModelAllowed(req.model)) {
      throw new Error(`model_not_allowlisted: ${req.model}`);
    }

    // No real Codex runtime is wired in this broker (BRK-01): fail closed
    // with the typed error above. Never synthesize a completion here; a
    // real provider connector is a separate future ticket and must not
    // gain async attached work in this slice.
    throw codexRuntimeNotConfiguredError();
  }
}
