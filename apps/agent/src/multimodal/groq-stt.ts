/**
 * A14 / R12 — STT de áudio via Groq (`whisper-large-v3-turbo`).
 *
 * Decisão G05 (docs/reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md
 * §2): o STT é o provider Groq com o modelo `whisper-large-v3-turbo`, `language=pt`
 * e `response_format=json`, e **sem fallback** para um modelo que treine com
 * dados do cliente. Este módulo é a fronteira do provider: ele só sabe falar
 * HTTP multipart e classificar a resposta — nada de pipeline, nada de estado.
 *
 * Princípios (AC22):
 *
 * 1. **Default-off com trava tripla.** O provider só fica disponível quando
 *    `TED_AUDIO_STT_ENABLED=1` **e** `GROQ_API_KEY` **e** a coorte
 *    `TED_AUDIO_STT_COHORT` (CSV de workspace/actor ids, `'*'` = todos;
 *    vazia/ausente = ninguém — A19-STT-COHORT) incluem a identidade do turno.
 *    Sem os três, `available` é `false`, nenhuma requisição sai e o processor
 *    de áudio permanece o `unsupported` fail-closed da A13 — nada muda no
 *    comportamento.
 * 2. **Minimização do payload.** Vai ao provider: os bytes, o modelo, o idioma
 *    e o formato da resposta. NÃO vai: `prompt` (nenhum contexto financeiro,
 *    nenhum resumo de conversa), nome do arquivo do usuário (o nome da parte
 *    é derivado do MIME detectado no servidor, nunca do input do cliente).
 * 3. **Credencial lida no call time**, usada só no header `Authorization` e
 *    nunca logada nem incluída em erro.
 * 4. **Timeout próprio** (`TED_AUDIO_STT_TIMEOUT_MS`, default 20 s) via
 *    `AbortSignal` — distinto do teto de 2 s do judgment (R15), que é outro
 *    serviço com outro orçamento.
 * 5. **Toda falha é um estado tipado**: `timeout`, `unauthorized`,
 *    `rate_limited`, `provider_error`, `bad_response`. Nunca uma exception
 *    crua, nunca um turno mudo, nunca um "vazio".
 * 6. **Nenhum campo inventado.** O JSON do provider não traz `confidence` nem
 *    `id`; o resultado carrega apenas o texto (limitado em caracteres).
 *
 * Nada de dependência nova: o multipart é montado com `FormData`/`Blob`, já
 * disponíveis no runtime dos Workers e no Node dos testes.
 */

import { ATTACHMENT_LIMITS } from '../attachments/types.js';
import type { AttachmentProcessor, AttachmentProcessorResult } from '../attachments/processors.js';
import { UNSUPPORTED_DETAIL } from '../attachments/processors.js';
import { scrubForPersistence } from '../privacy/dlp.js';

export const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_STT_DEFAULT_MODEL = 'whisper-large-v3-turbo';
export const GROQ_STT_DEFAULT_TIMEOUT_MS = 20_000;
export const GROQ_STT_LANGUAGE = 'pt';

/**
 * Ceiling of the provider ANSWER (not of the audio): a transcript is bounded
 * before it can inflate the turn prompt.
 */
export const AUDIO_TRANSCRIPT_MAX_CHARS = 4_000;

/**
 * Proveniência obrigatória do texto transcrito.
 *
 * Two jobs, both structural:
 *
 * 1. **Visível**: o histórico mostra que aquele texto veio de uma transcrição,
 *    não de algo que o usuário digitou.
 * 2. **Estrutural**: por abrir com este marcador, o texto do turno NUNCA
 *    satisfaz `hasExplicitMutationIntent` (que exige um imperativo mutacional
 *    no INÍCIO da mensagem) — logo `isAutoExecutionEligible` é falso e um
 *    turno com áudio jamais entra no autoexecute. A confirmação humana vigente
 *    é o único caminho possível a partir daqui.
 */
export const AUDIO_TRANSCRIPT_NOTICE =
  '[transcrição do anexo de áudio (STT): conteúdo do usuário, possivelmente com erros de reconhecimento]';

/** A14: conservative per-turn ceiling — one transcription, then explicit skips. */
export const AUDIO_TRANSCRIPTIONS_PER_TURN = 1;

export type GroqSttEnv = {
  GROQ_API_KEY?: string;
  TED_AUDIO_STT_ENABLED?: string;
  TED_AUDIO_STT_COHORT?: string;
  TED_AUDIO_STT_MODEL?: string;
  TED_AUDIO_STT_TIMEOUT_MS?: string;
};

/** Terminal states of the adapter. `transcribed` is the only success. */
export type SttState =
  | 'transcribed'
  | 'unavailable'
  | 'timeout'
  | 'unauthorized'
  | 'rate_limited'
  | 'provider_error'
  | 'bad_response';

export type SttOutcome =
  | { state: 'transcribed'; text: string }
  | { state: Exclude<SttState, 'transcribed'>; text?: undefined };

export type SttRequest = {
  /** Raw audio bytes from the mediated attachment read. Never logged. */
  bytes: ArrayBuffer;
  /** Server-sniffed MIME (from magic bytes), never a client-declared header. */
  mime: string;
};

export type GroqSttProvider = {
  readonly provider: 'groq';
  readonly available: boolean;
  transcribe: (request: SttRequest) => Promise<SttOutcome>;
};

/** Nome da env da allowlist de coorte do STT (CSV, documentado no DO). */
export const AUDIO_STT_COHORT_ENV = 'TED_AUDIO_STT_COHORT';

/**
 * A19-STT-COHORT — parse da coorte do STT: CSV com trim, vazios descartados.
 * Ausente/vazia/não-string ⇒ []. Espelha `parseAttachmentUploadCohort`
 * (`attachments/upload-gate.ts`), DUPLICADO de propósito: o upload gate tem
 * contrato próprio e nenhum dos dois pode mudar o comportamento do outro.
 */
export const parseAudioSttCohort = (env: unknown): string[] => {
  const raw = (env as GroqSttEnv | undefined)?.TED_AUDIO_STT_COHORT;
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

/**
 * Coorte STT: casa por workspaceId OU actorId. Lista vazia (env
 * ausente/vazia) = ninguém — fail-closed por construção, sem caso especial
 * no chamador. Entrada curinga `'*'` = TODOS (decisão do operador para
 * rollout geral). Qualquer outra entrada segue casamento exato,
 * case-sensitive. Nunca lança.
 */
export const isAudioSttCohortMember = (
  env: unknown,
  workspaceId?: string,
  actorId?: string,
): boolean => {
  const allow = parseAudioSttCohort(env);
  if (allow.length === 0) return false;
  if (allow.includes('*')) return true;
  return allow.includes(workspaceId ?? '') || allow.includes(actorId ?? '');
};

/**
 * The triple lock. `TED_AUDIO_STT_ENABLED` alone is not enough (a leaked key
 * must not silently enable audio egress), the key alone is not enough (the
 * rollout stays opt-in), and NEITHER enables egress without cohort membership
 * (`TED_AUDIO_STT_COHORT`: CSV of workspace/actor ids, `'*'` = everyone;
 * empty/missing = NOBODY — A19-STT-COHORT, the sequenced rollout
 * operator-only → internal → small canary → active).
 */
export const isGroqSttAvailable = (
  env: GroqSttEnv | undefined,
  workspaceId?: string,
  actorId?: string,
): boolean => {
  const enabled = env?.TED_AUDIO_STT_ENABLED?.trim();
  const key = env?.GROQ_API_KEY?.trim();
  if (!(enabled === '1' && typeof key === 'string' && key.length > 0)) return false;
  return isAudioSttCohortMember(env, workspaceId, actorId);
};

const DEFAULT_TIMEOUT_MIN_MS = 1;
const DEFAULT_TIMEOUT_MAX_MS = 120_000;

/** Operator timeout, clamped to a sane band; unparseable ⇒ default. */
export const resolveSttTimeoutMs = (env: GroqSttEnv | undefined): number => {
  const raw = Number(env?.TED_AUDIO_STT_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return GROQ_STT_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), DEFAULT_TIMEOUT_MIN_MS), DEFAULT_TIMEOUT_MAX_MS);
};

/** Model allowlist: only the two ZDR-eligible Groq Whisper deployments. */
const ALLOWED_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'] as const;

/**
 * Model resolution is an ALLOWLIST, not a free pass: a typo or a model that
 * trains on customer data is refused back to the default instead of being sent.
 */
export const resolveSttModel = (env: GroqSttEnv | undefined): string => {
  const requested = env?.TED_AUDIO_STT_MODEL?.trim();
  return (ALLOWED_MODELS as readonly string[]).includes(requested ?? '')
    ? (requested as string)
    : GROQ_STT_DEFAULT_MODEL;
};

/** Filename extension derived from the SERVER-SNIFFED mime, never the user's name. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
};

export const uploadNameForMime = (mime: string): string =>
  `audio.${EXTENSION_BY_MIME[mime] ?? 'webm'}`;

const clampTranscript = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > AUDIO_TRANSCRIPT_MAX_CHARS ? trimmed.slice(0, AUDIO_TRANSCRIPT_MAX_CHARS) : trimmed;
};

/**
 * The provider boundary. `fetchImpl` is injected so every test runs without a
 * network; the default resolves `fetch` at CALL time (never captured at module
 * load), which is also how the credential is read at call time.
 */
export const createGroqSttProvider = (input: {
  env?: GroqSttEnv;
  workspaceId?: string;
  actorId?: string;
  fetchImpl?: typeof fetch;
}): GroqSttProvider => {
  const resolveFetch = (): typeof fetch => input.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  return {
    provider: 'groq',
    available: isGroqSttAvailable(input.env, input.workspaceId, input.actorId),
    transcribe: async (request: SttRequest): Promise<SttOutcome> => {
      const env = input.env;
      if (!isGroqSttAvailable(env, input.workspaceId, input.actorId)) return { state: 'unavailable' };
      // Call-time read: the key is never captured at module load and never logged.
      const apiKey = env?.GROQ_API_KEY?.trim() ?? '';
      const timeoutMs = resolveSttTimeoutMs(env);

      const form = new FormData();
      form.append(
        'file',
        new Blob([request.bytes], { type: request.mime }),
        uploadNameForMime(request.mime),
      );
      form.append('model', resolveSttModel(env));
      form.append('language', GROQ_STT_LANGUAGE);
      form.append('response_format', 'json');
      // Deliberately absent: `prompt` — no financial context, no filename, no
      // conversation summary ever reaches the provider.

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await resolveFetch()(GROQ_STT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          // Never follow a redirect with audio bytes + Authorization in
          // flight: a 3xx (or the opaque redirect the edge produces for
          // 'manual' cross-origin) is a typed provider error below, never a
          // second request to a host the operator never named.
          redirect: 'manual',
          signal: controller.signal,
        });

        // Refuse redirects outright — never followed, never resent off the
        // approved endpoint. Maps to the existing typed provider-error path.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          return { state: 'provider_error' };
        }
        if (response.status === 401 || response.status === 403) return { state: 'unauthorized' };
        if (response.status === 429) return { state: 'rate_limited' };
        if (!response.ok) return { state: 'provider_error' };

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return { state: 'bad_response' };
        }
        const text = (payload as { text?: unknown } | null)?.text;
        if (typeof text !== 'string' || text.trim() === '') return { state: 'bad_response' };
        return { state: 'transcribed', text: clampTranscript(text) };
      } catch {
        // Abort (our timeout) and every transport failure converge here; the
        // caller never sees a raw exception and never sees a partial answer.
        if (controller.signal.aborted) return { state: 'timeout' };
        return { state: 'provider_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

/**
 * Per-turn transcription budget. A plain counter owned by the caller: the
 * registry is built once per turn, so the counter IS the turn's budget and no
 * module-global state can leak across workspaces.
 */
export type AudioSttBudget = { consumed: number };

export const createAudioSttBudget = (): AudioSttBudget => ({ consumed: 0 });

/**
 * The audio processor for the A13 registry.
 *
 * Replaces the `unsupported` entry ONLY when the provider is available. Every
 * other outcome keeps the A13 promise: bytes stay inside this call, the turn
 * receives a state (and, on success, the transcript) — never bytes, never a
 * raw name, never silence.
 */
export const createAudioSttProcessor = (input: {
  provider: GroqSttProvider;
  budget: AudioSttBudget;
}): AttachmentProcessor => {
  return async (processorInput): Promise<AttachmentProcessorResult> => {
    const { record, bytes } = processorInput;
    // Capability off ⇒ the A13 fail-closed entry, byte for byte.
    if (!input.provider.available) return { state: 'unsupported', detail: UNSUPPORTED_DETAIL };

    if (input.budget.consumed >= AUDIO_TRANSCRIPTIONS_PER_TURN) {
      return {
        state: 'skipped_budget',
        detail: 'Só transcrevo um áudio por mensagem. Este ficou para trás.',
      };
    }

    // Server-side ceiling re-checked BEFORE any provider call. The ingest path
    // already rejects oversized uploads; this is the defense-in-depth for an
    // object stored under an older (or tampered) record.
    const maxBytes = ATTACHMENT_LIMITS.audio.maxBytes;
    if (record.size > maxBytes || bytes.byteLength > maxBytes) {
      return {
        state: 'failed',
        detail: 'O áudio excede o limite de tamanho e não foi transcrito.',
      };
    }

    input.budget.consumed += 1;

    const outcome = await input.provider.transcribe({ bytes, mime: record.mime });
    switch (outcome.state) {
      case 'transcribed':
        return {
          state: 'processed',
          detail: 'Áudio transcrito; o texto entrou na mensagem.',
          transcript: outcome.text,
        };
      case 'unavailable':
        return { state: 'unsupported', detail: UNSUPPORTED_DETAIL };
      case 'timeout':
        return {
          state: 'failed',
          detail: 'A transcrição do áudio demorou demais. Sua mensagem foi processada normalmente.',
        };
      case 'unauthorized':
        return {
          state: 'stt_unauthorized',
          detail: 'Não consegui transcrever o áudio (credencial do provedor). Sua mensagem segue normal.',
        };
      case 'rate_limited':
        return {
          state: 'stt_rate_limited',
          detail: 'O provedor de áudio está sobrecarregado. Sua mensagem segue normal.',
        };
      case 'provider_error':
        return {
          state: 'stt_provider_error',
          detail: 'Falha ao transcrever o áudio. Sua mensagem segue normal.',
        };
      case 'bad_response':
        return {
          state: 'stt_bad_response',
          detail: 'O áudio veio sem transcrição legível. Sua mensagem segue normal.',
        };
    }
  };
};

/**
 * Composes the TURN TEXT from the user's own text plus an optional transcript.
 *
 * The transcript is data from an external provider, so it goes through the
 * existing DLP funnel (`scrubForPersistence`) exactly like typed text — a
 * spoken card number is redacted the same way a typed one is. It is wrapped in
 * `AUDIO_TRANSCRIPT_NOTICE`, which (a) keeps the provenance visible in history
 * and (b) makes the composed text structurally ineligible for autoexecution.
 */
export const composeTurnTextWithTranscript = (input: {
  userText: string;
  transcript?: string;
  attachmentPlaceholder?: string;
}): string => {
  const transcript = (input.transcript ?? '').trim();
  const userText = input.userText.trim();
  if (transcript === '') {
    // No transcript: the turn text is exactly what it was before A14.
    if (userText !== '') return scrubForPersistence(userText);
    return input.attachmentPlaceholder ?? '';
  }
  const parts = [AUDIO_TRANSCRIPT_NOTICE];
  if (userText !== '') parts.push(userText);
  parts.push(transcript);
  return scrubForPersistence(parts.join('\n'));
};

/** Convenience: the per-turn registry override, or `undefined` when off. */
export const audioSttProcessorOverride = (
  env: GroqSttEnv | undefined,
  identity?: { workspaceId?: string; actorId?: string },
): AttachmentProcessor | undefined => {
  const provider = createGroqSttProvider({
    env,
    workspaceId: identity?.workspaceId,
    actorId: identity?.actorId,
  });
  if (!provider.available) return undefined;
  return createAudioSttProcessor({ provider, budget: createAudioSttBudget() });
};