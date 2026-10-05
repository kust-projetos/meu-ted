import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_TTL_MS,
  isAttachmentError,
  type AttachmentErrorCode,
} from "../../src/attachments/types.js";
import {
  cleanupExpiredAttachments,
  ingestAttachment,
  resolveAttachmentRef,
  sha256Hex,
  sniffAttachmentMediaType,
} from "../../src/attachments/ingest.js";
import { createMemoryAttachmentStorage, type AttachmentStorage } from "../../src/attachments/storage.js";
import {
  flacBytes,
  isobmffBytes,
  jpegBytes,
  mp3Bytes,
  mpgaBytes,
  mpegVideoBytes,
  oggBytes,
  pdfBytes,
  pngBytes,
  scriptBytes,
  wavBytes,
  webmBytes,
} from "./fixtures.js";

const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const expectedSha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const IDENTITY = { workspaceId: "ws-1", actorId: "actor-1" } as const;

/** Asserts the call failed with the exact typed code (never a bare Error). */
const expectCode = async (promise: Promise<unknown>, code: AttachmentErrorCode): Promise<void> => {
  try {
    await promise;
    throw new Error(`expected ${code} but the call resolved`);
  } catch (error) {
    expect(isAttachmentError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
  }
};

describe("A13/AC21 — magic-byte sniffing (sem dependência nova)", () => {
  it("reconhece PNG e JPEG e devolve a família correta", () => {
    expect(sniffAttachmentMediaType(pngBytes(10, 10))).toMatchObject({ family: "image", mime: "image/png" });
    expect(sniffAttachmentMediaType(jpegBytes(10, 10))).toMatchObject({ family: "image", mime: "image/jpeg" });
  });

  it("reconhece PDF, áudio e recusa vídeo/script/desconhecido", () => {
    expect(sniffAttachmentMediaType(pdfBytes())).toMatchObject({ family: "pdf", mime: "application/pdf" });
    for (const bytes of [webmBytes(), oggBytes(), wavBytes(), flacBytes(), mp3Bytes(), mpgaBytes()]) {
      expect(sniffAttachmentMediaType(bytes)?.family).toBe("audio");
    }
    // MP4/M4A is a container: recognised as media, but never as a V1 kind.
    expect(sniffAttachmentMediaType(isobmffBytes("M4A "))).toMatchObject({ family: "media-container" });
    expect(sniffAttachmentMediaType(mpegVideoBytes())).toMatchObject({ family: "media-container" });
    // Um script NÃO é mídia: nunca entra.
    expect(sniffAttachmentMediaType(scriptBytes())).toBeNull();
    expect(sniffAttachmentMediaType(new Uint8Array(0))).toBeNull();
  });

  it("MP4 genérico (ftyp) e MPEG de vídeo não são aceitos como áudio", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "audio",
        name: "video.mp4",
        bytes: bytesOf(isobmffBytes("isom")),
      }),
      "attachment_mime_mismatch",
    );
    expect(await storage.listByExpiry(Number.MAX_SAFE_INTEGER, 100)).toHaveLength(0);
  });
});

describe("A13/AC21 — validação de ingestão fail-closed", () => {
  it("recusa kind fora da allowlist (image|pdf|audio)", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "video" as never,
        name: "x.webm",
        bytes: bytesOf(webmBytes()),
      }),
      "attachment_unsupported_kind",
    );
  });

  it("recusa corpo vazio", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      ingestAttachment({ storage, identity: IDENTITY, kind: "pdf", name: "vazio.pdf", bytes: bytesOf(new Uint8Array(0)) }),
      "attachment_bad_request",
    );
  });

  it("declarado ≠ real: PDF declarado como imagem é rejeitado (MIME falso)", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "image",
        name: "falso.png",
        bytes: bytesOf(pdfBytes()),
      }),
      "attachment_mime_mismatch",
    );
  });

  it("declarado ≠ real: áudio declarado mas PNG enviado é rejeitado", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "audio",
        name: "falso.webm",
        bytes: bytesOf(pngBytes(4, 4)),
      }),
      "attachment_mime_mismatch",
    );
  });

  it("script com kind 'image' é rejeitado como MIME falso (nada executa)", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "image",
        name: "payload.png",
        bytes: bytesOf(scriptBytes()),
      }),
      "attachment_mime_mismatch",
    );
    expect(await storage.listByExpiry(Number.MAX_SAFE_INTEGER, 100)).toHaveLength(0);
  });

  it("oversized: excede o teto do tipo e nada é gravado", async () => {
    const storage = createMemoryAttachmentStorage();
    const tooBig = pngBytes(4, 4);
    const oversized = new Uint8Array(ATTACHMENT_LIMITS.image.maxBytes + 1);
    oversized.set(tooBig.subarray(0, 33), 0);
    await expectCode(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "image",
        name: "grande.png",
        bytes: bytesOf(oversized),
      }),
      "attachment_too_large",
    );
    expect(await storage.listByExpiry(Number.MAX_SAFE_INTEGER, 100)).toHaveLength(0);
  });

  it("decompression bomb: PNG minúsculo com dimensões absurdas é rejeitado ANTES de decodificar", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "image",
        name: "bomba.png",
        bytes: bytesOf(pngBytes(30_000, 30_000)),
      }),
      "attachment_dimensions_exceeded",
    );
    expect(await storage.listByExpiry(Number.MAX_SAFE_INTEGER, 100)).toHaveLength(0);
  });

  it("JPEG com dimensões absurdas também é rejeitado pelo header SOF", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "image",
        name: "bomba.jpg",
        bytes: bytesOf(jpegBytes(50_000, 50_000)),
      }),
      "attachment_dimensions_exceeded",
    );
  });

  it("PDF com versão de header acima do limite é rejeitado", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "pdf",
        name: "futuro.pdf",
        bytes: bytesOf(pdfBytes(9, 9)),
      }),
      "attachment_pdf_version_unsupported",
    );
  });
});

describe("A13 — resultado do upload é referência opaca, sem URL nem caminho", () => {
  it("devolve {ref,kind,name,size,expiresAt} e guarda o sha256 do conteúdo", async () => {
    const storage = createMemoryAttachmentStorage();
    const bytes = pngBytes(12, 8);
    const now = 1_700_000_000_000;
    const uploaded = await ingestAttachment({
      storage,
      identity: IDENTITY,
      kind: "image",
      name: "comprovante.png",
      bytes: bytesOf(bytes),
      now,
    });

    expect(uploaded.ref).toMatch(/^att_[A-Za-z0-9_-]{16,}$/);
    expect(uploaded.kind).toBe("image");
    expect(uploaded.name).toBe("comprovante.png");
    expect(uploaded.size).toBe(bytes.byteLength);
    expect(uploaded.expiresAt).toBe(now + ATTACHMENT_TTL_MS);
    // Nenhum byte, URL pública ou caminho local atravessa a resposta.
    const serialized = JSON.stringify(uploaded);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("data:");
    expect(serialized).not.toContain("/tmp");
    expect(Object.keys(uploaded).sort()).toEqual(["expiresAt", "kind", "name", "ref", "size"]);

    const stored = await storage.get(uploaded.ref);
    expect(stored?.record.sha256).toBe(expectedSha(bytes));
    expect(stored?.record.workspaceId).toBe("ws-1");
    expect(stored?.record.actorId).toBe("actor-1");
  });

  it("sha256 do conteúdo bate com o hash independente", async () => {
    const bytes = pdfBytes();
    expect(await sha256Hex(bytesOf(bytes))).toBe(expectedSha(bytes));
  });
});

describe("A13 — idempotência de upload por (workspace, actor, sha256)", () => {
  it("mesmo conteúdo do mesmo ator devolve o MESMO ref e não duplica objeto", async () => {
    const storage = createMemoryAttachmentStorage();
    const bytes = bytesOf(pngBytes(6, 6));
    const first = await ingestAttachment({ storage, identity: IDENTITY, kind: "image", name: "a.png", bytes });
    const second = await ingestAttachment({ storage, identity: IDENTITY, kind: "image", name: "b.png", bytes });

    expect(second.ref).toBe(first.ref);
    expect(await storage.listByExpiry(Number.MAX_SAFE_INTEGER, 100)).toHaveLength(1);
  });

  it("conteúdo diferente, ator diferente ou workspace diferente NUNCA colide", async () => {
    const storage = createMemoryAttachmentStorage();
    const base = await ingestAttachment({
      storage, identity: IDENTITY, kind: "image", name: "a.png", bytes: bytesOf(pngBytes(6, 6)),
    });
    const otherActor = await ingestAttachment({
      storage, identity: { workspaceId: "ws-1", actorId: "actor-2" }, kind: "image", name: "a.png", bytes: bytesOf(pngBytes(6, 6)),
    });
    const otherWorkspace = await ingestAttachment({
      storage, identity: { workspaceId: "ws-2", actorId: "actor-1" }, kind: "image", name: "a.png", bytes: bytesOf(pngBytes(6, 6)),
    });
    const otherContent = await ingestAttachment({
      storage, identity: IDENTITY, kind: "image", name: "a.png", bytes: bytesOf(pngBytes(7, 6)),
    });
    const refs = new Set([base.ref, otherActor.ref, otherWorkspace.ref, otherContent.ref]);
    expect(refs.size).toBe(4);
  });
});

describe("A13/AC21 — leitura mediada: posse, expiração e isolamento", () => {
  it("outro workspace NÃO consegue ler o anexo de outro workspace", async () => {
    const storage = createMemoryAttachmentStorage();
    const uploaded = await ingestAttachment({
      storage, identity: IDENTITY, kind: "image", name: "a.png", bytes: bytesOf(pngBytes(6, 6)),
    });
    await expectCode(
      resolveAttachmentRef({
        storage,
        identity: { workspaceId: "ws-2", actorId: "actor-1" },
        ref: uploaded.ref,
        expectedKind: "image",
      }),
      "attachment_not_found",
    );
    await expectCode(
      resolveAttachmentRef({
        storage,
        identity: { workspaceId: "ws-1", actorId: "actor-2" },
        ref: uploaded.ref,
        expectedKind: "image",
      }),
      "attachment_not_found",
    );
  });

  it("ref expirado é rejeitado e some do estado de posse", async () => {
    const storage = createMemoryAttachmentStorage();
    const now = 1_700_000_000_000;
    const uploaded = await ingestAttachment({
      storage, identity: IDENTITY, kind: "pdf", name: "a.pdf", bytes: bytesOf(pdfBytes()), now,
    });
    await expectCode(
      resolveAttachmentRef({
        storage,
        identity: IDENTITY,
        ref: uploaded.ref,
        expectedKind: "pdf",
        now: now + ATTACHMENT_TTL_MS + 1,
      }),
      "attachment_expired",
    );
  });

  it("kind incompatível com a referência é rejeitado", async () => {
    const storage = createMemoryAttachmentStorage();
    const uploaded = await ingestAttachment({
      storage, identity: IDENTITY, kind: "image", name: "a.png", bytes: bytesOf(pngBytes(6, 6)),
    });
    await expectCode(
      resolveAttachmentRef({ storage, identity: IDENTITY, ref: uploaded.ref, expectedKind: "pdf" }),
      "attachment_kind_mismatch",
    );
  });

  it("ref malformado é rejeitado sem tocar o storage", async () => {
    const storage = createMemoryAttachmentStorage();
    await expectCode(
      resolveAttachmentRef({ storage, identity: IDENTITY, ref: "../../etc/passwd", expectedKind: "image" }),
      "attachment_bad_request",
    );
    await expectCode(
      resolveAttachmentRef({ storage, identity: IDENTITY, ref: "att_short", expectedKind: "image" }),
      "attachment_bad_request",
    );
  });

  it("ref válido resolve bytes apenas para o dono (workspace+actor)", async () => {
    const storage = createMemoryAttachmentStorage();
    const bytes = pngBytes(9, 9);
    const uploaded = await ingestAttachment({
      storage, identity: IDENTITY, kind: "image", name: "a.png", bytes: bytesOf(bytes),
    });
    const resolved = await resolveAttachmentRef({
      storage, identity: IDENTITY, ref: uploaded.ref, expectedKind: "image",
    });
    expect(resolved.record.ref).toBe(uploaded.ref);
    expect(new Uint8Array(resolved.bytes)).toEqual(bytes);
  });
});

describe("A13 — expiração/cleanup idempotente", () => {
  it("varre apenas expirados, é idempotente e nunca lança para o caller", async () => {
    const storage: AttachmentStorage = createMemoryAttachmentStorage();
    const now = 1_700_000_000_000;
    const live = await ingestAttachment({
      storage, identity: IDENTITY, kind: "image", name: "vivo.png", bytes: bytesOf(pngBytes(6, 6)), now,
    });
    const doomed = await ingestAttachment({
      storage, identity: IDENTITY, kind: "image", name: "morto.png", bytes: bytesOf(pngBytes(7, 7)), now: now - ATTACHMENT_TTL_MS * 2,
    });

    const first = await cleanupExpiredAttachments(storage, now);
    expect(first).toEqual({ scanned: 1, deleted: 1, failed: false });
    // Idempotente: a segunda varredura não encontra nada e não lança.
    expect(await cleanupExpiredAttachments(storage, now)).toEqual({ scanned: 0, deleted: 0, failed: false });
    expect(await storage.get(live.ref)).not.toBeNull();
    expect(await storage.get(doomed.ref)).toBeNull();

    // Best-effort: uma falha de storage NÃO escapa para o caller.
    const broken: AttachmentStorage = {
      ...createMemoryAttachmentStorage(),
      listByExpiry: async () => { throw new Error("r2 down"); },
      delete: async () => { throw new Error("r2 down"); },
    };
    await expect(cleanupExpiredAttachments(broken, now)).resolves.toEqual({ scanned: 0, deleted: 0, failed: true });
  });

  it("o upload também dispara a varredura barata (best-effort)", async () => {
    const storage = createMemoryAttachmentStorage();
    const now = 1_700_000_000_000;
    const doomed = await ingestAttachment({
      storage, identity: IDENTITY, kind: "image", name: "morto.png", bytes: bytesOf(pngBytes(7, 7)), now: now - ATTACHMENT_TTL_MS * 2,
    });
    const fresh = await ingestAttachment({
      storage, identity: IDENTITY, kind: "image", name: "novo.png", bytes: bytesOf(pngBytes(8, 8)), now,
    });
    expect(await storage.get(doomed.ref)).toBeNull();
    expect(await storage.get(fresh.ref)).not.toBeNull();
  });
});
