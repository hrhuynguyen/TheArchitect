import { describe, expect, it } from "vitest";
import {
  READINESS_THRESHOLD,
  TransitionClaimSchema,
  VoteMutationResponseSchema,
  VoteSnapshotSchema,
  evaluateVote,
} from "./voting.js";

describe("evaluateVote", () => {
  it("requires four of five active participants at the 80 percent threshold", () => {
    expect(
      evaluateVote({
        activeParticipantIds: ["a", "b", "c", "d", "e"],
        voterIds: ["a", "b", "c", "d"],
        threshold: 0.8,
      }),
    ).toEqual({
      tally: 4,
      total: 5,
      ratio: 0.8,
      met: true,
      threshold: READINESS_THRESHOLD,
      voterIds: ["a", "b", "c", "d"],
    });
  });

  it.each([
    {
      label: "just below the boundary",
      activeParticipantIds: ["a", "b", "c", "d"],
      voterIds: ["a", "b", "c"],
      expected: { tally: 3, total: 4, ratio: 0.75, met: false },
    },
    {
      label: "an empty active set",
      activeParticipantIds: [],
      voterIds: ["a"],
      expected: { tally: 0, total: 0, ratio: 0, met: false },
    },
    {
      label: "one active solo voter",
      activeParticipantIds: ["solo"],
      voterIds: ["solo"],
      expected: { tally: 1, total: 1, ratio: 1, met: true },
    },
  ])("handles $label exactly", ({ activeParticipantIds, voterIds, expected }) => {
    expect(
      evaluateVote({ activeParticipantIds, voterIds, threshold: 0.8 }),
    ).toMatchObject(expected);
  });

  it("deduplicates active participants and voters while dropping inactive voters", () => {
    expect(
      evaluateVote({
        activeParticipantIds: ["b", "a", "a", "c", "d", "e"],
        voterIds: ["e", "a", "a", "missing", "b"],
        threshold: 0.8,
      }),
    ).toEqual({
      tally: 3,
      total: 5,
      ratio: 0.6,
      met: false,
      threshold: READINESS_THRESHOLD,
      voterIds: ["a", "b", "e"],
    });
  });

  it.each([
    { activeParticipantIds: ["a"], voterIds: ["a"], threshold: Number.NaN },
    { activeParticipantIds: ["a"], voterIds: ["a"], threshold: Infinity },
    { activeParticipantIds: ["a"], voterIds: ["a"], threshold: 0 },
    { activeParticipantIds: ["a"], voterIds: ["a"], threshold: 0.79 },
    { activeParticipantIds: ["a"], voterIds: ["a"], threshold: 0.81 },
    { activeParticipantIds: ["a"], voterIds: ["a"], threshold: 1.01 },
    { activeParticipantIds: [""], voterIds: [], threshold: 0.8 },
    { activeParticipantIds: ["a"], voterIds: [""], threshold: 0.8 },
  ])("rejects invalid evaluation input: %o", (input) => {
    expect(() => evaluateVote(input)).toThrow();
  });
});

describe("vote contracts", () => {
  it("rejects invalid remote snapshots instead of granting authority", () => {
    expect(
      VoteSnapshotSchema.safeParse({
        tally: 5,
        total: 1,
        ratio: 5,
        met: true,
        threshold: READINESS_THRESHOLD,
        voterIds: ["attacker"],
      }).success,
    ).toBe(false);
  });

  it.each([
    { tally: 1, total: 5, ratio: 0.2, met: true },
    { tally: 4, total: 5, ratio: 0.8, met: false },
  ])("rejects a mathematically inconsistent met value: %o", (snapshot) => {
    expect(
      VoteSnapshotSchema.safeParse({
        ...snapshot,
        threshold: READINESS_THRESHOLD,
        voterIds: Array.from({ length: snapshot.tally }, (_, index) => `p-${index}`),
      }).success,
    ).toBe(false);
  });

  it.each([0.79, 0.81])(
    "rejects a forged canonical threshold %s",
    (threshold) => {
      expect(
        VoteSnapshotSchema.safeParse({
          tally: 0,
          total: 1,
          ratio: 0,
          met: false,
          threshold,
          voterIds: [],
        }).success,
      ).toBe(false);
    },
  );

  it("validates a readiness response without broadening transition kinds", () => {
    expect(
      VoteMutationResponseSchema.parse({
        kind: "ready",
        phase: "reconstructing",
        snapshot: {
          tally: 1,
          total: 1,
          ratio: 1,
          met: true,
          threshold: READINESS_THRESHOLD,
          voterIds: ["participant-a"],
        },
        transition: {
          claimed: true,
          jobId: "job-a",
          sourceSnapshotVersion: 7,
        },
      }),
    ).toMatchObject({ kind: "ready", phase: "reconstructing" });

    expect(
      VoteMutationResponseSchema.safeParse({
        kind: "deploy_aws",
        phase: "deploy",
        snapshot: {
          tally: 1,
          total: 1,
          ratio: 1,
          met: true,
          threshold: READINESS_THRESHOLD,
          voterIds: ["participant-a"],
        },
        transition: {
          claimed: true,
          jobId: "deploy-job",
          sourceSnapshotVersion: 7,
        },
      }).success,
    ).toBe(false);
  });

  it("requires the server-owned source snapshot version in a transition claim", () => {
    expect(
      TransitionClaimSchema.safeParse({ claimed: true, jobId: "job-a" })
        .success,
    ).toBe(false);
    expect(
      TransitionClaimSchema.parse({
        claimed: false,
        jobId: "job-a",
        sourceSnapshotVersion: 7,
      }),
    ).toEqual({
      claimed: false,
      jobId: "job-a",
      sourceSnapshotVersion: 7,
    });
  });

  it.each([
    {
      phase: "sketch",
      snapshot: {
        tally: 1,
        total: 1,
        ratio: 1,
        met: true,
        threshold: READINESS_THRESHOLD,
        voterIds: ["participant-a"],
      },
      transition: {
        claimed: true,
        jobId: "job-a",
        sourceSnapshotVersion: 7,
      },
    },
    {
      phase: "reconstructing",
      snapshot: {
        tally: 0,
        total: 1,
        ratio: 0,
        met: false,
        threshold: READINESS_THRESHOLD,
        voterIds: [],
      },
      transition: {
        claimed: false,
        jobId: "job-a",
        sourceSnapshotVersion: 7,
      },
    },
  ])("rejects inconsistent ready response authority: %o", (response) => {
    expect(
      VoteMutationResponseSchema.safeParse({ kind: "ready", ...response })
        .success,
    ).toBe(false);
  });
});
