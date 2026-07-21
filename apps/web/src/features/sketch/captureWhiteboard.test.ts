import type { Editor, TLShapeId } from "tldraw";
import { describe, expect, it, vi } from "vitest";
import {
  captureWhiteboard,
  EMPTY_WHITEBOARD_PNG_DATA_URL,
} from "./captureWhiteboard.js";

function editorBoundary(
  shapeIds: TLShapeId[],
  imageDataUrl = "data:image/png;base64,iVBORw0KGgo=",
) {
  const toImageDataUrl = vi.fn().mockResolvedValue({
    height: 240,
    url: imageDataUrl,
    width: 320,
  });
  return {
    editor: {
      getCurrentPageShapeIds: () => new Set(shapeIds),
      toImageDataUrl,
    } as unknown as Editor,
    toImageDataUrl,
  };
}

describe("captureWhiteboard", () => {
  it("returns a deterministic valid PNG for an empty document", async () => {
    const { editor, toImageDataUrl } = editorBoundary([]);

    await expect(captureWhiteboard(editor)).resolves.toEqual({
      imageDataUrl: EMPTY_WHITEBOARD_PNG_DATA_URL,
      mimeType: "image/png",
      hasShapes: false,
    });
    expect(EMPTY_WHITEBOARD_PNG_DATA_URL).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(toImageDataUrl).not.toHaveBeenCalled();
  });

  it("exports only current-page shapes through the supported PNG editor API", async () => {
    const shapeIds = ["shape:one", "shape:two"] as TLShapeId[];
    const { editor, toImageDataUrl } = editorBoundary(shapeIds);

    await expect(captureWhiteboard(editor)).resolves.toEqual({
      imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      mimeType: "image/png",
      hasShapes: true,
    });
    expect(toImageDataUrl).toHaveBeenCalledOnce();
    expect(toImageDataUrl).toHaveBeenCalledWith(shapeIds, {
      background: true,
      format: "png",
      padding: 24,
    });
  });

  it("rejects a non-PNG response from the editor boundary", async () => {
    const { editor } = editorBoundary(
      ["shape:one"] as TLShapeId[],
      "data:image/jpeg;base64,/9j/",
    );

    await expect(captureWhiteboard(editor)).rejects.toThrow(
      "Whiteboard export did not produce a PNG image.",
    );
  });

  it.each([
    ["an empty payload", "data:image/png;base64,"],
    ["malformed base64", "data:image/png;base64,iVBORw0KGgo*"],
    ["a truncated base64 group", "data:image/png;base64,iVBORw0KGgo"],
    ["a different file signature", "data:image/png;base64,R0lGODlhAQABAIAAAAUEBA=="],
  ])("rejects %s behind a PNG data URL", async (_label, imageDataUrl) => {
    const { editor } = editorBoundary(
      ["shape:one"] as TLShapeId[],
      imageDataUrl,
    );

    await expect(captureWhiteboard(editor)).rejects.toThrow(
      "Whiteboard export did not produce a PNG image.",
    );
  });
});
