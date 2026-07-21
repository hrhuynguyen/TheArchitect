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
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MiniMap: () => null,
  Position: { Left: "left", Right: "right" },
  ReactFlow: ({ nodes, onNodeClick, onNodesChange }: any) => (
    <section aria-label="Architecture graph">
      {nodes.map((node: any) => (
        <button
          key={node.id}
          onClick={() => onNodeClick?.({}, node)}
          type="button"
        >
          {node.data.resource.name}
        </button>
      ))}
      <button
        onClick={() => onNodesChange?.([{
          id: nodes[0].id,
          type: "position",
          position: { x: 40, y: 80 },
          dragging: false,
        }])}
        type="button"
      >
        Simulate node move
      </button>
    </section>
  ),
}));

import { GraphEditor } from "./GraphEditor.js";

afterEach(cleanup);

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
const initialState = {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const doc = new Y.Doc();
  doc.getMap(ARCHITECTURE_MAP_KEY).set(
    ARCHITECTURE_CURRENT_KEY,
    initialState.architecture,
  );
  doc.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(
    ARCHITECTURE_CURRENT_KEY,
    initialState.layout,
  );
  const provider = new FakeProvider();
  const destroy = vi.fn(() => doc.destroy());
  const fetchBoundary = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/revisions") && !init?.method) {
      return response({ revisions: [], events: [] });
    }
    if (url.endsWith("/operations")) {
      const request = JSON.parse(String(init?.body));
      return response({
        ok: true,
        state: {
          architecture: initialState.architecture,
          layout: request.layout ?? initialState.layout,
        },
        diagnostics: [],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return {
    dependencies: {
      createCollaboration: () => ({ doc, provider, destroy }),
      createId: () => "queue",
      fetch: fetchBoundary,
    },
    destroy,
    doc,
    fetchBoundary,
  };
}

describe("GraphEditor", () => {
  it("renders the protected Yjs graph and persists a layout-only node drag", async () => {
    const test = setup();
    const user = userEvent.setup();
    const view = render(
      <GraphEditor dependencies={test.dependencies as never} roomId="room-a" />,
    );

    expect(await screen.findByText("Uploads")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Simulate node move" }));

    await waitFor(() => expect(test.fetchBoundary).toHaveBeenCalledWith(
      "/api/rooms/room-a/operations",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    ));
    const operationCall = test.fetchBoundary.mock.calls.find(([url]) =>
      url.endsWith("/operations"),
    );
    expect(JSON.parse(String(operationCall?.[1]?.body))).toEqual({
      baseRevisionId: "revision-a",
      operations: [],
      layout: {
        version: "architecture-layout/v1",
        revisionId: "revision-a",
        nodes: [{ resourceId: "bucket", x: 40, y: 80 }],
      },
    });

    view.unmount();
    expect(test.destroy).toHaveBeenCalledOnce();
  });

  it("submits an explicit allowlisted resource from the palette", async () => {
    const test = setup();
    const user = userEvent.setup();
    render(<GraphEditor dependencies={test.dependencies as never} roomId="room-a" />);

    await screen.findByText("Uploads");
    await user.click(screen.getByRole("button", { name: "Add Amazon SQS" }));
    await waitFor(() => expect(test.fetchBoundary.mock.calls.some(([url]) =>
      url.endsWith("/operations"),
    )).toBe(true));
    const operationCall = test.fetchBoundary.mock.calls.find(([url]) =>
      url.endsWith("/operations"),
    );
    expect(JSON.parse(String(operationCall?.[1]?.body))).toMatchObject({
      baseRevisionId: "revision-a",
      operations: [{
        type: "add_resource",
        resource: {
          id: "queue",
          type: "SQS",
          origin: "explicit",
          approvalStatus: "not-required",
        },
      }],
    });
    expect(JSON.parse(String(operationCall?.[1]?.body))).not.toHaveProperty(
      "layout",
    );
  });

  it("shows a bounded public error and remains usable after an invalid response", async () => {
    const test = setup();
    test.fetchBoundary.mockImplementationOnce(async () => response({ secret: "no" }));
    render(<GraphEditor dependencies={test.dependencies as never} roomId="room-a" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Architecture history returned an invalid response.",
    );
    await act(async () => {
      test.doc.getMap(ARCHITECTURE_MAP_KEY).set(
        ARCHITECTURE_CURRENT_KEY,
        initialState.architecture,
      );
    });
    expect(screen.getByText("Uploads")).toBeVisible();
  });

  it("does not let an older HTTP operation response overwrite newer Yjs state", async () => {
    const test = setup();
    const operationResponse = deferred<Response>();
    test.fetchBoundary.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/revisions") && !init?.method) {
        return response({ revisions: [], events: [] });
      }
      if (url.endsWith("/operations")) return operationResponse.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<GraphEditor dependencies={test.dependencies as never} roomId="room-a" />);

    await user.click(await screen.findByRole("button", { name: "Uploads" }));
    const input = screen.getByRole("textbox", { name: "Resource name" });
    await user.clear(input);
    await user.type(input, "HTTP older");
    await user.click(screen.getByRole("button", { name: "Update name" }));
    await waitFor(() => expect(test.fetchBoundary.mock.calls.some(([url]) =>
      url.endsWith("/operations"),
    )).toBe(true));

    const websocketState = {
      ...initialState.architecture,
      architecture: {
        ...architecture,
        resources: [{ ...architecture.resources[0]!, name: "WebSocket newer" }],
      },
    };
    act(() => {
      test.doc.getMap(ARCHITECTURE_MAP_KEY).set(
        ARCHITECTURE_CURRENT_KEY,
        websocketState,
      );
    });
    expect(screen.getByRole("button", { name: "WebSocket newer" })).toBeVisible();

    operationResponse.resolve(response({
      ok: true,
      state: {
        architecture: {
          ...initialState.architecture,
          architecture: {
            ...architecture,
            resources: [{ ...architecture.resources[0]!, name: "HTTP older" }],
          },
        },
        layout: initialState.layout,
      },
      diagnostics: [],
    }));

    await waitFor(() => expect(screen.queryByRole("button", {
      name: "HTTP older",
    })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "WebSocket newer" })).toBeVisible();
  });

  it("does not let an older revision response overwrite newer Yjs state", async () => {
    const test = setup();
    const saveResponse = deferred<Response>();
    test.fetchBoundary.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/revisions") && init?.method === "POST") {
        return saveResponse.promise;
      }
      if (url.endsWith("/revisions") && !init?.method) {
        return response({ revisions: [], events: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<GraphEditor dependencies={test.dependencies as never} roomId="room-a" />);

    await screen.findByRole("button", { name: "Uploads" });
    await user.type(
      screen.getByRole("textbox", { name: "Rationale" }),
      "Preserve this revision.",
    );
    await user.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(test.fetchBoundary.mock.calls.some(
      ([url, init]) => url.endsWith("/revisions") && init?.method === "POST",
    )).toBe(true));

    const websocketArchitecture = {
      ...initialState.architecture,
      revisionId: "revision-c",
      architecture: {
        ...architecture,
        resources: [{ ...architecture.resources[0]!, name: "WebSocket newest" }],
      },
    };
    act(() => {
      test.doc.getMap(ARCHITECTURE_MAP_KEY).set(
        ARCHITECTURE_CURRENT_KEY,
        websocketArchitecture,
      );
      test.doc.getMap(ARCHITECTURE_LAYOUT_MAP_KEY).set(
        ARCHITECTURE_CURRENT_KEY,
        { ...initialState.layout, revisionId: "revision-c" },
      );
    });

    saveResponse.resolve(response({
      revision: {
        id: "revision-b",
        roomId: "room-a",
        version: 2,
        architecture: {
          ...architecture,
          resources: [{ ...architecture.resources[0]!, name: "HTTP saved" }],
        },
        layout: { ...initialState.layout, revisionId: "revision-b" },
        requirements,
        stage: "prototype",
        authorType: "participant",
        authorId: "participant-a",
        rationale: "Preserve this revision.",
        createdAt: "2026-07-21T12:00:00.000Z",
      },
      event: {
        id: "event-b",
        roomId: "room-a",
        kind: "architecture_revision_saved",
        status: "succeeded",
        actorType: "participant",
        actorId: "participant-a",
        title: "Architecture revision saved",
        summary: "Preserve this revision.",
        details: {
          revisionId: "revision-b",
          baseRevisionId: "revision-a",
          version: 2,
        },
        traceId: "request-a",
        createdAt: "2026-07-21T12:00:00.000Z",
      },
    }, 201));

    await waitFor(() => expect(
      screen.getByRole("textbox", { name: "Rationale" }),
    ).toHaveValue(""));
    expect(screen.queryByRole("button", { name: "HTTP saved" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "WebSocket newest" })).toBeVisible();
  });
});
