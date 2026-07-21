import {
  READINESS_THRESHOLD,
  SERVER_VOTES_MAP_KEY,
  VoteKindSchema,
  VoteMutationResponseSchema,
  VoteSnapshotSchema,
  evaluateVote,
  type VoteKind,
  type VoteMutationResponse,
  type VoteSnapshot,
} from "@architect/contracts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import type { ActiveDocumentRegistry } from "../collab/active-document.registry.js";
import type { AwarenessRegistry } from "../collab/awareness.registry.js";

type TransitionJobRecord = {
  id: string;
  roomId: string;
  sourceRevision: number;
  kind: "ready";
  traceId: string;
};

type TransitionTransaction = {
  room: {
    updateMany(input: {
      where: { id: string; phase: "sketch" };
      data: { phase: "reconstructing" };
    }): Promise<{ count: number }>;
  };
  transitionJob: {
    create(input: {
      data: {
        roomId: string;
        sourceRevision: number;
        kind: "ready";
        traceId: string;
      };
    }): Promise<TransitionJobRecord>;
  };
};

export type VoteDatabase = {
  room: {
    findUnique(input: {
      where: { id: string };
      select: { phase: true };
    }): Promise<{
      phase: "sketch" | "reconstructing" | "architect" | "deploy";
    } | null>;
  };
  transitionJob: {
    findFirst(input: {
      where: { roomId: string; kind: "ready" };
    }): Promise<TransitionJobRecord | null>;
    findUnique(input: {
      where: {
        roomId_sourceRevision_kind: {
          roomId: string;
          sourceRevision: number;
          kind: "ready";
        };
      };
    }): Promise<TransitionJobRecord | null>;
  };
  $transaction<T>(
    operation: (transaction: TransitionTransaction) => Promise<T>,
  ): Promise<T>;
};

type VoteServiceOptions = {
  awarenessRegistry: AwarenessRegistry;
  database: VoteDatabase;
  documents: ActiveDocumentRegistry;
  onPostCommitPersistenceError?: (error: unknown) => void;
  phaseRetryAttempts?: number;
  persistRoomSnapshot(
    roomId: string,
    document: Y.Doc,
    reason: string,
  ): Promise<number>;
};

class PhaseAlreadyTransitioned extends Error {}

export class VoteClosedError extends Error {
  constructor() {
    super("Readiness voting is closed");
    this.name = "VoteClosedError";
  }
}

function uniqueConstraintFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

function existingSnapshot(
  document: Y.Doc,
  kind: VoteKind,
): VoteSnapshot | null {
  const parsed = VoteSnapshotSchema.safeParse(
    document.getMap(SERVER_VOTES_MAP_KEY).get(kind),
  );
  return parsed.success ? parsed.data : null;
}

function activeParticipantIds(
  awarenessRegistry: AwarenessRegistry,
  roomId: string,
  requesterId?: string,
): string[] {
  const active = awarenessRegistry
    .list(roomId)
    .map((profile) => profile.participantId);
  if (requesterId) active.push(requesterId);
  return [...new Set(active)].sort((left, right) => left.localeCompare(right));
}

export function createVoteService({
  awarenessRegistry,
  database,
  documents,
  onPostCommitPersistenceError = () => undefined,
  phaseRetryAttempts = 3,
  persistRoomSnapshot,
}: VoteServiceOptions) {
  const membershipDirty = new Set<string>();
  const membershipTasks = new Map<string, Promise<void>>();
  const membershipFailures: unknown[] = [];
  const phaseRetryTasks = new Set<Promise<void>>();
  const phaseRetryFailures: unknown[] = [];
  let destroyed = false;
  let destroyPromise: Promise<void> | undefined;
  const retryAttempts = Math.max(1, Math.floor(phaseRetryAttempts));

  const claimTransition = async (
    roomId: string,
    sourceRevision: number,
    kind: "ready",
  ): Promise<{ claimed: boolean; jobId: string }> => {
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
      throw new Error("Invalid source revision");
    }
    try {
      const job = await database.$transaction(async (transaction) => {
        const created = await transaction.transitionJob.create({
          data: {
            roomId,
            sourceRevision,
            kind,
            traceId: randomUUID(),
          },
        });
        const phase = await transaction.room.updateMany({
          where: { id: roomId, phase: "sketch" },
          data: { phase: "reconstructing" },
        });
        if (phase.count !== 1) throw new PhaseAlreadyTransitioned();
        return created;
      });
      return { claimed: true, jobId: job.id };
    } catch (error) {
      if (uniqueConstraintFailure(error)) {
        const existing = await database.transitionJob.findUnique({
          where: {
            roomId_sourceRevision_kind: { roomId, sourceRevision, kind },
          },
        });
        if (existing) return { claimed: false, jobId: existing.id };
      }
      if (error instanceof PhaseAlreadyTransitioned) {
        const existing = await database.transitionJob.findFirst({
          where: { roomId, kind },
        });
        if (existing) return { claimed: false, jobId: existing.id };
      }
      throw error;
    }
  };

  const persistCanonicalSnapshot = async (
    roomId: string,
    document: Y.Doc,
    reason: string,
  ) => persistRoomSnapshot(roomId, document, reason);

  const durablePhase = async (roomId: string) => {
    const room = await database.room.findUnique({
      where: { id: roomId },
      select: { phase: true },
    });
    if (!room) throw new Error("Room not found");
    return room.phase;
  };

  const createCandidate = (document: Y.Doc) => {
    const candidate = new Y.Doc();
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    return candidate;
  };

  const publishCandidate = (
    candidate: Y.Doc,
    document: Y.Doc,
    origin: string,
  ) => {
    const delta = Y.encodeStateAsUpdate(
      candidate,
      Y.encodeStateVector(document),
    );
    Y.applyUpdate(document, delta, origin);
  };

  const reportPostCommitError = (error: unknown) => {
    try {
      onPostCommitPersistenceError(error);
    } catch {
      // A failure observer cannot invalidate the durable transition.
    }
  };

  const queuePhasePublication = (roomId: string, immutableUpdate: Uint8Array) => {
    const retry = documents.withDocument(roomId, async (document) => {
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, immutableUpdate);
        let lastFailure: unknown;
        for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
          try {
            await persistCanonicalSnapshot(
              roomId,
              candidate,
              "phase_transition",
            );
            publishCandidate(
              candidate,
              document,
              "architect/server-phase-retry",
            );
            return;
          } catch (error) {
            lastFailure = error;
            reportPostCommitError(error);
          }
        }
        throw new AggregateError(
          [lastFailure],
          "Phase snapshot retry failed",
        );
      } finally {
        candidate.destroy();
      }
    });
    let handled!: Promise<void>;
    handled = retry
      .catch((error) => {
        phaseRetryFailures.push(error);
      })
      .finally(() => {
        phaseRetryTasks.delete(handled);
      });
    phaseRetryTasks.add(handled);
  };

  const persistOrQueuePhaseSnapshot = async (
    roomId: string,
    candidate: Y.Doc,
  ): Promise<boolean> => {
    try {
      await persistCanonicalSnapshot(roomId, candidate, "phase_transition");
      return true;
    } catch (error) {
      reportPostCommitError(error);
      queuePhasePublication(roomId, Y.encodeStateAsUpdate(candidate));
      return false;
    }
  };

  const mutate = async (
    roomId: string,
    participantId: string,
    kindInput: VoteKind,
    vote: boolean,
  ): Promise<VoteMutationResponse> => {
    const kind = VoteKindSchema.parse(kindInput);
    if (!participantId) throw new Error("Participant ID required");

    return documents.withDocument(roomId, async (document) => {
      const startingPhase = await durablePhase(roomId);
      const current = existingSnapshot(document, kind);
      if (kind === "ready" && startingPhase !== "sketch") {
        if (
          startingPhase === "reconstructing" &&
          vote &&
          current?.met &&
          current.voterIds.includes(participantId)
        ) {
          const existing = await database.transitionJob.findFirst({
            where: { roomId, kind: "ready" },
          });
          if (existing) {
            return VoteMutationResponseSchema.parse({
              kind,
              phase: startingPhase,
              snapshot: current,
              transition: { claimed: false, jobId: existing.id },
            });
          }
        }
        throw new VoteClosedError();
      }
      const voterIds = new Set(current?.voterIds ?? []);
      if (vote) voterIds.add(participantId);
      else voterIds.delete(participantId);
      const snapshot = evaluateVote({
        activeParticipantIds: activeParticipantIds(
          awarenessRegistry,
          roomId,
          participantId,
        ),
        voterIds: [...voterIds],
        threshold: READINESS_THRESHOLD,
      });
      const candidate = createCandidate(document);
      try {
        candidate.transact(() => {
          candidate.getMap(SERVER_VOTES_MAP_KEY).set(kind, snapshot);
          candidate.getMap("meta").set("phase", startingPhase);
        }, "architect/server-candidate-vote");
        const sourceRevision = await persistCanonicalSnapshot(
          roomId,
          candidate,
          `vote_${kind}`,
        );

        if (kind === "ready" && vote && snapshot.met) {
          const transition = await claimTransition(
            roomId,
            sourceRevision,
            "ready",
          );
          candidate.transact(() => {
            candidate.getMap("meta").set("phase", "reconstructing");
          }, "architect/server-candidate-phase");
          const persisted = await persistOrQueuePhaseSnapshot(
            roomId,
            candidate,
          );
          if (persisted) {
            publishCandidate(
              candidate,
              document,
              "architect/server-transition",
            );
          }

          return VoteMutationResponseSchema.parse({
            kind,
            phase: "reconstructing",
            snapshot,
            transition,
          });
        }

        publishCandidate(candidate, document, "architect/server-vote");

        return VoteMutationResponseSchema.parse({
          kind,
          phase: startingPhase,
          snapshot,
          transition: null,
        });
      } finally {
        candidate.destroy();
      }
    });
  };

  const recomputePresence = async (roomId: string) => {
    await documents.withDocument(roomId, async (document) => {
      const phase = await durablePhase(roomId);
      const votes = document.getMap(SERVER_VOTES_MAP_KEY);
      const active = activeParticipantIds(awarenessRegistry, roomId);
      const updates: Array<{ kind: VoteKind; snapshot: VoteSnapshot }> = [];
      let readyMet = false;
      for (const kind of VoteKindSchema.options) {
        if (!votes.has(kind)) continue;
        if (kind === "ready" && phase !== "sketch") continue;
        const current = existingSnapshot(document, kind);
        const next = evaluateVote({
          activeParticipantIds: active,
          voterIds: current?.voterIds ?? [],
          threshold: READINESS_THRESHOLD,
        });
        if (!current || !isDeepStrictEqual(current, next)) {
          updates.push({ kind, snapshot: next });
        }
        if (kind === "ready") readyMet = next.met;
      }
      const meta = document.getMap("meta");
      const metaChanged = meta.get("phase") !== phase;
      const shouldTransition = phase === "sketch" && readyMet;
      if (updates.length > 0 || metaChanged || shouldTransition) {
        const candidate = createCandidate(document);
        try {
          candidate.transact(() => {
            const candidateVotes = candidate.getMap(SERVER_VOTES_MAP_KEY);
            for (const update of updates) {
              candidateVotes.set(update.kind, update.snapshot);
            }
            candidate.getMap("meta").set("phase", phase);
          }, "architect/server-candidate-presence");
          const sourceRevision = await persistCanonicalSnapshot(
            roomId,
            candidate,
            "vote_presence",
          );

          if (shouldTransition) {
            await claimTransition(roomId, sourceRevision, "ready");
            candidate.transact(() => {
              candidate.getMap("meta").set("phase", "reconstructing");
            }, "architect/server-candidate-phase");
            const persisted = await persistOrQueuePhaseSnapshot(
              roomId,
              candidate,
            );
            if (!persisted) return;
          }

          publishCandidate(
            candidate,
            document,
            shouldTransition
              ? "architect/server-presence-transition"
              : "architect/server-presence-vote",
          );
        } finally {
          candidate.destroy();
        }
      }
    });
  };

  const scheduleMembershipRecompute = (roomId: string) => {
    membershipDirty.add(roomId);
    if (membershipTasks.has(roomId)) return;

    const run = (async () => {
      while (membershipDirty.delete(roomId)) {
        await recomputePresence(roomId);
      }
    })();
    let handled!: Promise<void>;
    handled = run
      .catch((error) => {
        membershipFailures.push(
          new AggregateError([error], "Vote membership recomputation failed"),
        );
      })
      .finally(() => {
        membershipTasks.delete(roomId);
        if (!destroyed && membershipDirty.has(roomId)) {
          scheduleMembershipRecompute(roomId);
        }
      });
    membershipTasks.set(roomId, handled);
  };

  const unsubscribe = awarenessRegistry.subscribeMembership((roomId) => {
    if (!destroyed) scheduleMembershipRecompute(roomId);
  });

  const settle = async () => {
    while (membershipTasks.size > 0 || phaseRetryTasks.size > 0) {
      await Promise.all([
        ...membershipTasks.values(),
        ...phaseRetryTasks.values(),
      ]);
    }
    const failures = [
      ...membershipFailures.splice(0),
      ...phaseRetryFailures.splice(0),
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Vote service background work failed");
    }
  };

  return {
    castVote(roomId: string, participantId: string, kind: VoteKind) {
      return mutate(roomId, participantId, kind, true);
    },
    removeVote(roomId: string, participantId: string, kind: VoteKind) {
      return mutate(roomId, participantId, kind, false);
    },
    claimTransition,
    settle,
    destroy(): Promise<void> {
      destroyPromise ??= (async () => {
        destroyed = true;
        unsubscribe();
        await settle();
      })();
      return destroyPromise;
    },
  };
}

export type VoteService = ReturnType<typeof createVoteService>;
