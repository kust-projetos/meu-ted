/**
 * F1 PR-C (issue #107) — prova de config: binding R2 declarado + capability OFF.
 *
 * O PR-C declara o binding `TED_ATTACHMENTS_BUCKET` (bucket
 * `pi-finance-ted-attachments`) em `apps/agent/wrangler.jsonc` SEM ativar a
 * capability: nenhuma env `TED_*` em `vars`, nenhuma coorte, nenhum binding
 * novo além do R2. A prova tem duas pernas:
 *   [config] o manifesto declara exatamente o binding esperado e nada que
 *   ative a capability (o próprio parse deste arquivo já é a checagem de
 *   validade JSON do manifesto);
 *   [elo config→behavior] o nome do binding é lido DO manifesto (sem literal
 *   duplicado) e a rota real de upload com esse binding + flag OFF responde
 *   503 `attachment_upload_disabled` com zero write — o caso (c) da matriz
 *   PR-A (`tests/attachments/upload-gate.test.ts`), agora ancorado no
 *   manifesto de deploy em vez de só no harness.
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

describe("F1 PR-C — binding R2 declarado, capability OFF por construção", () => {
  it("manifesto declara exatamente um r2_buckets (binding + bucket exatos)", () => {
    expect(manifest.r2_buckets).toEqual([
      { binding: "TED_ATTACHMENTS_BUCKET", bucket_name: "pi-finance-ted-attachments" },
    ]);
  });

  it("vars intocadas: só API_ORIGIN, nenhuma env de ativação", () => {
    expect(manifest.vars).toEqual({ API_ORIGIN: "https://api.synkroo.com.br" });
    for (const key of Object.keys(manifest.vars ?? {})) {
      expect(key.startsWith("TED_")).toBe(false);
    }
  });

  it("nenhuma capability nova: sem binding AI, DO único preservado", () => {
    expect(manifest.ai).toBeUndefined();
    expect(manifest.durable_objects?.bindings?.map((b) => b.name)).toEqual([
      "FINANCE_CHAT_AGENT",
    ]);
  });

  it("elo config→behavior: binding do manifesto + flag OFF ⇒ 503 attachment_upload_disabled + zero write (caso (c) PR-A)", async () => {
    expect(typeof declaredBinding).toBe("string");
    const name = declaredBinding as string;
    const { agent, bucket } = createAttachmentTestAgent();
    // O harness instala o bucket sob o nome canônico; o elo é real: se o
    // manifesto divergir do código, `current[name]` é undefined e o denial
    // abaixo vira `attachment_storage_unavailable` (caso (a), não (c)).
    const current = (agent as unknown as { env: Record<string, unknown> }).env;
    const bound = current[name];
    (agent as unknown as { env: Record<string, unknown> }).env = {
      API_ORIGIN: "https://api.synkroo.com.br",
      [name]: bound,
    };
    const env = (agent as unknown as { env: unknown }).env;
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
