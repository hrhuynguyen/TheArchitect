import type { Editor } from "tldraw";

export const EMPTY_WHITEBOARD_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export type WhiteboardCapture = {
  imageDataUrl: string;
  mimeType: "image/png";
  hasShapes: boolean;
};

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
  if (!image.url.startsWith("data:image/png;base64,")) {
    throw new Error("Whiteboard export did not produce a PNG image.");
  }
  return {
    imageDataUrl: image.url,
    mimeType: "image/png",
    hasShapes: true,
  };
}
