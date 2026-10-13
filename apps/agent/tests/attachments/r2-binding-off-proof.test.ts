/**
 * V1-textual (ADENDO V1-TEXTUAL da SPEC, 13/10 — commit 4e46301) — prova de
 * config: binding R2 PRESERVADO + upload/STT/Vision OFF.
 *
 * História: o estado canary anterior (upload ATIVO flag '1' + coorte geral
 * '*', STT canary e Vision canary single-workspace) foi SUBSTITUÍDO pelo
 * adendo de 13/10: texto obrigatório; STT/Vision/PDF/web/autoexec-on ficam
 * pós-V1. O manifesto em `apps/agent/wrangler.jsonc` agora declara o binding
 * `TED_ATTACHMENTS_BUCKET` (bucket `pi-finance-ted-attachments`) PRESERVADO
 * (leituras de refs continuam resolvendo) com o upload DESLIGADO
 * (`TED_ATTACHMENTS_ENABLED === '0'` + coorte `''` = ninguém), STT
 * desligado (`TED_AUDIO_STT_ENABLED === '0'` + coorte `''`), extração local
 * de PDF desligada (`TED_PDF_TEXT_ENABLED === '0'`, P1 fail-closed — o wiring
 * `pdfTextProcessorOverride` devolve `undefined` incondicionalmente) e Vision
 * desligada (`TED_VISION_ENABLED === '0'`, provider/modelo preservados
 * `gemini`/`gemini-2.5-flash` + coorte `''`).
 *
 * Nenhum binding novo além do R2, nenhuma outra env `TED_*` além das listadas
 * no teste de vars. A prova tem duas pernas:
 *   [config] o manifesto declara exatamente o binding esperado e as envs OFF
 *   no estado real (o próprio parse deste arquivo já é a checagem de validade
 *   JSON do manifesto);
 *   [elo config→behavior INVERTIDO] o nome do binding E flag/coorte são
 *   lidos DO manifesto (sem literal duplicado) e a rota real de upload com
 *   esse binding + flag/coorte do manifesto é NEGADA: `getAttachmentStorage`
 *   NÃO-nulo (binding preservado), `isAttachmentUploadAllowed` FALSE,
 *   `attachmentUploadDenial` = `attachment_upload_disabled`, `POST
 *   /rpc/attachments` 503 com bucket vazio (zero write). O caminho elegível
 *   (200 com write) continua provado em `upload-gate.test.ts` caso (e) —
 *   este arquivo prova o denial do estado vigente.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attachmentUploadDenial,
  isAttachmentUploadAllowed,
} from "../../src/attachments/upload-gate.js";
import { getAttachmentStorage } from "../../src/attachments/storage.js";
import { pngBytes } from "./fixtures.js";
import {
  bytesOf,
  createAttachmentTestAgent,
  uploadRequest,
} from "./helpers.js";

type WranglerManifest = {
  vars?: Record<string, string>;
  r2_buckets?: Array<{ binding?: unknown; bucket_name?: unknown }>;
  ai?: unknown;
  durable_objects?: { bindings?: Array<{ name?: unknown }> };
};

const manifest = JSON.parse(
  readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
) as WranglerManifest;

const declaredBinding = (manifest.r2_buckets ?? [])[0]?.binding;

describe("V1-textual manifest — binding R2 preservado, upload/STT/Vision OFF", () => {
  it("manifesto declara exatamente um r2_buckets (binding + bucket exatos, preservado)", () => {
    expect(manifest.r2_buckets).toEqual([
      { binding: "TED_ATTACHMENTS_BUCKET", bucket_name: "pi-finance-ted-attachments" },
    ]);
  });

  it("vars: upload OFF + STT OFF + PDF OFF + Vision OFF (provider/modelo preservados, coortes vazias)", () => {
    expect(manifest.vars).toEqual({
      API_ORIGIN: "https://api.synkroo.com.br",
      TED_ATTACHMENTS_ENABLED: "0",
      TED_ATTACHMENTS_COHORT: "",
      // V1-textual (adendo 13/10): STT pós-V1 — flag + coorte OFF.
      TED_AUDIO_STT_ENABLED: "0",
      TED_AUDIO_STT_COHORT: "",
      // P1 fail-closed (bounded execution pendente): a extração LOCAL da
      // camada de texto (unpdf) segue DESLIGADA no manifesto. A flag não é
      // a única trava: `pdfTextProcessorOverride` devolve `undefined`
      // INCONDICIONALMENTE — um PDF segue o `unsupported` fail-closed da
      // A13 (zero parse, zero bytes lidos).
      TED_PDF_TEXT_ENABLED: "0",
      // V1-textual (adendo 13/10): Vision pós-V1 — flag + coorte OFF;
      // provider `gemini` + modelo `gemini-2.5-flash` PRESERVADOS para
      // reabilitação futura (decisão do operador 2026-10-08).
      // GOOGLE_AI_STUDIO_KEY vive como secret (nunca em vars).
      TED_VISION_ENABLED: "0",
      TED_VISION_PROVIDER: "gemini",
      TED_VISION_MODEL: "gemini-2.5-flash",
      TED_VISION_COHORT: "",
    });
    expect(manifest.vars?.TED_ATTACHMENTS_ENABLED).toBe("0");
    expect(manifest.vars?.TED_ATTACHMENTS_COHORT).toBe("");
    expect(manifest.vars?.TED_AUDIO_STT_ENABLED).toBe("0");
    expect(manifest.vars?.TED_AUDIO_STT_COHORT).toBe("");
    expect(manifest.vars?.TED_PDF_TEXT_ENABLED).toBe("0");
    expect(manifest.vars?.TED_VISION_ENABLED).toBe("0");
    expect(manifest.vars?.TED_VISION_PROVIDER).toBe("gemini");
    expect(manifest.vars?.TED_VISION_MODEL).toBe("gemini-2.5-flash");
    expect(manifest.vars?.TED_VISION_COHORT).toBe("");
  });

  it("nenhuma capability nova: sem binding AI, DO único preservado", () => {
    expect(manifest.ai).toBeUndefined();
    expect(manifest.durable_objects?.bindings?.map((b) => b.name)).toEqual([
      "FINANCE_CHAT_AGENT",
    ]);
  });

  it("elo config→behavior INVERTIDO: binding + flag/coorte do manifesto ⇒ negado (503 + zero write, binding preservado)", async () => {
    expect(typeof declaredBinding).toBe("string");
    const name = declaredBinding as string;
    const flag = manifest.vars?.TED_ATTACHMENTS_ENABLED;
    const cohort = manifest.vars?.TED_ATTACHMENTS_COHORT;
    expect(flag).toBe("0");
    expect(cohort).toBe("");
    const { agent, bucket } = createAttachmentTestAgent();
    // O harness instala o bucket sob o nome canônico; o elo é real: se o
    // manifesto divergir do código, `current[name]` é undefined e o storage
    // abaixo é null (indisponível, não "desativado").
    const current = (agent as unknown as { env: Record<string, unknown> }).env;
    const bound = current[name];
    (agent as unknown as { env: Record<string, unknown> }).env = {
      API_ORIGIN: "https://api.synkroo.com.br",
      [name]: bound,
      TED_ATTACHMENTS_ENABLED: flag,
      TED_ATTACHMENTS_COHORT: cohort,
    };
    const env = (agent as unknown as { env: unknown }).env;
    // Binding PRESERVADO: o storage resolve (leituras de refs intactas) —
    // o que nega é o gate de upload, não a ausência do binding.
    expect(getAttachmentStorage(env)).not.toBeNull();
    expect(isAttachmentUploadAllowed(env, "ws-1", "actor-1")).toBe(false);
    expect(attachmentUploadDenial(env, "ws-1", "actor-1")).toMatchObject({
      code: "attachment_upload_disabled",
      status: 503,
    });
    const req = uploadRequest(bytesOf(pngBytes(4, 4)), {
      "x-ted-attachment-kind": "image",
      "x-ted-attachment-name": "a.png",
    });
    const res = await agent.fetch(req);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      "attachment_upload_disabled",
    );
    expect(bucket.objects.size).toBe(0);
    expect(req.bodyUsed).toBe(false);
  });
});
