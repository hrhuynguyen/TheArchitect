import {
  ARCHITECTURE_CURRENT_KEY,
  ARCHITECTURE_LAYOUT_MAP_KEY,
  ARCHITECTURE_MAP_KEY,
  ArchitectTurnRequestSchema,
  ReconstructionYjsStateSchema,
  type ArchitectTurn,
  type HistoryEvent,
  type ReconstructionYjsState,
} from "@architect/contracts";
import { validateArchitectOperations } from "@architect/infra";
import { createHash, createHmac, randomUUID } from "node:crypto";
import * as Y from "yjs";

import {
  AiRecorderError,
  type AiProvider,
  type AiRunRecorder,
  type ProviderIdentity,
} from "../ai/provider.js";
import type { ActiveDocumentRegistry } from "../collab/active-document.registry.js";
import { ARCHITECT_PROTOCOL, architectProtocolInputSchema } from "./architect.protocol.js";
import type {
  ArchitectActor,
  ArchitectProposalRepository,
} from "./architectProposal.repository.js";

export const ARCHITECT_TURN_STALE_MS = 120_000;

type ArchitectRepository = Pick<
  ArchitectProposalRepository,
  | "createThinking"
  | "recordAiTerminal"
  | "completeTurn"
  | "failTurn"
  | "interruptStaleThinking"
  | "readTurn"
  | "listTurns"
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
}>;

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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function protectedStateDigest(state: ReconstructionYjsState): string {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

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
}: ArchitectServiceOptions) {
  if (!safetySecret) throw new Error("Architect safety secret is required");

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
    await repository.interruptStaleThinking(interruptedCutoff(startedAt));

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
  };

  const listTurns = (roomId: string) => repository.listTurns(roomId);

  return Object.freeze({ runTurn, listTurns });
}

export type ArchitectService = ReturnType<typeof createArchitectService>;
