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
const BASE64_PAYLOAD =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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
  return PNG_SIGNATURE.every(
    (expected, index) => bytes.charCodeAt(index) === expected,
  );
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
