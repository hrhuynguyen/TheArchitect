// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  defaultRequirementsProfile,
} from "@architect/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Y from "yjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GraphEditor } from "./GraphEditor.js";

const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);
const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);
const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
const originalResizeObserver = globalThis.ResizeObserver;
const originalDOMMatrixReadOnly = globalThis.DOMMatrixReadOnly;

class TestDOMMatrixReadOnly {
  readonly m22 = 1;
}

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  disconnect() {}
  observe(target: Element) {
    queueMicrotask(() => this.callback([{
      target,
      contentRect: target.getBoundingClientRect(),
    } as ResizeObserverEntry], this));
  }
  unobserve() {}
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      bottom: 600,
      height: 600,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  };
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", TestDOMMatrixReadOnly);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", TestDOMMatrixReadOnly);
});

afterAll(() => {
  if (originalOffsetWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetWidth",
      originalOffsetWidth,
    );
  }
  if (originalOffsetHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      originalOffsetHeight,
    );
  }
  HTMLElement.prototype.getBoundingClientRect = originalBoundingRect;
  vi.stubGlobal("ResizeObserver", originalResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", originalDOMMatrixReadOnly);
});

const requirements = defaultRequirementsProfile();
const architecture = {
  version: "architecture/v1" as const,
  requirements,
  resources: [{
    id: "bucket",
    type: "S3" as const,
    name: "Uploads",
    properties: {},
    origin: "explicit" as const,
    reason: "The sketch explicitly includes object storage.",
    approvalStatus: "not-required" as const,
  }],
  relationships: [],
  decisions: [],
  unresolvedQuestions: [],
};
const state = {
  architecture: {
    version: "working-architecture/v1" as const,
    revisionId: "revision-a",
    architecture,
  },
  layout: {
    version: "architecture-layout/v1" as const,
    revisionId: "revision-a",
    nodes: [{ resourceId: "bucket", x: 0, y: 0 }],
  },
};

class FakeProvider {
  synced = true;
  on = vi.fn();
  off = vi.fn();
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GraphEditor React Flow keyboard support", () => {
  it("selects, edits, removes, and persists movement using React Flow keyboard events", async () => {
    const document = new Y.Doc();
    document.getMap(ARCHITECTURE_MAP_KEY).set(
      ARCHITECTURE_CURRENT_KEY,
      state.architecture,
    );
    document.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(
      ARCHITECTURE_CURRENT_KEY,
      state.layout,
    );
    const provider = new FakeProvider();
    const fetchBoundary = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/architect/turns") && !init?.method) {
        return response({ turns: [] });
      }
      if (url.endsWith("/revisions") && !init?.method) {
        return response({ revisions: [], events: [] });
      }
      if (url.endsWith("/operations")) {
        const request = JSON.parse(String(init?.body));
        return response({
          ok: true,
          state: {
            architecture: state.architecture,
            layout: request.layout ?? state.layout,
          },
          diagnostics: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const user = userEvent.setup();
    render(<GraphEditor dependencies={{
      createCollaboration: () => ({
        doc: document,
        provider,
        destroy: () => document.destroy(),
      }),
      fetch: fetchBoundary,
    } as never} roomId="room-a" />);

    const node = await screen.findByTestId("rf__node-bucket");
    act(() => node.focus());
    await user.keyboard("{Enter}");

    const nameInput = await screen.findByRole("textbox", {
      name: "Resource name",
    });
    await user.clear(nameInput);
    await user.type(nameInput, "Keyboard uploads");
    const update = screen.getByRole("button", { name: "Update name" });
    act(() => update.focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fetchBoundary.mock.calls.some(([, init]) =>
      JSON.parse(String(init?.body ?? "null"))?.operations?.[0]?.type ===
        "update_resource",
    )).toBe(true));

    act(() => node.focus());
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(fetchBoundary.mock.calls.some(([, init]) => {
      const request = JSON.parse(String(init?.body ?? "null"));
      return request?.operations?.length === 0 &&
        request?.layout?.nodes?.[0]?.resourceId === "bucket" &&
        request.layout.nodes[0].x === 5;
    })).toBe(true));

    const remove = screen.getByRole("button", { name: "Remove resource" });
    act(() => remove.focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fetchBoundary.mock.calls.some(([, init]) =>
      JSON.parse(String(init?.body ?? "null"))?.operations?.[0]?.type ===
        "remove_resource",
    )).toBe(true));
  });
});
