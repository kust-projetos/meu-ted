/**
 * F1 PR-A (issue #107) — gate server-side do upload de attachments.
 *
 * Matriz zero-write (todas via o `POST /rpc/attachments` REAL do DO):
 *   (a) sem binding + flag OFF → 503 `attachment_storage_unavailable`;
 *   (b) sem binding + flag ON (+coorte) → 503 `attachment_storage_unavailable`;
 *   (c) com binding + flag OFF → 503 `attachment_upload_disabled` + zero write;
 *   (d) com binding + flag ON + fora da coorte → 503 + zero write;
 *   (e) com binding + flag ON + na coorte → elegível (segue o fluxo existente).
 *
 * Convenção de env: trava exata `=== '1'`, default-off fail-closed; coorte
 * vazia/ausente = ninguém (fail-closed). O gate é SÓ do RPC de upload — os
 * turnos LLM (`selectRolloutCohort`) seguem intactos.
 */

import { describe, expect, it } from "vitest";
import { selectRolloutCohort } from "../../src/llm/rollout.js";
import {
  attachmentUploadDenial,
  isAttachmentUploadAllowed,
  isAttachmentUploadCohortMember,
} from "../../src/attachments/upload-gate.js";
import { pngBytes } from "./fixtures.js";
import {
  bytesOf,
  createAttachmentTestAgent,
  createFakeBucket,
  uploadRequest,
} from "./helpers.js";

const KIND_HEADER = "x-ted-attachment-kind";
const NAME_HEADER = "x-ted-attachment-name";

const ENABLED = { TED_ATTACHMENTS_ENABLED: "1" };
const COHORT_WS_ACTOR = { TED_ATTACHMENTS_COHORT: "ws-1,actor-1" };
const COHORT_OTHER = { TED_ATTACHMENTS_COHORT: "ws-other,actor-other" };

const uploadPng = (extraHeaders: Record<string, string> = {}) =>
  uploadRequest(bytesOf(pngBytes(4, 4)), {
    [KIND_HEADER]: "image",
    [NAME_HEADER]: "a.png",
    ...extraHeaders,
  });

describe("F1 PR-A — matriz zero-write do gate de upload (rota real do DO)", () => {
  it("(a) sem binding + flag OFF → 503 attachment_storage_unavailable", async () => {
    const { agent, bucket } = createAttachmentTestAgent({ withBucket: false });
    const req = uploadPng();
    const res = await agent.fetch(req);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      "attachment_storage_unavailable",
    );
    expect(bucket.objects.size).toBe(0);
    expect(req.bodyUsed).toBe(false);
  });

  it("(b) sem binding + flag ON (+coorte) → 503 attachment_storage_unavailable (fail-closed)", async () => {
    const { agent, bucket } = createAttachmentTestAgent({
      withBucket: false,
      extraEnv: { ...ENABLED, ...COHORT_WS_ACTOR },
    });
    const req = uploadPng();
    const res = await agent.fetch(req);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      "attachment_storage_unavailable",
    );
    expect(bucket.objects.size).toBe(0);
    expect(req.bodyUsed).toBe(false);
  });

  it("(c) com binding + flag OFF → 503 attachment_upload_disabled + zero write", async () => {
    const { agent, bucket } = createAttachmentTestAgent();
    const req = uploadPng();
    const res = await agent.fetch(req);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      "attachment_upload_disabled",
    );
    expect(bucket.objects.size).toBe(0);
    expect(req.bodyUsed).toBe(false);
  });

  it("(d) com binding + flag ON + fora da coorte → 503 attachment_upload_disabled + zero write", async () => {
    const { agent, bucket } = createAttachmentTestAgent({
      extraEnv: { ...ENABLED, ...COHORT_OTHER },
    });
    const req = uploadPng();
    const res = await agent.fetch(req);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      "attachment_upload_disabled",
    );
    expect(bucket.objects.size).toBe(0);
    expect(req.bodyUsed).toBe(false);
  });

  it("(e) com binding + flag ON + na coorte → elegível (segue o fluxo existente, 200)", async () => {
    const { agent, bucket } = createAttachmentTestAgent({
      extraEnv: { ...ENABLED, ...COHORT_WS_ACTOR },
    });
    const res = await agent.fetch(uploadPng());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref: string };
    expect(body.ref).toMatch(/^att_/);
    expect(bucket.objects.size).toBe(1);
  });

  it("coorte por actor sozinho também elege (workspace fora, actor dentro)", async () => {
    const { agent } = createAttachmentTestAgent({
      extraEnv: { ...ENABLED, TED_ATTACHMENTS_COHORT: "actor-1" },
    });
    const res = await agent.fetch(uploadPng());
    expect(res.status).toBe(200);
  });

  it("curinga '*' elege qualquer workspace/actor (decisão do operador: rollout geral)", async () => {
    const { agent, bucket } = createAttachmentTestAgent({
      extraEnv: { ...ENABLED, TED_ATTACHMENTS_COHORT: "*" },
    });
    const res = await agent.fetch(uploadPng());
    expect(res.status).toBe(200);
    expect(bucket.objects.size).toBe(1);
  });
});

describe("F1 PR-A — unidade do gate (sem I/O)", () => {
  it("trava estrita: só '1' habilita; whitespace/'true'/'yes'/'0'/ausente negam", () => {
    const bucket = createFakeBucket().bucket;
    expect(
      isAttachmentUploadAllowed(
        {
          TED_ATTACHMENTS_BUCKET: bucket,
          TED_ATTACHMENTS_ENABLED: "1",
          TED_ATTACHMENTS_COHORT: "ws-1",
        },
        "ws-1",
        "actor-1",
      ),
    ).toBe(true);
    for (const flag of [
      undefined,
      "",
      "0",
      "true",
      "yes",
      "on",
      " 1",
      "1 ",
      "1\n",
      "\t1\t",
    ]) {
      expect(
        isAttachmentUploadAllowed(
          {
            TED_ATTACHMENTS_BUCKET: bucket,
            TED_ATTACHMENTS_COHORT: "ws-1",
            ...(flag === undefined ? {} : { TED_ATTACHMENTS_ENABLED: flag }),
          },
          "ws-1",
          "actor-1",
        ),
        `flag=${String(flag)}`,
      ).toBe(false);
    }
  });

  it("coorte vazia/ausente = ninguém (fail-closed), mesmo com flag ON + binding", () => {
    const bucket = createFakeBucket().bucket;
    for (const cohort of [undefined, "", "  ,  "]) {
      const env =
        cohort === undefined
          ? { TED_ATTACHMENTS_BUCKET: bucket, TED_ATTACHMENTS_ENABLED: "1" }
          : {
              TED_ATTACHMENTS_BUCKET: bucket,
              TED_ATTACHMENTS_ENABLED: "1",
              TED_ATTACHMENTS_COHORT: cohort,
            };
      expect(
        isAttachmentUploadCohortMember(env, "ws-1", "actor-1"),
        `cohort=${String(cohort)}`,
      ).toBe(false);
      expect(isAttachmentUploadAllowed(env, "ws-1", "actor-1")).toBe(false);
      expect(attachmentUploadDenial(env, "ws-1", "actor-1")).toMatchObject({
        code: "attachment_upload_disabled",
        status: 503,
      });
    }
  });

  it("sem binding o denial é storage_unavailable mesmo com flag ON + coorte", () => {
    expect(
      attachmentUploadDenial(
        { TED_ATTACHMENTS_ENABLED: "1", TED_ATTACHMENTS_COHORT: "ws-1" },
        "ws-1",
        "actor-1",
      ),
    ).toMatchObject({ code: "attachment_storage_unavailable", status: 503 });
  });

  it("membro da coorte casa por workspace OU actor; estranho nega; '*' casa com todos", () => {
    const env = { TED_ATTACHMENTS_COHORT: " ws-a ,actor-b " };
    expect(isAttachmentUploadCohortMember(env, "ws-a", "actor-x")).toBe(true);
    expect(isAttachmentUploadCohortMember(env, "ws-x", "actor-b")).toBe(true);
    expect(isAttachmentUploadCohortMember(env, "ws-x", "actor-x")).toBe(false);
    expect(isAttachmentUploadCohortMember({ TED_ATTACHMENTS_COHORT: "*" }, "ws-x", "actor-x")).toBe(true);
    expect(isAttachmentUploadCohortMember({ TED_ATTACHMENTS_COHORT: "*, ws-a" }, "ws-x", "actor-x")).toBe(true);
  });

  it("turnos LLM intactos: selectRolloutCohort comporta-se como antes", () => {
    expect(
      selectRolloutCohort({
        mode: "all",
        percentage: 0,
        allowlist: [],
        workspaceId: "w",
        actorId: "a",
        intentionId: "i",
      }),
    ).toBe(true);
    expect(
      selectRolloutCohort({
        mode: "canary",
        percentage: 0,
        allowlist: ["w"],
        workspaceId: "w",
        actorId: "a",
        intentionId: "i",
      }),
    ).toBe(true);
    expect(
      selectRolloutCohort({
        mode: "canary",
        percentage: 0,
        allowlist: [],
        workspaceId: "w",
        actorId: "a",
        intentionId: "i",
      }),
    ).toBe(false);
  });
});
