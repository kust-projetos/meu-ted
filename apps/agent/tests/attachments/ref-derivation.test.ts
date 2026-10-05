/**
 * F11/F12 — provenance of the opaque attachment ref.
 *
 * Two properties, both structural rather than cosmetic:
 *
 * - **F11 (domain separation)**: the HMAC input ALWAYS carries the domain tag
 *   (`ted-attachments-v1`), on the keyed path AND on the fallback path. Without
 *   it, a signature produced for another purpose over the same tuple is
 *   indistinguishable from a real ref — the classic cross-protocol reuse.
 *   The ref is asserted here against an INDEPENDENT HMAC computation, so the
 *   domain tag is proven by the bytes, not by a comment.
 * - **F12 (no literal NUL in source)**: `ingest.ts` and `pdf-text.ts` used to
 *   embed raw `0x00` bytes inside string/regex literals (they were only legible
 *   through a shell dump). They are now `\u0000` / `\x00` escapes, and this
 *   test keeps the source tree text-only.
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryAttachmentStorage } from "../../src/attachments/storage.js";
import {
  ingestAttachment,
  resolveAttachmentRef,
  sha256Hex,
} from "../../src/attachments/ingest.js";
import type { PdfExtractOutcome, PdfTextExtractor } from "../../src/multimodal/pdf-text.js";
import { pngBytes } from "./fixtures.js";

const IDENTITY = { workspaceId: "ws-1", actorId: "actor-1" } as const;
const SECRET = "attachment-ref-hmac-secret-for-tests";
const OTHER_SECRET = "a-completely-different-attachment-secret";

const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const base64Url = (bytes: Buffer): string =>
  bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const uploadWith = async (secret: string | undefined, bytes = pngBytes(6, 6)) => {
  const storage = createMemoryAttachmentStorage();
  const uploaded = await ingestAttachment({
    storage,
    identity: IDENTITY,
    kind: "image",
    name: "comprovante.png",
    bytes: bytesOf(bytes),
    ...(secret !== undefined ? { refSecret: secret } : {}),
  });
  return { storage, uploaded };
};

describe("F11 — o ref carrega o DOMÍNIO na entrada do HMAC (separação entre domínios)", () => {
  it("o ref com segredo é exatamente HMAC(secret, 'ted-attachments-v1\\0ws\\0actor\\0sha256')", async () => {
    const bytes = pngBytes(9, 9);
    const { uploaded } = await uploadWith(SECRET, bytes);
    const sha256 = await sha256Hex(bytesOf(bytes));

    // Independent computation: the domain tag is PROVEN by the digest, and the
    // separator is NUL so no field boundary can be forged by moving characters
    // between identity parts.
    const payload = `ted-attachments-v1\u0000${IDENTITY.workspaceId}\u0000${IDENTITY.actorId}\u0000${sha256}`;
    const expected = `att_${base64Url(createHmac("sha256", SECRET).update(payload, "utf8").digest())}`;

    expect(uploaded.ref).toBe(expected);
  });

  it("o ref SEM segredo também carrega o domínio (fallback não é caminho sem separação)", async () => {
    const bytes = pngBytes(4, 4);
    const { uploaded } = await uploadWith(undefined, bytes);
    const sha256 = await sha256Hex(bytesOf(bytes));
    const payload = `ted-attachments-v1\u0000${IDENTITY.workspaceId}\u0000${IDENTITY.actorId}\u0000${sha256}`;
    // The unkeyed fallback is a plain SHA-256 over the SAME domain-tagged
    // payload, so it is domain-separated as well.
    const expected = `att_${createHash("sha256").update(payload, "utf8").digest("base64url")}`;

    expect(uploaded.ref).toBe(expected);
  });

  it("segredos diferentes ⇒ refs diferentes (o segredo entra na assinatura)", async () => {
    const a = await uploadWith(SECRET);
    const b = await uploadWith(OTHER_SECRET);
    expect(b.uploaded.ref).not.toBe(a.uploaded.ref);
  });

  it("uma assinatura de OUTRO domínio não resolve como ref (reuso cross-protocol recusado)", async () => {
    const bytes = pngBytes(7, 7);
    const sha256 = await sha256Hex(bytesOf(bytes));
    const { storage } = await uploadWith(SECRET, bytes);

    // Same secret, same tuple — but signed under a DIFFERENT domain tag (what a
    // future/foreign feature sharing the secret would produce).
    const foreign = `att_${base64Url(
      createHmac("sha256", SECRET)
        .update(`some-other-domain-v1\u0000${IDENTITY.workspaceId}\u0000${IDENTITY.actorId}\u0000${sha256}`, "utf8")
        .digest(),
    )}`;

    await expect(
      resolveAttachmentRef({ storage, identity: IDENTITY, ref: foreign, expectedKind: "image" }),
    ).rejects.toMatchObject({ code: "attachment_not_found" });
  });

  it("identidades diferentes nunca colidem mesmo com o mesmo segredo e o mesmo conteúdo", async () => {
    const bytes = pngBytes(6, 6);
    const storage = createMemoryAttachmentStorage();
    const refs = new Set<string>();
    for (const identity of [
      { workspaceId: "ws-1", actorId: "actor-1" },
      { workspaceId: "ws-1", actorId: "actor-2" },
      { workspaceId: "ws-2", actorId: "actor-1" },
    ]) {
      const uploaded = await ingestAttachment({
        storage,
        identity,
        kind: "image",
        name: "a.png",
        bytes: bytesOf(bytes),
        refSecret: SECRET,
      });
      refs.add(uploaded.ref);
    }
    expect(refs.size).toBe(3);
  });

  it("uma identidade com o separador de campo é recusada antes de qualquer assinatura", async () => {
    // The NUL separator is only a defence in depth; the identity guard is the
    // first line. A tuple that tries to smuggle the separator through the
    // workspace never reaches the HMAC and never produces a ref.
    const storage = createMemoryAttachmentStorage();
    await expect(
      ingestAttachment({
        storage,
        identity: { workspaceId: `ws-1\u0000actor-2`, actorId: "" },
        kind: "image",
        name: "a.png",
        bytes: bytesOf(pngBytes(6, 6)),
        refSecret: SECRET,
      }),
    ).rejects.toMatchObject({ code: "attachment_bad_request" });
    expect(await storage.listByExpiry(Number.MAX_SAFE_INTEGER, 100)).toHaveLength(0);
  });
});

describe("F12 — nenhum byte NUL literal no código-fonte (escapes, não bytes crus)", () => {
  const SOURCES = [
    "src/attachments/ingest.ts",
    "src/attachments/processors.ts",
    "src/attachments/storage.ts",
    "src/attachments/types.ts",
    "src/multimodal/pdf-text.ts",
    "src/multimodal/groq-stt.ts",
    "src/multimodal/groq-vision.ts",
  ];

  it("os módulos de anexo/multimodal são texto puro (0x00 só via escape)", () => {
    for (const relative of SOURCES) {
      const bytes = readFileSync(new URL(`../../${relative}`, import.meta.url));
      expect(
        bytes.includes(0x00),
        `${relative} contém um byte NUL literal — use \\u0000/\\x00`,
      ).toBe(false);
    }
  });

  it("a limpeza de página do PDF remove NUL por ESCAPE (o comportamento continua o mesmo)", async () => {
    // Regression pin for the rewritten regex: the NUL bytes inside extracted
    // page text are still stripped, and they are stripped because of the
    // `\x00` escape rather than a raw byte in the source.
    const { createPdfTextProcessor } = await import("../../src/multimodal/pdf-text.js");
    const { createMemoryAttachmentStorage } = await import("../../src/attachments/storage.js");
    const { createAttachmentProcessingMemo, processAttachmentOnce } = await import(
      "../../src/attachments/processors.js"
    );
    const { pdfBytes } = await import("./fixtures.js");

    const extractor: PdfTextExtractor = async (): Promise<PdfExtractOutcome> => ({
      state: "ok",
      pages: ["alfa\u0000 beta\u0000"],
      pageCount: 1,
    });
    const storage = createMemoryAttachmentStorage();
    const uploaded = await ingestAttachment({
      storage,
      identity: IDENTITY,
      kind: "pdf",
      name: "a.pdf",
      bytes: bytesOf(pdfBytes()),
    });
    const processor = createPdfTextProcessor({ extractor, timeoutMs: 1_000 });
    const outcome = await processAttachmentOnce({
      storage,
      registry: { supports: () => true, isReady: () => true, run: (_k, input) => processor(input) },
      identity: IDENTITY,
      ref: uploaded.ref,
      turnId: "turn-nul",
      memo: createAttachmentProcessingMemo(),
    });

    expect(outcome.state).toBe("processed");
    expect(outcome.transcript).toBe("alfa beta");
    expect(outcome.transcript).not.toContain("\u0000");
  });
});