import {
  MAX_PNG_BASE64_CHARS,
  PNG_DATA_URL_PREFIX,
} from "@architect/contracts";
import { createHash } from "node:crypto";

export const MAX_PNG_BYTES = 5 * 1024 * 1024;
export const MAX_PNG_DIMENSION = 4096;
export const MAX_PNG_PIXELS = 16_777_216;
export const MAX_PNG_CHUNKS = 4_096;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHUNK_TYPE = /^[A-Za-z]{4}$/;

export class InvalidPngError extends Error {
  readonly code = "INVALID_PNG" as const;

  constructor() {
    super("A valid bounded PNG image is required.");
    this.name = "InvalidPngError";
  }
}

type PngInput = Readonly<{
  imageDataUrl: string;
  mimeType: string;
}>;

type PngValidationDependencies = Readonly<{
  decode?: (encoded: string) => Uint8Array;
}>;

function invalid(): never {
  throw new InvalidPngError();
}

function hasCanonicalBase64Shape(encoded: string): boolean {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return false;
  const firstPadding = encoded.indexOf("=");
  const contentEnd = firstPadding === -1 ? encoded.length : firstPadding;
  const paddingLength = encoded.length - contentEnd;
  if (paddingLength > 2) return false;
  for (let index = contentEnd; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 61) return false;
  }
  for (let index = 0; index < contentEnd; index += 1) {
    const code = encoded.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  return true;
}

function validateChunks(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.byteLength < PNG_SIGNATURE.byteLength + 25 + 12 ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) invalid();

  let offset = PNG_SIGNATURE.byteLength;
  let chunkCount = 0;
  let sawHeader = false;
  let sawEnd = false;
  let width = 0;
  let height = 0;

  while (offset < bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS || bytes.byteLength - offset < 12) invalid();

    const dataLength = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const chunkEnd = dataStart + dataLength + 4;
    if (chunkEnd > bytes.byteLength || chunkEnd < dataStart) invalid();

    const type = bytes.toString("ascii", typeStart, dataStart);
    if (!CHUNK_TYPE.test(type)) invalid();
    if (chunkCount === 1 && type !== "IHDR") invalid();

    if (type === "IHDR") {
      if (sawHeader || dataLength !== 13) invalid();
      sawHeader = true;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      if (
        width === 0 ||
        height === 0 ||
        width > MAX_PNG_DIMENSION ||
        height > MAX_PNG_DIMENSION ||
        width * height > MAX_PNG_PIXELS
      ) invalid();
    }

    if (type === "IEND") {
      if (dataLength !== 0 || sawEnd || chunkEnd !== bytes.byteLength) invalid();
      sawEnd = true;
    }

    offset = chunkEnd;
  }

  if (!sawHeader || !sawEnd || offset !== bytes.byteLength) invalid();
  return { width, height };
}

export function validateReconstructionPng(
  input: PngInput,
  dependencies: PngValidationDependencies = {},
) {
  if (
    input.mimeType !== "image/png" ||
    typeof input.imageDataUrl !== "string" ||
    !input.imageDataUrl.startsWith(PNG_DATA_URL_PREFIX)
  ) invalid();

  const encoded = input.imageDataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (
    encoded.length === 0 ||
    encoded.length > MAX_PNG_BASE64_CHARS ||
    !hasCanonicalBase64Shape(encoded)
  ) invalid();

  const decoded = dependencies.decode?.(encoded) ?? Buffer.from(encoded, "base64");
  if (decoded.byteLength > MAX_PNG_BYTES) invalid();
  const bytes = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  if (bytes.toString("base64") !== encoded) invalid();
  const dimensions = validateChunks(bytes);

  return Object.freeze({
    imageDataUrl: input.imageDataUrl,
    digest: createHash("sha256").update(bytes).digest("hex"),
    ...dimensions,
  });
}
