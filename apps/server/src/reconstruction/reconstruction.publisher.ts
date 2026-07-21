import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ReconstructionYjsStateSchema,
  SERVER_VOTES_MAP_KEY,
  type Architecture,
  type ArchitectureLayout,
} from "@architect/contracts";
import * as Y from "yjs";
import type { ActiveDocumentRegistry } from "../collab/active-document.registry.js";

type ReconstructionPublisherOptions = Readonly<{
  documents: ActiveDocumentRegistry;
  persistRoomSnapshot(
    roomId: string,
    document: Y.Doc,
    reason: string,
  ): Promise<number>;
  applyUpdate?: typeof Y.applyUpdate;
}>;

function cloneDocument(document: Y.Doc): Y.Doc {
  const candidate = new Y.Doc();
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
  return candidate;
}

export function createReconstructionPublisher({
  documents,
  persistRoomSnapshot,
  applyUpdate = Y.applyUpdate,
}: ReconstructionPublisherOptions) {
  const mutate = async (
    roomId: string,
    reason: string,
    origin: string,
    operation: (candidate: Y.Doc) => void,
  ) => documents.withDocument(roomId, async (live) => {
    const candidate = cloneDocument(live);
    try {
      operation(candidate);
      await persistRoomSnapshot(roomId, candidate, reason);
      const delta = Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(live));
      applyUpdate(live, delta, origin);
    } finally {
      candidate.destroy();
    }
  });

  const publishArchitecture = async (input: Readonly<{
    roomId: string;
    revisionId: string;
    architecture: Architecture;
    layout: ArchitectureLayout;
  }>) => {
    const state = ReconstructionYjsStateSchema.parse({
      architecture: {
        version: "working-architecture/v1",
        revisionId: input.revisionId,
        architecture: input.architecture,
      },
      layout: input.layout,
    });
    await mutate(
      input.roomId,
      "reconstruction_architecture",
      "architect/server-reconstruction",
      (candidate) => {
        candidate
          .getMap(ARCHITECTURE_MAP_KEY)
          .set(ARCHITECTURE_CURRENT_KEY, state.architecture);
        candidate
          .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
          .set(ARCHITECTURE_CURRENT_KEY, state.layout);
      },
    );
  };

  const publishFailureCleanup = async (input: Readonly<{ roomId: string }>) => {
    await mutate(
      input.roomId,
      "reconstruction_failure_cleanup",
      "architect/server-reconstruction-failure",
      (candidate) => {
        candidate.getMap(SERVER_VOTES_MAP_KEY).delete("ready");
        candidate.getMap("meta").set("phase", "sketch");
      },
    );
  };

  const publishArchitectPhase = async (input: Readonly<{ roomId: string }>) => {
    await mutate(
      input.roomId,
      "reconstruction_phase_mirror",
      "architect/server-reconstruction-phase",
      (candidate) => {
        candidate.getMap("meta").set("phase", "architect");
      },
    );
  };

  return Object.freeze({
    publishArchitecture,
    publishFailureCleanup,
    publishArchitectPhase,
  });
}

export type ReconstructionPublisher = ReturnType<
  typeof createReconstructionPublisher
>;
