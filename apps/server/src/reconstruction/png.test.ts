import {
  MAX_PNG_BASE64_CHARS,
  PNG_DATA_URL_PREFIX,
} from "@architect/contracts";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PNG_BYTES,
  validateReconstructionPng,
} from "./png.js";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function ihdr(width = 1, height = 1) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return chunk("IHDR", data);
}

function png(
  width = 1,
  height = 1,
  middle: Buffer[] = [],
  ending: Buffer[] = [chunk("IEND")],
) {
  return Buffer.concat([SIGNATURE, ihdr(width, height), ...middle, ...ending]);
}

function input(bytes = png()) {
  return {
    imageDataUrl: `${PNG_DATA_URL_PREFIX}${bytes.toString("base64")}`,
    mimeType: "image/png" as const,
  };
}

describe("reconstruction PNG validation", () => {
  it("accepts canonical PNG data and returns only bounded validated facts", () => {
    const bytes = png(4096, 4096);
    expect(validateReconstructionPng(input(bytes))).toEqual({
      imageDataUrl: `${PNG_DATA_URL_PREFIX}${bytes.toString("base64")}`,
      digest: createHash("sha256").update(bytes).digest("hex"),
      width: 4096,
      height: 4096,
    });
  });

  it("accepts exactly five decoded MiB and rejects one byte more", () => {
    const overhead = png(1, 1, [chunk("IDAT")]).byteLength;
    const exact = png(1, 1, [chunk("IDAT", Buffer.alloc(MAX_PNG_BYTES - overhead))]);
    expect(exact.byteLength).toBe(MAX_PNG_BYTES);
    expect(validateReconstructionPng(input(exact)).width).toBe(1);

    const tooLarge = png(1, 1, [chunk("IDAT", Buffer.alloc(MAX_PNG_BYTES - overhead + 1))]);
    expect(() => validateReconstructionPng(input(tooLarge))).toThrowError(
      expect.objectContaining({ code: "INVALID_PNG" }),
    );
  });

  it("rejects encoded input above the ceiling before decoding", () => {
    const decode = vi.fn();
    expect(() => validateReconstructionPng({
      imageDataUrl: `${PNG_DATA_URL_PREFIX}${"A".repeat(MAX_PNG_BASE64_CHARS + 1)}`,
      mimeType: "image/png",
    }, { decode })).toThrowError(expect.objectContaining({ code: "INVALID_PNG" }));
    expect(decode).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported MIME", { ...input(), mimeType: "image/jpeg" }],
    ["wrong prefix", { ...input(), imageDataUrl: "data:image/jpeg;base64,AAAA" }],
    ["malformed base64", { ...input(), imageDataUrl: `${PNG_DATA_URL_PREFIX}A!AA` }],
    ["noncanonical padding", { ...input(), imageDataUrl: `${PNG_DATA_URL_PREFIX}AAAA====` }],
  ])("rejects %s", (_name, value) => {
    expect(() => validateReconstructionPng(value as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_PNG" }),
    );
  });

  it("rejects wrong signature and a non-IHDR first chunk", () => {
    const wrongSignature = png();
    wrongSignature[0] = 0;
    expect(() => validateReconstructionPng(input(wrongSignature))).toThrowError(
      expect.objectContaining({ code: "INVALID_PNG" }),
    );
    expect(() => validateReconstructionPng(input(Buffer.concat([
      SIGNATURE,
      chunk("IDAT"),
      ihdr(),
      chunk("IEND"),
    ])))).toThrowError(expect.objectContaining({ code: "INVALID_PNG" }));
  });

  it("rejects duplicate IHDR, missing IEND, and nonterminal IEND", () => {
    for (const bytes of [
      png(1, 1, [ihdr()]),
      png(1, 1, [], []),
      png(1, 1, [], [chunk("IEND"), chunk("IDAT")]),
    ]) {
      expect(() => validateReconstructionPng(input(bytes))).toThrowError(
        expect.objectContaining({ code: "INVALID_PNG" }),
      );
    }
  });

  it("rejects chunk lengths beyond the decoded buffer", () => {
    const broken = png();
    broken.writeUInt32BE(1024, SIGNATURE.length);
    expect(() => validateReconstructionPng(input(broken))).toThrowError(
      expect.objectContaining({ code: "INVALID_PNG" }),
    );
  });

  it("rejects excessive chunks", () => {
    const bytes = png(1, 1, Array.from({ length: 4_097 }, () => chunk("tEXt")));
    expect(() => validateReconstructionPng(input(bytes))).toThrowError(
      expect.objectContaining({ code: "INVALID_PNG" }),
    );
  });

  it.each([
    [0, 1],
    [1, 0],
    [4097, 1],
    [1, 4097],
  ])("rejects out-of-range dimensions %d×%d", (width, height) => {
    expect(() => validateReconstructionPng(input(png(width, height)))).toThrowError(
      expect.objectContaining({ code: "INVALID_PNG" }),
    );
  });
});
