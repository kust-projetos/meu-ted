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
import { isAudioSttFlagEnabled } from '../../src/multimodal/groq-stt.js';
import { isVisionFlagEnabled } from '../../src/multimodal/groq-vision.js';
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
      expect(parse(null)).toBe(false);
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
