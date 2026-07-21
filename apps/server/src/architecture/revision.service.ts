import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ArchitectureOperationRequestSchema,
  ArchitectureOperationResponseSchema,
  ArchitectureLayoutSchema,
  ReconstructionYjsStateSchema,
  SaveRevisionRequestSchema,
  SaveRevisionResponseSchema,
  type ReconstructionYjsState,
} from "@architect/contracts";
import { applyOperations as applyGraphOperations } from "@architect/infra";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";

import type { ActiveDocumentRegistry } from "../collab/active-document.registry.js";
import {
  SnapshotProtectedStateLostError,
  type SnapshotProtectedStateFence,
} from "../collab/yjs.repository.js";
import type { RevisionRepository } from "./revision.repository.js";

export type ArchitectureServiceErrorCode =
  | "STALE_REVISION"
  | "WORKING_STATE_CONFLICT"
  | "ARCHITECTURE_NOT_FOUND"
  | "INVALID_ARCHITECTURE_STATE"
  | "INVALID_LAYOUT";

const ERROR_MESSAGES: Record<ArchitectureServiceErrorCode, string> = {
  STALE_REVISION: "Architecture revision is stale.",
  WORKING_STATE_CONFLICT: "Working architecture changed. Refresh and retry.",
  ARCHITECTURE_NOT_FOUND: "Architecture was not found.",
  INVALID_ARCHITECTURE_STATE: "Working architecture state is invalid.",
  INVALID_LAYOUT: "Architecture layout is invalid.",
};

export class ArchitectureServiceError extends Error {
  constructor(
    readonly code: ArchitectureServiceErrorCode,
    readonly currentRevisionId: string | null = null,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "ArchitectureServiceError";
  }
}

type RevisionServiceRepository = Pick<
  RevisionRepository,
  "commitRevision" | "listHistory"
>;

type RevisionServiceOptions = Readonly<{
  documents: ActiveDocumentRegistry;
  repository: RevisionServiceRepository;
  persistRoomSnapshot(
    roomId: string,
    document: Y.Doc,
    reason: string,
    fence: SnapshotProtectedStateFence,
  ): Promise<number>;
  applyUpdate?: typeof Y.applyUpdate;
  createId?: () => string;
}>;

function cloneDocument(document: Y.Doc): Y.Doc {
  const candidate = new Y.Doc();
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
  return candidate;
}

function readState(document: Y.Doc): ReconstructionYjsState {
  const architecture = document
    .getMap(ARCHITECTURE_MAP_KEY)
    .get(ARCHITECTURE_CURRENT_KEY);
  const layout = document
    .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
    .get(ARCHITECTURE_CURRENT_KEY);
  if (architecture === undefined || layout === undefined) {
    throw new ArchitectureServiceError("ARCHITECTURE_NOT_FOUND");
  }
  const parsed = ReconstructionYjsStateSchema.safeParse({
    architecture,
    layout,
  });
  if (!parsed.success) {
    throw new ArchitectureServiceError("INVALID_ARCHITECTURE_STATE");
  }
  return parsed.data;
}

function assertBase(state: ReconstructionYjsState, baseRevisionId: string) {
  if (state.architecture.revisionId !== baseRevisionId) {
    throw new ArchitectureServiceError(
      "STALE_REVISION",
      state.architecture.revisionId,
    );
  }
}

function layoutForOperation(
  state: ReconstructionYjsState,
  architectureResourceIds: ReadonlySet<string>,
  suppliedLayout: unknown,
) {
  const retainedNodes = state.layout.nodes.filter((node) =>
    architectureResourceIds.has(node.resourceId)
  );
  if (suppliedLayout === undefined) {
    return ArchitectureLayoutSchema.parse({
      ...state.layout,
      nodes: retainedNodes,
    });
  }
  const patch = ArchitectureLayoutSchema.safeParse(suppliedLayout);
  if (
    !patch.success ||
    patch.data.revisionId !== state.architecture.revisionId ||
    patch.data.nodes.length !== 1 ||
    !architectureResourceIds.has(patch.data.nodes[0]!.resourceId)
  ) {
    throw new ArchitectureServiceError("INVALID_LAYOUT");
  }
  const moved = patch.data.nodes[0]!;
  const found = retainedNodes.some((node) => node.resourceId === moved.resourceId);
  return ArchitectureLayoutSchema.parse({
    ...state.layout,
    nodes: found
      ? retainedNodes.map((node) =>
          node.resourceId === moved.resourceId ? moved : node
        )
      : [...retainedNodes, moved],
  });
}

export function createRevisionService({
  documents,
  repository,
  persistRoomSnapshot,
  applyUpdate = Y.applyUpdate,
  createId = randomUUID,
}: RevisionServiceOptions) {
  const applyOperations = async (input: Readonly<{
    roomId: string;
    request: unknown;
  }>) => {
    const request = ArchitectureOperationRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ArchitectureServiceError("INVALID_ARCHITECTURE_STATE");
    }
    return documents.withDocument(input.roomId, async (live) => {
      const state = readState(live);
      assertBase(state, request.data.baseRevisionId);
      const operationResult = request.data.operations.length === 0
        ? {
            ok: true as const,
            architecture: state.architecture.architecture,
            diagnostics: [],
          }
        : applyGraphOperations(
            state.architecture.architecture,
            request.data.operations,
          );
      if (!operationResult.ok) {
        return ArchitectureOperationResponseSchema.parse({
          ok: false,
          state,
          diagnostics: operationResult.diagnostics,
        });
      }

      const resourceIds = new Set(
        operationResult.architecture.resources.map((resource) => resource.id),
      );
      const nextState = ReconstructionYjsStateSchema.parse({
        architecture: {
          ...state.architecture,
          architecture: operationResult.architecture,
        },
        layout: layoutForOperation(state, resourceIds, request.data.layout),
      });
      const candidate = cloneDocument(live);
      try {
        candidate
          .getMap(ARCHITECTURE_MAP_KEY)
          .set(ARCHITECTURE_CURRENT_KEY, nextState.architecture);
        candidate
          .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
          .set(ARCHITECTURE_CURRENT_KEY, nextState.layout);
        await persistRoomSnapshot(
          input.roomId,
          candidate,
          "architecture_operations",
          {
            kind: "protected_state",
            expectedProtectedState: state,
          },
        );
        const delta = Y.encodeStateAsUpdate(
          candidate,
          Y.encodeStateVector(live),
        );
        applyUpdate(live, delta, "architect/server-operations");
      } catch (error) {
        if (error instanceof SnapshotProtectedStateLostError) {
          throw new ArchitectureServiceError(
            "WORKING_STATE_CONFLICT",
            state.architecture.revisionId,
          );
        }
        throw error;
      } finally {
        candidate.destroy();
      }
      return ArchitectureOperationResponseSchema.parse({
        ok: true,
        state: nextState,
        diagnostics: [],
      });
    });
  };

  const saveRevision = async (input: Readonly<{
    roomId: string;
    participantId: string;
    traceId: string;
    request: unknown;
  }>) => {
    const request = SaveRevisionRequestSchema.safeParse(input.request);
    if (!request.success) {
      throw new ArchitectureServiceError("INVALID_ARCHITECTURE_STATE");
    }
    return documents.withDocument(input.roomId, async (live) => {
      const state = readState(live);
      assertBase(state, request.data.baseRevisionId);
      const revisionId = createId();
      const eventId = createId();
      const rebasedState = ReconstructionYjsStateSchema.parse({
        architecture: { ...state.architecture, revisionId },
        layout: { ...state.layout, revisionId },
      });
      const candidate = cloneDocument(live);
      try {
        candidate
          .getMap(ARCHITECTURE_MAP_KEY)
          .set(ARCHITECTURE_CURRENT_KEY, rebasedState.architecture);
        candidate
          .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
          .set(ARCHITECTURE_CURRENT_KEY, rebasedState.layout);
        const result = await repository.commitRevision({
          roomId: input.roomId,
          baseRevisionId: request.data.baseRevisionId,
          revisionId,
          eventId,
          architecture: rebasedState.architecture.architecture,
          layout: rebasedState.layout,
          requirements: rebasedState.architecture.architecture.requirements,
          author: { type: "participant", id: input.participantId },
          rationale: request.data.rationale,
          traceId: input.traceId,
          snapshotPayload: Y.encodeStateAsUpdate(candidate),
        });
        if (result.kind === "stale") {
          throw new ArchitectureServiceError(
            "STALE_REVISION",
            result.currentRevisionId,
          );
        }
        if (result.kind === "not_found") {
          throw new ArchitectureServiceError("ARCHITECTURE_NOT_FOUND");
        }
        const delta = Y.encodeStateAsUpdate(
          candidate,
          Y.encodeStateVector(live),
        );
        applyUpdate(live, delta, "architect/server-revision");
        return SaveRevisionResponseSchema.parse({
          revision: result.revision,
          event: result.event,
        });
      } finally {
        candidate.destroy();
      }
    });
  };

  const listHistory = (roomId: string) => repository.listHistory(roomId);

  return Object.freeze({ applyOperations, saveRevision, listHistory });
}

export type RevisionService = ReturnType<typeof createRevisionService>;
