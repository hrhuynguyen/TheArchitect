"use client";

import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ArchitectureOperationResponseSchema,
  ReconstructionYjsStateSchema,
  RevisionHistoryResponseSchema,
  SaveRevisionResponseSchema,
  type ApprovalStatus,
  type ArchitectureOperationRequest,
  type AwsResourceType,
  type GraphOperation,
  type ReconstructionYjsState,
  type RevisionHistoryResponse,
} from "@architect/contracts";
import { Button } from "@architect/ui";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type * as Y from "yjs";

import { createRoomCollab } from "../workspace/collab";
import {
  applyLayoutChange,
  layoutFromNodes,
  toReactFlowGraph,
  type ArchitectureNode,
} from "./graphAdapter";
import { ProvenanceBadge } from "./ProvenanceBadge";
import {
  ResourcePalette,
  RESOURCE_LABELS,
} from "./ResourcePalette";
import { RevisionHistory } from "./RevisionHistory";
import { UpgradeReviewPanel } from "./UpgradeReviewPanel";

type FetchBoundary = (input: string, init?: RequestInit) => Promise<Response>;

type GraphEditorDependencies = Readonly<{
  createCollaboration?: typeof createRoomCollab;
  createId?: () => string;
  fetch?: FetchBoundary;
}>;

type GraphEditorProps = Readonly<{
  dependencies?: GraphEditorDependencies;
  roomId: string;
}>;

type EditorLoadState =
  | Readonly<{ status: "connecting" }>
  | Readonly<{ status: "ready"; state: ReconstructionYjsState }>
  | Readonly<{ status: "error"; message: string }>;

const EMPTY_DEPENDENCIES: GraphEditorDependencies = Object.freeze({});
const EMPTY_HISTORY: RevisionHistoryResponse = Object.freeze({
  revisions: [],
  events: [],
});
const defaultFetch: FetchBoundary = (input, init) => globalThis.fetch(input, init);

class PublicEditorError extends Error {}

function ArchitectureNodeView({ data }: NodeProps<ArchitectureNode>) {
  return (
    <article className="architecture-node">
      <Handle position={Position.Left} type="target" />
      <span className="architecture-node__type">{data.resource.type}</span>
      <strong>{data.resource.name}</strong>
      <ProvenanceBadge
        origin={data.resource.origin}
        reason={data.resource.reason}
      />
      <Handle position={Position.Right} type="source" />
    </article>
  );
}

const NODE_TYPES = { architecture: ArchitectureNodeView } as const;

function stateFromDocument(document: Y.Doc): ReconstructionYjsState | null {
  const parsed = ReconstructionYjsStateSchema.safeParse({
    architecture: document
      .getMap(ARCHITECTURE_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
    layout: document
      .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
  });
  return parsed.success ? parsed.data : null;
}

async function jsonBody(response: Response, message: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PublicEditorError(message);
  }
}

export function GraphEditor({
  dependencies = EMPTY_DEPENDENCIES,
  roomId,
}: GraphEditorProps) {
  const createCollaboration = dependencies.createCollaboration ?? createRoomCollab;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  const fetchBoundary = dependencies.fetch ?? defaultFetch;
  const [editor, setEditor] = useState<EditorLoadState>({ status: "connecting" });
  const [history, setHistory] = useState<RevisionHistoryResponse>(EMPTY_HISTORY);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<string | null>(null);
  const [revisionRationale, setRevisionRationale] = useState("");
  const [resourceName, setResourceName] = useState("");

  const refreshHistory = useCallback(async () => {
    let response: Response;
    try {
      response = await fetchBoundary(
        `/api/rooms/${encodeURIComponent(roomId)}/revisions`,
        { credentials: "same-origin" },
      );
    } catch {
      throw new PublicEditorError("Architecture history could not be reached.");
    }
    const body = await jsonBody(
      response,
      "Architecture history returned an invalid response.",
    );
    if (!response.ok) {
      throw new PublicEditorError("Architecture history could not be loaded.");
    }
    const parsed = RevisionHistoryResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new PublicEditorError("Architecture history returned an invalid response.");
    }
    setHistory(parsed.data);
  }, [fetchBoundary, roomId]);

  useEffect(() => {
    let active = true;
    let collaboration: ReturnType<typeof createRoomCollab>;
    setEditor({ status: "connecting" });
    setRequestError(null);
    try {
      collaboration = createCollaboration({ roomId });
    } catch {
      setEditor({
        status: "error",
        message: "Shared architecture connection is unavailable.",
      });
      return;
    }
    const syncState = () => {
      if (!active) return;
      const next = stateFromDocument(collaboration.doc);
      if (next) setEditor({ status: "ready", state: next });
    };
    const receiveSynced = ({ state }: { state: boolean }) => {
      if (state) syncState();
    };
    const receiveStatus = ({ status }: { status: string }) => {
      if (!active) return;
      if (status === "disconnected") {
        setRequestError("Shared architecture connection is unavailable. Retrying…");
      } else if (status === "connected") {
        setRequestError(null);
      }
    };
    const architectureMap = collaboration.doc.getMap(ARCHITECTURE_MAP_KEY);
    const layoutMap = collaboration.doc.getMap(ARCHITECTURE_LAYOUT_MAP_KEY);
    architectureMap.observe(syncState);
    layoutMap.observe(syncState);
    collaboration.provider.on("synced", receiveSynced);
    collaboration.provider.on("status", receiveStatus);
    if (collaboration.provider.synced) syncState();
    void refreshHistory().catch((error: unknown) => {
      if (active) {
        setRequestError(
          error instanceof PublicEditorError
            ? error.message
            : "Architecture history could not be loaded.",
        );
      }
    });

    return () => {
      active = false;
      architectureMap.unobserve(syncState);
      layoutMap.unobserve(syncState);
      collaboration.provider.off("synced", receiveSynced);
      collaboration.provider.off("status", receiveStatus);
      collaboration.destroy();
    };
  }, [createCollaboration, refreshHistory, roomId]);

  const submitOperations = useCallback(async (
    state: ReconstructionYjsState,
    operations: readonly GraphOperation[],
    layout = state.layout,
  ) => {
    setBusy(true);
    setRequestError(null);
    const request: ArchitectureOperationRequest = {
      baseRevisionId: state.architecture.revisionId,
      operations: [...operations],
      layout,
    };
    try {
      const response = await fetchBoundary(
        `/api/rooms/${encodeURIComponent(roomId)}/operations`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      const body = await jsonBody(
        response,
        "Architecture update returned an invalid response.",
      );
      const parsed = ArchitectureOperationResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new PublicEditorError("Architecture update returned an invalid response.");
      }
      if (!parsed.data.ok) {
        throw new PublicEditorError(
          parsed.data.diagnostics[0]?.message ?? "Architecture update was rejected.",
        );
      }
      if (!response.ok) {
        throw new PublicEditorError("Architecture update could not be saved.");
      }
      setEditor({ status: "ready", state: parsed.data.state });
    } catch (error) {
      setRequestError(
        error instanceof PublicEditorError
          ? error.message
          : "Architecture update could not be reached.",
      );
    } finally {
      setBusy(false);
    }
  }, [fetchBoundary, roomId]);

  const graph = useMemo(
    () => editor.status === "ready"
      ? toReactFlowGraph(editor.state.architecture.architecture, editor.state.layout)
      : { nodes: [], edges: [] },
    [editor],
  );

  const onNodeClick: NodeMouseHandler<ArchitectureNode> = useCallback((_event, node) => {
    setSelectedResourceId(node.id);
    setSelectedRelationshipId(null);
    setResourceName(node.data.resource.name);
  }, []);

  const onEdgeClick: EdgeMouseHandler = useCallback((_event, edge) => {
    setSelectedRelationshipId(edge.id);
    setSelectedResourceId(null);
  }, []);

  if (editor.status === "error") {
    return <div className="architecture-state"><p role="alert">{editor.message}</p></div>;
  }
  if (editor.status === "connecting") {
    return <div className="architecture-state"><p role="status">Connecting architecture graph…</p></div>;
  }

  const state = editor.state;
  const architecture = state.architecture.architecture;
  const selectedResource = architecture.resources.find(
    (resource) => resource.id === selectedResourceId,
  );
  const selectedRelationship = architecture.relationships.find(
    (relationship) => relationship.id === selectedRelationshipId,
  );

  const addResource = (resourceType: AwsResourceType) => {
    const resourceId = createId();
    const positionIndex = architecture.resources.length;
    void submitOperations(
      state,
      [{
        type: "add_resource",
        resource: {
          id: resourceId,
          type: resourceType,
          name: RESOURCE_LABELS[resourceType],
          properties: {},
          origin: "explicit",
          reason: "Added manually from the resource palette.",
          approvalStatus: "not-required",
        },
      }],
      {
        ...state.layout,
        nodes: [
          ...state.layout.nodes,
          {
            resourceId,
            x: (positionIndex % 4) * 260,
            y: Math.floor(positionIndex / 4) * 180 + 40,
          },
        ],
      },
    );
  };

  const decideUpgrade = (
    resourceId: string,
    approvalStatus: Extract<ApprovalStatus, "approved" | "rejected">,
  ) => void submitOperations(state, [{
    type: "set_resource_approval",
    resourceId,
    approvalStatus,
  }]);

  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    void submitOperations(state, [{
      type: "add_relationship",
      relationship: {
        id: createId(),
        sourceId: connection.source,
        targetId: connection.target,
        kind: "connects",
        origin: "explicit",
        reason: "Connected manually in the architecture editor.",
        approvalStatus: "not-required",
      },
    }]);
  };

  const removeSelected = () => {
    if (selectedResource) {
      if (!globalThis.confirm(`Remove ${selectedResource.name} and its relationships?`)) {
        return;
      }
      void submitOperations(state, [{
        type: "remove_resource",
        resourceId: selectedResource.id,
        confirmation: {
          confirmed: true,
          rationale: "Confirmed in the manual architecture editor.",
        },
      }]);
      setSelectedResourceId(null);
      return;
    }
    if (!selectedRelationship) return;
    if (!globalThis.confirm("Remove the selected relationship?")) return;
    void submitOperations(state, [{
      type: "remove_relationship",
      relationshipId: selectedRelationship.id,
      confirmation: {
        confirmed: true,
        rationale: "Confirmed in the manual architecture editor.",
      },
    }]);
    setSelectedRelationshipId(null);
  };

  const saveRevision = async () => {
    if (!revisionRationale.trim()) return;
    setBusy(true);
    setRequestError(null);
    try {
      const response = await fetchBoundary(
        `/api/rooms/${encodeURIComponent(roomId)}/revisions`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevisionId: state.architecture.revisionId,
            rationale: revisionRationale,
          }),
        },
      );
      const body = await jsonBody(
        response,
        "Revision save returned an invalid response.",
      );
      if (!response.ok) throw new PublicEditorError("Revision could not be saved.");
      const parsed = SaveRevisionResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new PublicEditorError("Revision save returned an invalid response.");
      }
      setRevisionRationale("");
      setEditor({
        status: "ready",
        state: {
          architecture: {
            version: "working-architecture/v1",
            revisionId: parsed.data.revision.id,
            architecture: parsed.data.revision.architecture,
          },
          layout: parsed.data.revision.layout,
        },
      });
      await refreshHistory();
    } catch (error) {
      setRequestError(
        error instanceof PublicEditorError
          ? error.message
          : "Revision could not be reached.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="architecture-workspace" id="architect">
      <section className="architecture-canvas" aria-label="Architecture editor">
        <header className="architecture-canvas__header">
          <div>
            <p className="section-kicker">Typed AWS graph</p>
            <h1>Shape the buildable system.</h1>
          </div>
          <span>{architecture.resources.length} resources</span>
        </header>
        {requestError ? <p className="architecture-alert" role="alert">{requestError}</p> : null}
        <div className="architecture-canvas__flow">
          <ReactFlow
            deleteKeyCode={null}
            edges={graph.edges}
            fitView
            nodeTypes={NODE_TYPES}
            nodes={graph.nodes}
            onConnect={connect}
            onEdgeClick={onEdgeClick}
            onNodeClick={onNodeClick}
            onNodeDragStop={(_event, node) => {
              void submitOperations(
                state,
                [],
                applyLayoutChange(state.layout, node),
              );
            }}
          >
            <Background />
            <MiniMap pannable zoomable />
            <Controls />
          </ReactFlow>
        </div>
      </section>
      <aside className="architecture-sidebar" aria-label="Architecture controls">
        {selectedResource ? (
          <section className="architecture-selection">
            <p className="section-kicker">Selected resource</p>
            <label>
              Resource name
              <input
                disabled={busy}
                onChange={(event) => setResourceName(event.target.value)}
                value={resourceName}
              />
            </label>
            <div className="architecture-selection__actions">
              <Button
                disabled={busy || !resourceName.trim()}
                onClick={() => void submitOperations(state, [{
                  type: "update_resource",
                  resourceId: selectedResource.id,
                  changes: { name: resourceName },
                }])}
                type="button"
              >
                Update name
              </Button>
              <Button disabled={busy} onClick={removeSelected} type="button" variant="danger">
                Remove resource
              </Button>
            </div>
          </section>
        ) : selectedRelationship ? (
          <section className="architecture-selection">
            <p className="section-kicker">Selected relationship</p>
            <strong>{selectedRelationship.label ?? selectedRelationship.kind}</strong>
            <Button disabled={busy} onClick={removeSelected} type="button" variant="danger">
              Remove relationship
            </Button>
          </section>
        ) : null}
        <ResourcePalette disabled={busy} onAdd={addResource} />
        <UpgradeReviewPanel
          architecture={architecture}
          disabled={busy}
          onDecision={decideUpgrade}
        />
        <section className="revision-save">
          <p className="section-kicker">Immutable checkpoint</p>
          <h2>Save revision</h2>
          <label>
            Rationale
            <textarea
              disabled={busy}
              maxLength={1_000}
              onChange={(event) => setRevisionRationale(event.target.value)}
              placeholder="Why is this architecture ready to preserve?"
              value={revisionRationale}
            />
          </label>
          <Button
            disabled={busy || !revisionRationale.trim()}
            onClick={() => void saveRevision()}
            type="button"
          >
            Save revision
          </Button>
        </section>
        <RevisionHistory events={history.events} revisions={history.revisions} />
      </aside>
    </div>
  );
}
