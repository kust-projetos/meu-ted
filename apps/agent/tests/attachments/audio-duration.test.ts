/**
 * F10 — teto de DURAÇÃO de áudio, no que é honesto sem demuxer.
 *
 * Um teto de BYTES não é um teto de tempo: 20 MB de Opus duram ~17 min, 20 MB
 * de WAV duram ~10 min. O que dá para fazer sem demuxer um container comprimido:
 *
 * - **WAV**: a duração é EXATA e barata — `dataSize / byteRate` no header
 *   RIFF. Um áudio acima do teto é recusado com um motivo honesto.
 * - **demais formatos**: não há duração confiável sem demuxer (ogg/webm/flac/
 *   mp3 carregam bitrate variável). A decisão conservadora é reduzir o teto de
 *   BYTES padrão de áudio (20 MB → 10 MB ≈ ~10 min a 128 kbps) e DOCUMENTAR o
 *   residual, em vez de inventar uma duração que o container não garante.
 */

import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS } from "../../src/attachments/types.js";
import { createMemoryAttachmentStorage } from "../../src/attachments/storage.js";
import { ingestAttachment, readWavDurationSeconds } from "../../src/attachments/ingest.js";
import { flacBytes, oggBytes, webmBytes, wavBytesWithDuration } from "./fixtures.js";

const IDENTITY = { workspaceId: "ws-1", actorId: "actor-1" } as const;
const bytesOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

describe("F10 — WAV: duração exata do header e recusa acima do teto", () => {
  it("a duração é lida do header (byteRate/dataSize), sem decodificar o áudio", () => {
    expect(readWavDurationSeconds(wavBytesWithDuration(60))).toBeCloseTo(60, 3);
    expect(readWavDurationSeconds(wavBytesWithDuration(300))).toBeCloseTo(300, 3);
  });

  it("header WAV ilegível ⇒ duração desconhecida (nunca um número inventado)", () => {
    expect(readWavDurationSeconds(new Uint8Array(0))).toBeNull();
    expect(readWavDurationSeconds(new TextEncoder().encode("nao e um wav"))).toBeNull();
  });

  it("WAV de 300 s é RECUSADO na ingestão com código tipado", async () => {
    const storage = createMemoryAttachmentStorage();
    await expect(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "audio",
        name: "longa.wav",
        bytes: bytesOf(wavBytesWithDuration(300)),
      }),
    ).rejects.toMatchObject({ code: "attachment_audio_too_long" });
    expect(await storage.listByExpiry(Number.MAX_SAFE_INTEGER, 100)).toHaveLength(0);
  });

  it("WAV de 60 s é aceito (o teto não é um veto indiscriminado)", async () => {
    const storage = createMemoryAttachmentStorage();
    const uploaded = await ingestAttachment({
      storage,
      identity: IDENTITY,
      kind: "audio",
      name: "curta.wav",
      bytes: bytesOf(wavBytesWithDuration(60)),
    });
    expect(uploaded.kind).toBe("audio");
    expect(uploaded.ref).toMatch(/^att_/);
  });

  it("o limite do teto está exposto e é o mesmo usado na recusa", () => {
    expect(ATTACHMENT_LIMITS.audio.maxDurationSeconds).toBe(120);
  });
});

describe("F10 — formatos comprimidos: teto de bytes reduzido (residual documentado)", () => {
  it("o teto default de áudio caiu de 20 MB para 10 MB", () => {
    // ~10 min a 128 kbps. A duração exata continua indeterminável sem demuxer
    // — é o residual aceito e documentado em apps/agent/AGENTS.md.
    expect(ATTACHMENT_LIMITS.audio.maxBytes).toBe(10 * 1024 * 1024);
  });

  it("áudio acima do novo teto é recusado antes de qualquer gravação", async () => {
    const storage = createMemoryAttachmentStorage();
    const oversized = new Uint8Array(ATTACHMENT_LIMITS.audio.maxBytes + 1);
    oversized.set(webmBytes(), 0);
    await expect(
      ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "audio",
        name: "grande.webm",
        bytes: bytesOf(oversized),
      }),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
    expect(await storage.listByExpiry(Number.MAX_SAFE_INTEGER, 100)).toHaveLength(0);
  });

  it("formatos comprimidos comuns continuam aceitos dentro do teto", async () => {
    const storage = createMemoryAttachmentStorage();
    for (const [name, bytes] of [
      ["nota.webm", webmBytes()],
      ["nota.ogg", oggBytes()],
      ["nota.flac", flacBytes()],
    ] as const) {
      const uploaded = await ingestAttachment({
        storage,
        identity: IDENTITY,
        kind: "audio",
        name,
        bytes: bytesOf(bytes),
      });
      expect(uploaded.kind).toBe("audio");
    }
  });
});