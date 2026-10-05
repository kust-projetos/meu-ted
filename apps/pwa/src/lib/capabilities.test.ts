import { describe, it, expect } from "vitest";
import { getChatAttachmentCapabilities, isMicrophoneEnabled } from "./capabilities";

describe("chatAttachmentCapabilities (SPEC §18)", () => {
  it("defaults to ALL FALSE when the flag is absent", () => {
    expect(getChatAttachmentCapabilities({})).toEqual({
      image: false,
      pdf: false,
      audio: false,
      microphone: false,
    });
  });

  it("defaults to ALL FALSE for any value other than \"1\"", () => {
    for (const value of ["0", "true", "yes", "", "2"]) {
      expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_INGESTION: value })).toEqual({
        image: false,
        pdf: false,
        audio: false,
        microphone: false,
      });
    }
  });

  it("enables ALL capabilities only when the flag is exactly \"1\"", () => {
    expect(
      getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_INGESTION: "1" }),
    ).toEqual({ image: true, pdf: true, audio: true, microphone: false });
  });
});

/**
 * A13/P3 — capability PER TYPE. One flag used to turn image+pdf+audio on
 * together; each type now has its own default-off flag and the legacy flag is
 * kept as a compatibility master.
 */
describe("chatAttachmentCapabilities por tipo (A13/P3)", () => {
  it("cada tipo é default-off quando sua flag própria está ausente", () => {
    expect(getChatAttachmentCapabilities({})).toMatchObject({ image: false, pdf: false, audio: false });
    expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_IMAGE: "1" }))
      .toMatchObject({ image: true, pdf: false, audio: false });
    expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_PDF: "1" }))
      .toMatchObject({ image: false, pdf: true, audio: false });
    expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_AUDIO: "1" }))
      .toMatchObject({ image: false, pdf: false, audio: true });
  });

  it("cada flag só liga o próprio tipo, nunca os vizinhos", () => {
    const env = {
      NEXT_PUBLIC_TED_ATTACHMENT_IMAGE: "1",
      NEXT_PUBLIC_TED_ATTACHMENT_PDF: "1",
      NEXT_PUBLIC_TED_ATTACHMENT_AUDIO: "1",
    };
    expect(getChatAttachmentCapabilities(env)).toMatchObject({ image: true, pdf: true, audio: true });
    expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_PDF: "1", NEXT_PUBLIC_TED_ATTACHMENT_AUDIO: "1" }))
      .toMatchObject({ image: false, pdf: true, audio: true });
  });

  it("valores diferentes de \"1\" mantêm o tipo desligado (fail-closed)", () => {
    for (const value of ["0", "true", "yes", "", "2"]) {
      expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_IMAGE: value }).image).toBe(false);
      expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_PDF: value }).pdf).toBe(false);
      expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_AUDIO: value }).audio).toBe(false);
    }
  });

  it("a flag legada continua sendo mestre: on ⇒ os três tipos ligam (compatibilidade)", () => {
    expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_INGESTION: "1" }))
      .toMatchObject({ image: true, pdf: true, audio: true });
  });

  it("a flag legada off NÃO desliga um tipo ligado pela flag própria (união, não interseção)", () => {
    expect(getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_ATTACHMENT_INGESTION: "0", NEXT_PUBLIC_TED_ATTACHMENT_PDF: "1" }))
      .toMatchObject({ image: false, pdf: true, audio: false });
  });
});

describe("isMicrophoneEnabled (V4 T1.1)", () => {
  it("defaults to false when the flag is absent", () => {
    expect(isMicrophoneEnabled({})).toBe(false);
  });

  it("defaults to false for any value other than \"1\" or \"true\"", () => {
    for (const value of ["0", "yes", "", "2", "TRUE"]) {
      expect(isMicrophoneEnabled({ NEXT_PUBLIC_TED_MICROPHONE: value })).toBe(false);
    }
  });

  it("enables only for exactly \"1\" or \"true\" (deploy sets \"true\")", () => {
    expect(isMicrophoneEnabled({ NEXT_PUBLIC_TED_MICROPHONE: "1" })).toBe(true);
    expect(isMicrophoneEnabled({ NEXT_PUBLIC_TED_MICROPHONE: "true" })).toBe(true);
  });

  it("flows into the shared caps object (UI and header read the same flag)", () => {
    expect(
      getChatAttachmentCapabilities({ NEXT_PUBLIC_TED_MICROPHONE: "true" }).microphone,
    ).toBe(true);
  });
});
