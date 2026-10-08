/**
 * F8 — múltiplos anexos processados: TODOS entram, ou os excedentes são
 * marcados `skipped_budget` ANTES de processá-los.
 *
 * Antes, só o primeiro `transcript` do turno era usado: um PDF enviado junto de
 * uma nota de voz perderia silenciosamente um dos dois. Agora cada outcome
 * aceito entra com sua própria proveniência, e o teto por TIPO é aplicado antes
 * da leitura — um anexo excedente nunca é lido e depois descartado.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAttachmentStorage } from "../../src/attachments/storage.js";
import { ingestAttachment } from "../../src/attachments/ingest.js";
import { bytesOf, createAttachmentTestAgent, installRelayMock } from "./helpers.js";

const IDENTITY = { workspaceId: "ws-1", actorId: "actor-1" };
const PDF_ENV = { TED_PDF_TEXT_ENABLED: "1" } as const;
const STT_ENV = { GROQ_API_KEY: "gsk-test-key", TED_AUDIO_STT_ENABLED: "1", TED_AUDIO_STT_COHORT: "*" } as const;
const VISION_ENV = { GROQ_API_KEY: "gsk-test-key", TED_VISION_ENABLED: "1", TED_VISION_COHORT: "*" } as const;

const chatRequest = (body: unknown): Request =>
  new Request("https://agent.test.local/rpc/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-actor": "actor-1",
      "x-agent-workspace": "ws-1",
    },
    body: JSON.stringify(body),
  });

/** Counts the STT (Groq transcription) and vision (Groq chat) provider calls. */
const installProviderMock = (visionFields: Record<string, unknown>): { sttCalls: RequestInit[]; visionCalls: RequestInit[] } => {
  const sttCalls: RequestInit[] = [];
  const visionCalls: RequestInit[] = [];
  installRelayMock();
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes("api.groq.com/openai/v1/audio/transcriptions")) {
      sttCalls.push(init);
      return Response.json({ text: "TRANSCRICAO-PDF-AUDIO nota de voz" });
    }
    if (url.includes("api.groq.com")) {
      visionCalls.push(init);
      return Response.json({
        choices: [{ message: { content: JSON.stringify(visionFields) } }],
      });
    }
    return previous(input, init);
  }) as unknown as typeof fetch;
  return { sttCalls, visionCalls };
};

const upload = async (
  agent: unknown,
  kind: "pdf" | "audio" | "image",
  name: string,
  bytes: Uint8Array,
): Promise<string> => {
  const storage = getAttachmentStorage((agent as { env: unknown }).env)!;
  const uploaded = await ingestAttachment({
    storage,
    identity: IDENTITY,
    kind,
    name,
    bytes: bytesOf(bytes),
  });
  return uploaded.ref;
};

const webmBytes = (): Uint8Array => {
  const out = new Uint8Array(96);
  out.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  out.set(new TextEncoder().encode("webm"), 32);
  return out;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("F8 — imagem + áudio no mesmo turno: ambos os conteúdos entram", () => {
  it("os DOIS dados extraídos estão no turno, cada um com a sua proveniência", async () => {
    installProviderMock({
      merchant: "Padaria do Bairro",
      date: "2026-10-05",
      amount: "42,50",
      currency: "BRL",
      suggested_category: "unknown",
      confidence: "unknown",
    });
    const { agent, persisted } = createAttachmentTestAgent({
      extraEnv: { ...VISION_ENV, ...STT_ENV },
    });
    const imageRef = await upload(agent, "image", "recibo.png", pngWithMarker());
    const audioRef = await upload(agent, "audio", "nota.webm", webmBytes());

    const res = await agent.fetch(
      chatRequest({
        text: "anota esses dois",
        intentionId: "intent-f8-image-audio",
        attachments: [
          { type: "image", ref: imageRef, name: "recibo.png" },
          { type: "audio", ref: audioRef, name: "nota.webm" },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.map((s) => s.state)).toEqual(["processed", "processed"]);

    const persistedText = JSON.stringify(persisted);
    // BOTH carriers and BOTH contents are present — neither was discarded.
    expect(persistedText).toContain("Padaria do Bairro");
    expect(persistedText).toContain("TRANSCRICAO-PDF-AUDIO");
  });

  it("um SEGUNDO áudio vira skipped_budget ANTES de qualquer chamada ao provider", async () => {
    const { sttCalls } = installProviderMock({});
    const { agent } = createAttachmentTestAgent({ extraEnv: { ...STT_ENV } });
    const first = await upload(agent, "audio", "a1.webm", webmBytes());
    const second = await upload(agent, "audio", "a2.webm", webmBytes());

    const res = await agent.fetch(
      chatRequest({
        text: "anota",
        intentionId: "intent-f8-two-audios",
        attachments: [
          { type: "audio", ref: first, name: "a1.webm" },
          { type: "audio", ref: second, name: "a2.webm" },
        ],
      }),
    );

    const body = (await res.json()) as { attachmentStates?: Array<{ state: string }> };
    expect(body.attachmentStates?.map((s) => s.state)).toEqual(["processed", "skipped_budget"]);
    // The excess attachment was never read: ONE provider call, not two.
    expect(sttCalls).toHaveLength(1);
  });
});

describe("F8 — dois PDFs no mesmo turno", () => {
  it("o excedente é marcado skipped_budget ANTES do parse — nunca lido e depois descartado", async () => {
    installProviderMock({});
    const { agent, persisted } = createAttachmentTestAgent({ extraEnv: { ...PDF_ENV } });
    const first = await upload(agent, "pdf", "nota1.pdf", buildTextLayerPdf(["Mercado Livre ALFA 10,00"]));
    const second = await upload(agent, "pdf", "nota2.pdf", buildTextLayerPdf(["Farmácia BETA 20,00"]));

    const res = await agent.fetch(
      chatRequest({
        text: "anota",
        intentionId: "intent-f8-two-pdfs",
        attachments: [
          { type: "pdf", ref: first, name: "nota1.pdf" },
          { type: "pdf", ref: second, name: "nota2.pdf" },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachmentStates?: Array<{ state: string; detail: string }>;
    };
    // The per-turn work budget is one unit PER TYPE, and it is applied BEFORE
    // the processor runs — the second PDF is never parsed. Its exclusion is
    // EXPLICIT (a named state with a reason), never a silent discard.
    expect(body.attachmentStates?.map((s) => s.state)).toEqual(["processed", "skipped_budget"]);
    expect(body.attachmentStates?.[1]?.detail).toBeTruthy();

    const persistedText = JSON.stringify(persisted);
    expect(persistedText).toContain("Mercado Livre ALFA");
    expect(persistedText).not.toContain("Farmácia BETA");
  });
});

describe("F13 — o `kind` do estado NUNCA vem da claim do cliente", () => {
  it("skipped_budget não rotula um PDF com o tipo que o cliente declarou", async () => {
    installProviderMock({});
    const { agent } = createAttachmentTestAgent({ extraEnv: { ...STT_ENV, ...PDF_ENV } });
    // A REAL audio (declared honestly) spends the per-turn audio budget.
    const audio = await upload(agent, "audio", "nota.webm", webmBytes());
    // A PDF that the client LIES about, declaring `audio`: the budget is spent,
    // so it is skipped. The record was never read, so the reported kind must not
    // be the client's claim.
    const pdf = await upload(agent, "pdf", "nota.pdf", buildTextLayerPdf(["Farmácia BETA 20,00"]));

    const res = await agent.fetch(
      chatRequest({
        text: "anota",
        intentionId: "intent-f13-skipped-kind",
        attachments: [
          { type: "audio", ref: audio, name: "nota.webm" },
          // The client lies: this ref is a PDF.
          { type: "audio", ref: pdf, name: "nota.pdf" },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachmentStates?: Array<{ state: string; kind: string }>;
    };
    expect(body.attachmentStates?.map((s) => s.state)).toEqual(["processed", "skipped_budget"]);
    // Nothing was read ⇒ the server cannot vouch for a kind ⇒ never the claim.
    expect(body.attachmentStates?.[1]?.kind).not.toBe("audio");
    expect(body.attachmentStates?.[1]?.kind).toBe("unknown");
  });
});

const pngWithMarker = (): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 8);
  view.setUint32(20, 8);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
};

/** Byte-accurate minimal PDF writer (valid xref). */
const buildTextLayerPdf = (pages: string[]): Uint8Array => {
  const chunks: Buffer[] = [];
  const offsets = new Map<number, number>();
  let pos = 0;
  const push = (text: string) => {
    const buf = Buffer.from(text, "latin1");
    chunks.push(buf);
    pos += buf.length;
  };
  const addObj = (id: number, body: string) => {
    offsets.set(id, pos);
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.7\n");
  const firstPage = 5;
  addObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ")}] >>`);
  addObj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((page, i) => {
    const contentId = firstPage + i * 2 + 1;
    const pageId = firstPage + i * 2;
    const stream = `BT /F1 12 Tf 72 720 Td (${page}) Tj ET\n`;
    addObj(contentId, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
    addObj(pageId, `<< /Type /Page /Parent 2 0 R /Font << /F1 3 0 R >> /MediaBox [0 0 612 792] /Contents ${contentId} 0 R >>`);
  });
  const xrefStart = pos;
  const maxId = pages.length * 2 + firstPage + 1;
  push(`xref\n0 ${maxId}\n0000000000 65535 f \n`);
  for (let id = 1; id < maxId; id += 1) {
    push(offsets.has(id) ? `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n");
  }
  push(
    `trailer\n<< /Size ${maxId} /Root 1 0 R /ID [<0102030405060708090a0b0c0d0e0f10><0102030405060708090a0b0c0d0e0f10>] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat(chunks));
};