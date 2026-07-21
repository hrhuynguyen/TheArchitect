import type { Editor, TLShapeId } from "tldraw";
import { describe, expect, it, vi } from "vitest";
import {
  captureWhiteboard,
  EMPTY_WHITEBOARD_PNG_DATA_URL,
} from "./captureWhiteboard.js";

function editorBoundary(
  shapeIds: TLShapeId[],
  imageDataUrl = EMPTY_WHITEBOARD_PNG_DATA_URL,
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngDataUrl(bytes: number[]): string {
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function pngChunk(
  type: string,
  data: number[],
  declaredLength = data.length,
): number[] {
  return [
    (declaredLength >>> 24) & 0xff,
    (declaredLength >>> 16) & 0xff,
    (declaredLength >>> 8) & 0xff,
    declaredLength & 0xff,
    ...[...type].map((character) => character.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

function ihdr(width = 1, height = 1): number[] {
  return pngChunk("IHDR", [
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    8,
    6,
    0,
    0,
    0,
  ]);
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
      imageDataUrl: EMPTY_WHITEBOARD_PNG_DATA_URL,
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
    ["a signature-only payload", "data:image/png;base64,iVBORw0KGgo="],
    [
      "a non-IHDR first chunk",
      pngDataUrl([...PNG_SIGNATURE, ...pngChunk("IEND", [])]),
    ],
    [
      "an invalid IHDR length",
      pngDataUrl([
        ...PNG_SIGNATURE,
        ...pngChunk("IHDR", new Array<number>(12).fill(0)),
        ...pngChunk("IEND", []),
      ]),
    ],
    [
      "zero-width IHDR data",
      pngDataUrl([
        ...PNG_SIGNATURE,
        ...ihdr(0, 1),
        ...pngChunk("IEND", []),
      ]),
    ],
    [
      "a missing IEND chunk",
      pngDataUrl([...PNG_SIGNATURE, ...ihdr()]),
    ],
    [
      "an out-of-bounds chunk",
      pngDataUrl([
        ...PNG_SIGNATURE,
        ...ihdr(),
        ...pngChunk("IDAT", [1, 2], 10),
      ]),
    ],
    [
      "excessive chunk traversal",
      pngDataUrl([
        ...PNG_SIGNATURE,
        ...ihdr(),
        ...Array.from({ length: 4_097 }, () => pngChunk("tEXt", [])).flat(),
        ...pngChunk("IEND", []),
      ]),
    ],
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
