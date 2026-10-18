/**
 * T12f / AGT-02 — matriz de valores inválidos das flags do Agent.
 *
 * Contrato (plano §T12f): valor exato fail-closed é intencional para
 * capacidades de egress; NÃO aplicar trim universal. As famílias divergem
 * DE PROPÓSITO:
 * - com trim (`pdf`, `stt`, `vision`): `' 1 '` é ON;
 * - estritas (`upload`, `web_search`, `private_views`): whitespace nega.
 *
 * Este teste fixa a matriz para que uma "normalização global" futura quebre
 * aqui antes de alargar qualquer egress em produção. Só TESTE: nenhuma
 * semântica de produção muda nesta fatia.
 */

import { describe, expect, it, vi } from 'vitest';
import { isUploadFlagEnabled } from '../../src/attachments/upload-gate.js';
import { isPdfTextEnabled } from '../../src/multimodal/pdf-text.js';
import {
  GROQ_STT_DEFAULT_MODEL,
  GROQ_STT_DEFAULT_TIMEOUT_MS,
  isAudioSttFlagEnabled,
  resolveSttModel,
  resolveSttTimeoutMs,
} from '../../src/multimodal/groq-stt.js';
import {
  GROQ_VISION_DEFAULT_TIMEOUT_MS,
  isVisionFlagEnabled,
  resolveVisionTimeoutMs,
} from '../../src/multimodal/groq-vision.js';
import {
  GEMINI_VISION_DEFAULT_TIMEOUT_MS,
  resolveGeminiVisionTimeoutMs,
} from '../../src/multimodal/gemini-vision.js';
import { isPrivateViewsEnabled } from '../../src/privacy/conversation-visibility.js';
import { createWebSearchProvider } from '../../src/agent-config/web.js';

const TRIMMED_FLAGS = {
  'TED_PDF_TEXT_ENABLED': isPdfTextEnabled,
  'TED_AUDIO_STT_ENABLED': isAudioSttFlagEnabled,
  'TED_VISION_ENABLED': isVisionFlagEnabled,
} as const;

const STRICT_FLAGS = {
  'TED_ATTACHMENTS_ENABLED': isUploadFlagEnabled,
  'TED_PRIVATE_VIEWS_ENABLED': isPrivateViewsEnabled,
} as const;

const OFF_VALUES = ['0', 'true', 'TRUE', 'yes', 'on', '01', '1.0', '', '  ', ' 0 ', '00', '2'] as const;

describe('T12f — famílias com trim: só "1" aparado liga', () => {
  for (const [name, parse] of Object.entries(TRIMMED_FLAGS)) {
    it(`${name}: exato '1' e aparado ligam; resto desliga`, () => {
      for (const on of ['1', ' 1 ', '1\n', '\t1\t']) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(parse({ [name]: on } as any), `${name}=${JSON.stringify(on)}`).toBe(true);
      }
      for (const off of OFF_VALUES) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(parse({ [name]: off } as any), `${name}=${JSON.stringify(off)}`).toBe(false);
      }
    });

    it(`${name}: ausente/não-string nunca liga e nunca lança (fail-closed total)`, () => {
      expect(parse(undefined)).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(parse(null as any)).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(parse('não-objeto' as any)).toBe(false);
      for (const bad of [1, true, {}, [], 0] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(parse({ [name]: bad } as any), `${name}=${String(bad)}`).toBe(false);
      }
    });
  }
});

describe('T12f — famílias estritas: whitespace NEGA (sem trim universal)', () => {
  for (const [name, parse] of Object.entries(STRICT_FLAGS)) {
    it(`${name}: só '1' exato liga; ' 1 ' desliga de propósito`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(parse({ [name]: '1' } as any)).toBe(true);
      for (const off of [' 1', '1 ', ' 1 ', '1\n', '\t1\t', ...OFF_VALUES]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(parse({ [name]: off } as any), `${name}=${JSON.stringify(off)}`).toBe(false);
      }
    });

    it(`${name}: ausente/não-string nunca liga e nunca lança`, () => {
      expect(parse(undefined)).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(parse({ [name]: 1 } as any)).toBe(false);
    });
  }

  it("TED_WEB_SEARCH_ENABLED: só '1' exato com key habilita; ' 1 ' com key continua disabled", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('egress nunca alcançado com flag inválida');
    });
    for (const off of [' 1', '1 ', ' 1 ', '0', 'true', '', 'yes', 'on']) {
      const provider = createWebSearchProvider(
        { TAVILY_API_KEY: 'tv-test', TED_WEB_SEARCH_ENABLED: off },
        fetchMock as unknown as typeof fetch,
      );
      expect(provider.available, `flag=${JSON.stringify(off)}`).toBe(false);
      expect(provider.name, `flag=${JSON.stringify(off)}`).toBe('disabled');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const on = createWebSearchProvider(
      { TAVILY_API_KEY: 'tv-test', TED_WEB_SEARCH_ENABLED: '1' },
      fetchMock as unknown as typeof fetch,
    );
    expect(on.available).toBe(true);
  });
});

describe('T12f — seletor de modelo STT: fora da allowlist volta ao default (nunca desliga; string inválida nunca lança)', () => {
  it("TED_AUDIO_STT_MODEL: desconhecido/vazio/ausente (string) ⇒ default 'whisper-large-v3-turbo'", () => {
    for (const bad of ['gpt-4o', 'whisper-large', 'WHISPER-LARGE-V3-TURBO', '', '   ', '1']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(resolveSttModel({ TED_AUDIO_STT_MODEL: bad } as any), JSON.stringify(bad)).toBe(
        GROQ_STT_DEFAULT_MODEL,
      );
    }
    expect(resolveSttModel({})).toBe(GROQ_STT_DEFAULT_MODEL);
    expect(resolveSttModel(undefined)).toBe(GROQ_STT_DEFAULT_MODEL);
    // Não-string (ex.: número) fora do tipo `GroqSttEnv`: o acesso a `.trim()`
    // lança hoje — fora do contrato tipado, sem pin aqui e sem mudança de source.
    expect(GROQ_STT_DEFAULT_MODEL).toBe('whisper-large-v3-turbo');
  });

  it('TED_AUDIO_STT_MODEL: os 2 deployments da allowlist passam (aparado), sem fallback de rede', () => {
    for (const ok of ['whisper-large-v3-turbo', 'whisper-large-v3', '  whisper-large-v3  ']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(resolveSttModel({ TED_AUDIO_STT_MODEL: ok } as any), JSON.stringify(ok)).toBe(
        (ok as string).trim(),
      );
    }
  });
});

describe('T12f — timeouts: conversão + trunc + clamp 1–120000 ms (nunca desligam, nunca lançam)', () => {
  const CASES = [
    { resolve: resolveSttTimeoutMs, key: 'TED_AUDIO_STT_TIMEOUT_MS', fallback: GROQ_STT_DEFAULT_TIMEOUT_MS },
    { resolve: resolveVisionTimeoutMs, key: 'TED_VISION_TIMEOUT_MS', fallback: GROQ_VISION_DEFAULT_TIMEOUT_MS },
    { resolve: resolveGeminiVisionTimeoutMs, key: 'TED_VISION_TIMEOUT_MS', fallback: GEMINI_VISION_DEFAULT_TIMEOUT_MS },
  ] as const;

  it('não-numérico/ausente/Infinity ⇒ default do serviço', () => {
    for (const { resolve, key, fallback } of CASES) {
      for (const bad of ['abc', 'NaN', 'Infinity', '12ms', '--5']) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(resolve({ [key]: bad } as any), `${key}=${JSON.stringify(bad)}`).toBe(fallback);
      }
      expect(resolve({}), `${key} ausente`).toBe(fallback);
      expect(resolve(undefined), `${key} env ausente`).toBe(fallback);
    }
  });

  it("vazio ⇒ 1 ms (Number('') é 0, finito, clampado ao piso — NÃO é default)", () => {
    for (const { resolve, key } of CASES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(resolve({ [key]: '' } as any), key).toBe(1);
    }
  });

  it('finito fora da banda ⇒ clamp: ≤0 vira 1, >120000 vira 120000; frações truncam', () => {
    for (const { resolve, key } of CASES) {
      const at = (v: string) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolve({ [key]: v } as any);
      expect(at('0'), key).toBe(1);
      expect(at('-5'), key).toBe(1);
      expect(at('-0.5'), key).toBe(1);
      expect(at('0.9'), key).toBe(1);
      expect(at('120001'), key).toBe(120_000);
      expect(at('999999999'), key).toBe(120_000);
      expect(at('12.9'), `${key} trunca`).toBe(12);
      expect(at('1'), `${key} piso exato`).toBe(1);
      expect(at('120000'), `${key} teto exato`).toBe(120_000);
      expect(at('5000'), `${key} meio da banda`).toBe(5000);
      expect(at('  5000  '), `${key} com whitespace numérico`).toBe(5000);
    }
  });

  it('defaults divergem por serviço: STT 20 s, visões 30 s', () => {
    expect(GROQ_STT_DEFAULT_TIMEOUT_MS).toBe(20_000);
    expect(GROQ_VISION_DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(GEMINI_VISION_DEFAULT_TIMEOUT_MS).toBe(30_000);
  });
});
