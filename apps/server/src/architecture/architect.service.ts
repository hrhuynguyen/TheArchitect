import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ApplyArchitectPatchRequestSchema,
  RejectArchitectPatchRequestSchema,
  ArchitectTurnRequestSchema,
  ReconstructionYjsStateSchema,
  type ArchitectTurn,
  type HistoryEvent,
  type ReconstructionYjsState,
} from "@architect/contracts";
import {
  applyArchitectOperations,
  validateArchitectOperations,
} from "@architect/infra";
import { createHmac, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";

import {
  AiRecorderError,
  type AiProvider,
  type AiRunRecorder,
  type ProviderIdentity,
} from "../ai/provider.js";
import type { ActiveDocumentRegistry } from "../collab/active-document.registry.js";
import { ARCHITECT_PROTOCOL, architectProtocolInputSchema } from "./architect.protocol.js";
import { protectedStateDigest } from "./protected-state.js";
import type {
  ArchitectActor,
  ArchitectProposalRepository,
} from "./architectProposal.repository.js";

export const ARCHITECT_TURN_STALE_MS = 120_000;
export const ARCHITECT_HEARTBEAT_MS = 30_000;

type ArchitectRepository = Pick<
  ArchitectProposalRepository,
  | "createThinking"
  | "recordAiTerminal"
  | "completeTurn"
  | "failTurn"
  | "heartbeatThinking"
  | "interruptStaleThinking"
  | "readTurn"
  | "listTurns"
  | "readProposalSource"
  | "applyProposalRevision"
  | "rejectProposal"
>;

type RecentHistory = Readonly<
  Pick<HistoryEvent, "kind" | "status" | "title" | "summary" | "createdAt">
>;

type ArchitectProviderRuntime = Readonly<{
  primaryIdentity: ProviderIdentity;
  createProvider(recordTerminal: AiRunRecorder): AiProvider;
}>;

type ArchitectServiceOptions = Readonly<{
  documents: ActiveDocumentRegistry;
  repository: ArchitectRepository;
  providerRuntime: ArchitectProviderRuntime;
  latestSnapshotVersion(roomId: string): Promise<number>;
  recentHistory(roomId: string): Promise<readonly RecentHistory[]>;
  safetySecret: string;
  createId?: () => string;
  now?: () => Date;
  applyUpdate?: typeof Y.applyUpdate;
  heartbeatMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}>;

export type ArchitectServiceErrorCode =
  | "ARCHITECT_TURN_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "WORKING_STATE_CONFLICT"
  | "DESTRUCTIVE_CONFIRMATION_REQUIRED"
  | "INVALID_AGENT_PATCH"
  | "TERMINAL_CONFLICT"
  | "IDEMPOTENCY_CONFLICT";

export class ArchitectServiceError extends Error {
  constructor(
    readonly code: ArchitectServiceErrorCode,
    readonly currentRevisionId: string | null = null,
  ) {
    super(code);
    this.name = "ArchitectServiceError";
  }
}

function readProtectedState(document: Y.Doc): ReconstructionYjsState {
  return ReconstructionYjsStateSchema.parse({
    architecture: document
      .getMap(ARCHITECTURE_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
    layout: document
      .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
      .get(ARCHITECTURE_CURRENT_KEY),
  });
}

export { protectedStateDigest } from "./protected-state.js";

function interruptedCutoff(now: Date): Date {
  return new Date(now.getTime() - ARCHITECT_TURN_STALE_MS);
}

const PUBLIC_FAILURES = Object.freeze({
  AI_UNAVAILABLE: Object.freeze({
    code: "AI_UNAVAILABLE" as const,
    message: "The AI architect is temporarily unavailable.",
  }),
  ARCHITECT_FAILED: Object.freeze({
    code: "ARCHITECT_FAILED" as const,
    message: "The architect turn could not be completed.",
  }),
  INVALID_AGENT_PATCH: Object.freeze({
    code: "INVALID_AGENT_PATCH" as const,
    message: "The architect proposed an invalid graph change.",
  }),
});

export function createArchitectService({
  documents,
  repository,
  providerRuntime,
  latestSnapshotVersion,
  recentHistory,
  safetySecret,
  createId = randomUUID,
  now = () => new Date(),
  applyUpdate = Y.applyUpdate,
  heartbeatMs = ARCHITECT_HEARTBEAT_MS,
  setInterval: scheduleInterval = globalThis.setInterval,
  clearInterval: cancelInterval = globalThis.clearInterval,
}: ArchitectServiceOptions) {
  if (!safetySecret) throw new Error("Architect safety secret is required");
  if (
    !Number.isFinite(heartbeatMs) ||
    heartbeatMs <= 0 ||
    heartbeatMs >= ARCHITECT_TURN_STALE_MS
  ) {
    throw new Error("Architect heartbeat interval is invalid");
  }

  const safetyIdentifier = (roomId: string, actor: ArchitectActor) =>
    createHmac("sha256", safetySecret)
      .update("architect:turn:safety:v1\0")
      .update(roomId)
      .update("\0")
      .update(actor.type)
      .update("\0")
      .update(actor.id)
      .digest("base64url");

  const currentTurn = async (
    roomId: string,
    turnId: string,
  ): Promise<ArchitectTurn> => {
    const turn = await repository.readTurn(roomId, turnId);
    if (!turn) throw new Error("Architect turn disappeared");
    return turn;
  };

  const runTurn = async (input: Readonly<{
    roomId: string;
    actor: ArchitectActor;
    request: unknown;
  }>): Promise<ArchitectTurn> => {
    const request = ArchitectTurnRequestSchema.parse(input.request);
    const startedAt = now();
    await repository.interruptStaleThinking(
      input.roomId,
      interruptedCutoff(startedAt),
    );

    const claimed = await documents.withDocument(
      input.roomId,
      async (document) => {
        const state = readProtectedState(document);
        const snapshotVersion = await latestSnapshotVersion(input.roomId);
        const turnId = createId();
        const traceId = `architect:${turnId}`;
        const claim = await repository.createThinking({
          id: turnId,
          roomId: input.roomId,
          baseRevisionId: state.architecture.revisionId,
          message: request.message,
          actor: input.actor,
          idempotencyKey: request.idempotencyKey,
          sourceSnapshotVersion: snapshotVersion,
          sourceProtectedDigest: protectedStateDigest(state),
          sourceProtectedState: state,
          traceId,
          primaryProvider: providerRuntime.primaryIdentity,
        });
        return Object.freeze({ claim, state });
      },
    );

    if (claimed.claim.kind === "existing") return claimed.claim.turn;
    const turn = claimed.claim.turn;
    let heartbeatRunning = false;
    const heartbeatTimer = scheduleInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void repository.heartbeatThinking(
        input.roomId,
        turn.id,
        turn.traceId,
      ).catch(() => undefined).finally(() => {
        heartbeatRunning = false;
      });
    }, heartbeatMs);
    if (
      typeof heartbeatTimer === "object" &&
      heartbeatTimer &&
      "unref" in heartbeatTimer
    ) heartbeatTimer.unref();

    try {
      const history = [...await recentHistory(input.roomId)]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 20);
      const protocolInput = architectProtocolInputSchema.parse({
        message: request.message,
        architecture: claimed.state.architecture.architecture,
        requirements: claimed.state.architecture.architecture.requirements,
        history,
      });
      const provider = providerRuntime.createProvider(async (metadata) => {
        const recorded = await repository.recordAiTerminal(turn.id, metadata);
        if (recorded.kind !== "recorded") {
          throw new Error("Architect AI terminal record fence was lost");
        }
      });

      let output;
      try {
        output = await provider.architect({
          traceId: turn.traceId,
          safetyIdentifier: safetyIdentifier(input.roomId, input.actor),
          input: protocolInput,
        }, ARCHITECT_PROTOCOL);
      } catch (error) {
        const failure = error instanceof AiRecorderError
          ? PUBLIC_FAILURES.ARCHITECT_FAILED
          : PUBLIC_FAILURES.AI_UNAVAILABLE;
        const failed = await repository.failTurn(input.roomId, turn.id, failure);
        return failed.kind === "completed"
          ? failed.turn
          : currentTurn(input.roomId, turn.id);
      }

      if (output.kind === "proposal") {
        const validation = validateArchitectOperations(
          claimed.state.architecture.architecture,
          output.operations,
        );
        if (!validation.ok) {
          const failed = await repository.failTurn(
            input.roomId,
            turn.id,
            PUBLIC_FAILURES.INVALID_AGENT_PATCH,
          );
          return failed.kind === "completed"
            ? failed.turn
            : currentTurn(input.roomId, turn.id);
        }
      }

      const completed = await repository.completeTurn(
        input.roomId,
        turn.id,
        output,
      );
      return completed.kind === "completed"
        ? completed.turn
        : currentTurn(input.roomId, turn.id);
    } finally {
      cancelInterval(heartbeatTimer);
    }
  };

  const listTurns = async (roomId: string) => {
    await repository.interruptStaleThinking(roomId, interruptedCutoff(now()));
    return repository.listTurns(roomId);
  };

  const applyPatch = async (input: Readonly<{
    roomId: string;
    proposalId: string;
    participantId: string;
    traceId: string;
    request: unknown;
  }>): Promise<ArchitectTurn> => {
    const request = ApplyArchitectPatchRequestSchema.parse(input.request);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.traceId)) {
      throw new ArchitectServiceError("INVALID_AGENT_PATCH");
    }
    return documents.withDocument(input.roomId, async (live) => {
      const source = await repository.readProposalSource(
        input.roomId,
        input.proposalId,
      );
      if (!source) throw new ArchitectServiceError("ARCHITECT_TURN_NOT_FOUND");
      if (
        source.turn.kind !== "proposal" ||
        source.sourceProtectedState === null ||
        (source.turn.state !== "proposal_ready" &&
          source.turn.state !== "applied")
      ) throw new ArchitectServiceError("TERMINAL_CONFLICT");
      if (
        source.turn.state === "proposal_ready" &&
        request.baseRevisionId !== source.turn.baseRevisionId
      ) {
        throw new ArchitectServiceError(
          "REVISION_CONFLICT",
          readProtectedState(live).architecture.revisionId,
        );
      }

      const checked = applyArchitectOperations(
        source.sourceProtectedState.architecture.architecture,
        source.operations,
        request.destructiveConfirmation,
      );
      if (!checked.ok) {
        if (checked.diagnostics.some((diagnostic) =>
          diagnostic.code === "ARCHITECT_DESTRUCTIVE_CONFIRMATION_REQUIRED"
        )) {
          throw new ArchitectServiceError(
            "DESTRUCTIVE_CONFIRMATION_REQUIRED",
          );
        }
        throw new ArchitectServiceError("INVALID_AGENT_PATCH");
      }

      const liveState = readProtectedState(live);
      if (source.turn.state === "proposal_ready") {
        if (
          liveState.architecture.revisionId !== source.turn.baseRevisionId
        ) {
          throw new ArchitectServiceError(
            "REVISION_CONFLICT",
            liveState.architecture.revisionId,
          );
        }
        if (
          protectedStateDigest(liveState) !==
            source.turn.sourceProtectedDigest ||
          !isDeepStrictEqual(liveState, source.sourceProtectedState)
        ) {
          throw new ArchitectServiceError(
            "WORKING_STATE_CONFLICT",
            liveState.architecture.revisionId,
          );
        }
      }

      const revisionId = source.turn.state === "applied"
        ? source.turn.appliedRevisionId
        : createId();
      const resourceIds = new Set(
        checked.architecture.resources.map((resource) => resource.id),
      );
      const candidateState = ReconstructionYjsStateSchema.parse({
        architecture: {
          version: "working-architecture/v1",
          revisionId,
          architecture: checked.architecture,
        },
        layout: {
          ...source.sourceProtectedState.layout,
          revisionId,
          nodes: source.sourceProtectedState.layout.nodes.filter((node) =>
            resourceIds.has(node.resourceId)
          ),
        },
      });
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(live));
        candidate
          .getMap(ARCHITECTURE_MAP_KEY)
          .set(ARCHITECTURE_CURRENT_KEY, candidateState.architecture);
        candidate
          .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
          .set(ARCHITECTURE_CURRENT_KEY, candidateState.layout);
        const result = await repository.applyProposalRevision({
          roomId: input.roomId,
          proposalId: input.proposalId,
          participantId: input.participantId,
          baseRevisionId: request.baseRevisionId,
          idempotencyKey: request.idempotencyKey,
          rationale: request.rationale,
          ...(request.destructiveConfirmation
            ? { destructiveConfirmation: request.destructiveConfirmation }
            : {}),
          revisionId,
          revisionEventId: source.turn.state === "applied"
            ? `idempotent:revision:${input.proposalId}`
            : createId(),
          proposalEventId: source.turn.state === "applied"
            ? `idempotent:proposal:${input.proposalId}`
            : createId(),
          traceId: input.traceId,
          candidateState,
          snapshotPayload: Y.encodeStateAsUpdate(candidate),
        });
        if (result.kind === "stale") {
          throw new ArchitectServiceError(
            "REVISION_CONFLICT",
            result.currentRevisionId,
          );
        }
        if (result.kind === "working_conflict") {
          throw new ArchitectServiceError(
            "WORKING_STATE_CONFLICT",
            liveState.architecture.revisionId,
          );
        }
        if (result.kind === "destructive_confirmation_required") {
          throw new ArchitectServiceError(
            "DESTRUCTIVE_CONFIRMATION_REQUIRED",
          );
        }
        if (result.kind === "invalid_candidate") {
          throw new ArchitectServiceError("INVALID_AGENT_PATCH");
        }
        if (result.kind === "idempotency_conflict") {
          throw new ArchitectServiceError("IDEMPOTENCY_CONFLICT");
        }
        if (result.kind === "not_found") {
          throw new ArchitectServiceError("ARCHITECT_TURN_NOT_FOUND");
        }
        if (result.kind === "terminal_conflict") {
          throw new ArchitectServiceError("TERMINAL_CONFLICT");
        }

        const shouldPublish = !result.idempotent ||
          liveState.architecture.revisionId === source.turn.baseRevisionId;
        if (shouldPublish) {
          const publication = new Y.Doc();
          try {
            Y.applyUpdate(publication, Y.encodeStateAsUpdate(live));
            publication
              .getMap(ARCHITECTURE_MAP_KEY)
              .set(
                ARCHITECTURE_CURRENT_KEY,
                result.publication.state.architecture,
              );
            publication
              .getMap(ARCHITECTURE_LAYOUT_MAP_KEY)
              .set(
                ARCHITECTURE_CURRENT_KEY,
                result.publication.state.layout,
              );
            const delta = Y.encodeStateAsUpdate(
              publication,
              Y.encodeStateVector(live),
            );
            applyUpdate(live, delta, "architect/server-proposal");
          } finally {
            publication.destroy();
          }
        }
        return result.turn;
      } finally {
        candidate.destroy();
      }
    });
  };

  const rejectPatch = async (input: Readonly<{
    roomId: string;
    proposalId: string;
    participantId: string;
    request: unknown;
  }>): Promise<ArchitectTurn> => {
    const request = RejectArchitectPatchRequestSchema.parse(input.request);
    const result = await repository.rejectProposal({
      roomId: input.roomId,
      proposalId: input.proposalId,
      participantId: input.participantId,
      idempotencyKey: request.idempotencyKey,
      rationale: request.rationale,
    });
    if (result.kind === "rejected") return result.turn;
    if (result.kind === "idempotency_conflict") {
      throw new ArchitectServiceError("IDEMPOTENCY_CONFLICT");
    }
    if (result.kind === "not_found") {
      throw new ArchitectServiceError("ARCHITECT_TURN_NOT_FOUND");
    }
    throw new ArchitectServiceError("TERMINAL_CONFLICT");
  };

  return Object.freeze({ runTurn, listTurns, applyPatch, rejectPatch });
}

export type ArchitectService = ReturnType<typeof createArchitectService>;
