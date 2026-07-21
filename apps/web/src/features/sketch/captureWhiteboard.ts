import type { Editor } from "tldraw";

export const EMPTY_WHITEBOARD_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export type WhiteboardCapture = {
  imageDataUrl: string;
  mimeType: "image/png";
  hasShapes: boolean;
};

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PNG_CHUNKS = 4_096;
const MIN_STRUCTURED_PNG_BYTES = PNG_SIGNATURE.length + 25 + 12;
const BASE64_PAYLOAD =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function readUint32(bytes: string, offset: number): number {
  return (
    bytes.charCodeAt(offset) * 0x1000000 +
    bytes.charCodeAt(offset + 1) * 0x10000 +
    bytes.charCodeAt(offset + 2) * 0x100 +
    bytes.charCodeAt(offset + 3)
  );
}

function hasValidPngStructure(bytes: string): boolean {
  if (
    bytes.length < MIN_STRUCTURED_PNG_BYTES ||
    !PNG_SIGNATURE.every(
      (expected, index) => bytes.charCodeAt(index) === expected,
    )
  ) {
    return false;
  }

  let offset = PNG_SIGNATURE.length;
  for (let chunkIndex = 0; chunkIndex < MAX_PNG_CHUNKS; chunkIndex += 1) {
    if (offset + 12 > bytes.length) return false;
    const length = readUint32(bytes, offset);
    const type = bytes.slice(offset + 4, offset + 8);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + length + 4;
    if (nextOffset > bytes.length) return false;

    if (chunkIndex === 0) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        readUint32(bytes, dataOffset) === 0 ||
        readUint32(bytes, dataOffset + 4) === 0
      ) {
        return false;
      }
    } else if (type === "IHDR") {
      return false;
    }

    if (type === "IEND") {
      return length === 0 && nextOffset === bytes.length;
    }
    offset = nextOffset;
  }
  return false;
}

function isPngDataUrl(value: string): boolean {
  if (!value.startsWith(PNG_DATA_URL_PREFIX)) return false;
  const payload = value.slice(PNG_DATA_URL_PREFIX.length);
  if (
    payload.length === 0 ||
    payload.length % 4 !== 0 ||
    !BASE64_PAYLOAD.test(payload)
  ) {
    return false;
  }

  let bytes: string;
  try {
    bytes = atob(payload);
  } catch {
    return false;
  }
  return hasValidPngStructure(bytes);
}

export async function captureWhiteboard(
  editor: Editor,
): Promise<WhiteboardCapture> {
  const shapeIds = [...editor.getCurrentPageShapeIds()];
  if (shapeIds.length === 0) {
    return {
      imageDataUrl: EMPTY_WHITEBOARD_PNG_DATA_URL,
      mimeType: "image/png",
      hasShapes: false,
    };
  }

  const image = await editor.toImageDataUrl(shapeIds, {
    background: true,
    format: "png",
    padding: 24,
  });
  if (!isPngDataUrl(image.url)) {
    throw new Error("Whiteboard export did not produce a PNG image.");
  }
  return {
    imageDataUrl: image.url,
    mimeType: "image/png",
    hasShapes: true,
  };
}
