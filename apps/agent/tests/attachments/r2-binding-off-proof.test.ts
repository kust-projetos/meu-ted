/**
 * F1 activation (COD-ACTIVATE-ATTACHMENTS) — prova de config: binding R2
 * declarado + capability de upload ATIVA (flag + coorte geral).
 *
 * O manifesto em `apps/agent/wrangler.jsonc` declara o binding
 * `TED_ATTACHMENTS_BUCKET` (bucket `pi-finance-ted-attachments`) E ativa
 * o upload (`TED_ATTACHMENTS_ENABLED === '1'` + coorte geral `'*'`) MAIS o
 * canary STT (`TED_AUDIO_STT_ENABLED === '1'`, operador 2026-10-08, ZDR ativo)
 * com rollout SEQUENCIADO por coorte (`TED_AUDIO_STT_COHORT` = test workspace,
 * canary restritivo single-workspace — A19-STT-COHORT).
 * Nenhum binding novo além do R2, nenhuma outra env `TED_*` além das listadas
 * no teste de vars. A prova tem
 * duas pernas:
 *   [config] o manifesto declara exatamente o binding esperado e as envs de
 *   ativação no estado real (o próprio parse deste arquivo já é a checagem
 *   de validade JSON do manifesto);
 *   [elo config→behavior] o nome do binding E flag/coorte são lidos DO
 *   manifesto (sem literal duplicado) e a rota real de upload com esse
 *   binding + flag/coorte do manifesto é elegível: `isAttachmentUploadAllowed`
 *   TRUE, `attachmentUploadDenial` null, `POST /rpc/attachments` 200 com
 *   write. A negação por OFF continua provada em `upload-gate.test.ts`
 *   (casos (c)/(d): 503 + zero write).
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

describe("F1 activation manifest — binding R2 declarado, upload ATIVO (flag + coorte geral)", () => {
  it("manifesto declara exatamente um r2_buckets (binding + bucket exatos)", () => {
    expect(manifest.r2_buckets).toEqual([
      { binding: "TED_ATTACHMENTS_BUCKET", bucket_name: "pi-finance-ted-attachments" },
    ]);
  });

  it("vars: upload ativo (flag '1' + coorte '*') + STT canary (flag '1' + coorte = test workspace)", () => {
    expect(manifest.vars).toEqual({
      API_ORIGIN: "https://api.synkroo.com.br",
      TED_ATTACHMENTS_ENABLED: "1",
      TED_ATTACHMENTS_COHORT: "*",
      // A19 STT canary (operador 2026-10-08, ZDR ativo): segunda trava ligada,
      // rollout sequenciado por coorte (A19-STT-COHORT): coorte = test workspace
      // junio (canary restritivo, single workspace). O gate por actor nunca
      // casaria: o token delegado não carrega actorId e o `sub` delegado vive
      // em namespace distinto do session user.id — documentado. Rastrear
      // qualquer nova var TED_* aqui.
      TED_AUDIO_STT_ENABLED: "1",
      TED_AUDIO_STT_COHORT: "d36cb649-4462-486d-940a-47128ad329f2",
    });
    expect(manifest.vars?.TED_ATTACHMENTS_ENABLED).toBe("1");
    expect(manifest.vars?.TED_ATTACHMENTS_COHORT).toBe("*");
    expect(manifest.vars?.TED_AUDIO_STT_ENABLED).toBe("1");
    expect(manifest.vars?.TED_AUDIO_STT_COHORT).toBe("d36cb649-4462-486d-940a-47128ad329f2");
  });

  it("nenhuma capability nova: sem binding AI, DO único preservado", () => {
    expect(manifest.ai).toBeUndefined();
    expect(manifest.durable_objects?.bindings?.map((b) => b.name)).toEqual([
      "FINANCE_CHAT_AGENT",
    ]);
  });

  it("elo config→behavior: binding + flag/coorte do manifesto ⇒ elegível (200 com write)", async () => {
    expect(typeof declaredBinding).toBe("string");
    const name = declaredBinding as string;
    const flag = manifest.vars?.TED_ATTACHMENTS_ENABLED;
    const cohort = manifest.vars?.TED_ATTACHMENTS_COHORT;
    expect(flag).toBe("1");
    expect(cohort).toBe("*");
    const { agent, bucket } = createAttachmentTestAgent();
    // O harness instala o bucket sob o nome canônico; o elo é real: se o
    // manifesto divergir do código, `current[name]` é undefined e o storage
    // abaixo é null (indisponível, não elegível).
    const current = (agent as unknown as { env: Record<string, unknown> }).env;
    const bound = current[name];
    (agent as unknown as { env: Record<string, unknown> }).env = {
      API_ORIGIN: "https://api.synkroo.com.br",
      [name]: bound,
      TED_ATTACHMENTS_ENABLED: flag,
      TED_ATTACHMENTS_COHORT: cohort,
    };
    const env = (agent as unknown as { env: unknown }).env;
    expect(getAttachmentStorage(env)).not.toBeNull();
    expect(isAttachmentUploadAllowed(env, "ws-1", "actor-1")).toBe(true);
    expect(attachmentUploadDenial(env, "ws-1", "actor-1")).toBeNull();
    const res = await agent.fetch(
      uploadRequest(bytesOf(pngBytes(4, 4)), {
        "x-ted-attachment-kind": "image",
        "x-ted-attachment-name": "a.png",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref: string };
    expect(body.ref).toMatch(/^att_/);
    expect(bucket.objects.size).toBe(1);
  });
});
