// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  READINESS_THRESHOLD,
  SERVER_VOTES_MAP_KEY,
  evaluateVote,
  type RoomSummary,
} from "@architect/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";

const reconstruction = vi.hoisted(() => ({
  begin: vi.fn().mockResolvedValue(undefined),
  discover: vi.fn().mockResolvedValue(undefined),
  retry: vi.fn().mockResolvedValue(undefined),
  state: { status: "idle" as const },
}));

vi.mock("./useReconstruction.js", () => ({
  useReconstruction: () => reconstruction,
}));

import { ReadinessVote } from "./ReadinessVote.js";

const room: RoomSummary = {
  id: "room-a",
  mode: "shared",
  phase: "sketch",
  isOwner: false,
  currentParticipantId: "participant-a",
  participants: [
    { id: "participant-a", name: "Ada", color: "#123456" },
    { id: "participant-b", name: "Grace", color: "#654321" },
  ],
};

function snapshot(voterIds: string[], active = ["participant-a", "participant-b"]) {
  return evaluateVote({
    activeParticipantIds: active,
    voterIds,
    threshold: READINESS_THRESHOLD,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  reconstruction.begin.mockClear();
  reconstruction.discover.mockClear();
  reconstruction.retry.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ReadinessVote", () => {
  it("submits once, shows pending progress, and trusts the validated server response", async () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot([]));
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(
      <ReadinessVote
        doc={doc}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );

    expect(screen.getByText("0 of 2 ready")).toBeVisible();
    const button = screen.getByRole("button", { name: "I’m ready" });
    await user.dblClick(button);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/rooms/room-a/votes/ready",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Submitting readiness…");

    await act(async () => {
      pending.resolve(
        await jsonResponse({
          kind: "ready",
          phase: "sketch",
          snapshot: snapshot(["participant-a"]),
          transition: null,
        }),
      );
    });
    expect(screen.getByText("1 of 2 ready")).toBeVisible();
    expect(screen.getByRole("button", { name: "Withdraw readiness" })).toBeEnabled();
    doc.destroy();
  });

  it("uses DELETE to withdraw and never invents a transition", async () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot(["participant-a"]));
    const fetch = vi.fn().mockImplementation(() =>
      jsonResponse({
        kind: "ready",
        phase: "sketch",
        snapshot: snapshot([]),
        transition: null,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(
      <ReadinessVote
        doc={doc}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Withdraw readiness" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/rooms/room-a/votes/ready",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(await screen.findByText("0 of 2 ready")).toBeVisible();
    doc.destroy();
  });

  it("shows a stable error and retries the same action", async () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot([]));
    const fetch = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse(
          { code: "vote_unavailable", message: "Vote unavailable" },
          503,
        ),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          kind: "ready",
          phase: "sketch",
          snapshot: snapshot(["participant-a"]),
          transition: null,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(
      <ReadinessVote
        doc={doc}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );

    await user.click(screen.getByRole("button", { name: "I’m ready" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Vote unavailable");
    await user.click(screen.getByRole("button", { name: "Retry readiness vote" }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("1 of 2 ready")).toBeVisible();
    doc.destroy();
  });

  it("normalizes malformed success JSON without exposing parser internals", async () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot([]));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not-json", {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );
    const user = userEvent.setup();
    render(
      <ReadinessVote
        doc={doc}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );

    await user.click(screen.getByRole("button", { name: "I’m ready" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Readiness vote could not be saved",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("JSON");
    doc.destroy();
  });

  it("ignores invalid and local forged shared values without granting phase authority", () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot([]));
    const onPhaseChange = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(
      <ReadinessVote
        doc={doc}
        onPhaseChange={onPhaseChange}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );

    act(() => {
      doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", {
        tally: 99,
        total: 1,
        ratio: 99,
        met: true,
        threshold: READINESS_THRESHOLD,
        voterIds: ["attacker"],
      });
    });
    expect(screen.getByText("0 of 2 ready")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Shared readiness status is invalid",
    );

    act(() => {
      doc.getMap(SERVER_VOTES_MAP_KEY).set(
        "ready",
        snapshot(["participant-a", "participant-b"]),
      );
    });
    expect(onPhaseChange).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    doc.destroy();
  });

  it("confirms a remote threshold with durable room HTTP state before changing phase", async () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot(["participant-a"]));
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetch);
    const onPhaseChange = vi.fn();
    render(
      <ReadinessVote
        doc={doc}
        onPhaseChange={onPhaseChange}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.getMap(SERVER_VOTES_MAP_KEY).set(
      "ready",
      snapshot(["participant-a", "participant-b"]),
    );

    act(() => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
    });
    expect(screen.getByText("2 of 2 ready")).toBeVisible();
    expect(onPhaseChange).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "/api/rooms/room-a",
      expect.objectContaining({ credentials: "same-origin" }),
    );

    await act(async () => {
      pending.resolve(
        await jsonResponse({ ...room, phase: "reconstructing" }),
      );
    });
    expect(onPhaseChange).toHaveBeenCalledWith("reconstructing");
    remote.destroy();
    doc.destroy();
  });

  it("retries durable phase confirmation without submitting another vote", async () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot(["participant-a"]));
    const fetch = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse({ code: "vote_unavailable", message: "Unavailable" }, 503),
      )
      .mockImplementationOnce(() =>
        jsonResponse({ ...room, phase: "reconstructing" }),
      );
    vi.stubGlobal("fetch", fetch);
    const onPhaseChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ReadinessVote
        doc={doc}
        onPhaseChange={onPhaseChange}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.getMap(SERVER_VOTES_MAP_KEY).set(
      "ready",
      snapshot(["participant-a", "participant-b"]),
    );

    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote)));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "room phase could not be confirmed",
    );
    await user.click(
      screen.getByRole("button", { name: "Retry room phase confirmation" }),
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/rooms/room-a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(onPhaseChange).toHaveBeenCalledWith("reconstructing");
    remote.destroy();
    doc.destroy();
  });

  it("automatically retries phase confirmation with bounded backoff", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot(["participant-a"]));
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({ code: "offline" }, 503))
      .mockImplementationOnce(() =>
        jsonResponse({ ...room, phase: "reconstructing" }),
      );
    vi.stubGlobal("fetch", fetch);
    const onPhaseChange = vi.fn();
    render(
      <ReadinessVote
        doc={doc}
        onPhaseChange={onPhaseChange}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.getMap(SERVER_VOTES_MAP_KEY).set(
      "ready",
      snapshot(["participant-a", "participant-b"]),
    );

    await act(async () => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onPhaseChange).toHaveBeenCalledWith("reconstructing");
    remote.destroy();
    doc.destroy();
  });

  it("cancels an automatic phase confirmation retry on unmount", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot(["participant-a"]));
    const fetch = vi.fn().mockImplementation(() =>
      jsonResponse({ code: "offline" }, 503),
    );
    vi.stubGlobal("fetch", fetch);
    const view = render(
      <ReadinessVote
        doc={doc}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.getMap(SERVER_VOTES_MAP_KEY).set(
      "ready",
      snapshot(["participant-a", "participant-b"]),
    );

    await act(async () => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    view.unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    remote.destroy();
    doc.destroy();
  });

  it("confirms an initially met shared snapshot against durable room state", async () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set(
      "ready",
      snapshot(["participant-a", "participant-b"]),
    );
    const fetch = vi.fn().mockImplementation(() =>
      jsonResponse({ ...room, phase: "reconstructing" }),
    );
    vi.stubGlobal("fetch", fetch);
    const onPhaseChange = vi.fn();
    render(
      <ReadinessVote
        doc={doc}
        onPhaseChange={onPhaseChange}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );

    expect(await screen.findByText("2 of 2 ready")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      "/api/rooms/room-a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(onPhaseChange).toHaveBeenCalledWith("reconstructing");
    doc.destroy();
  });

  it("uses a reconstructing mutation response as phase authority", async () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot([] as string[], ["participant-a"]));
    const fetch = vi.fn().mockImplementation(() =>
      jsonResponse({
        kind: "ready",
        phase: "reconstructing",
        snapshot: snapshot(["participant-a"], ["participant-a"]),
        transition: {
          claimed: true,
          jobId: "job-a",
          sourceSnapshotVersion: 1,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const onPhaseChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ReadinessVote
        doc={doc}
        onPhaseChange={onPhaseChange}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );

    await user.click(screen.getByRole("button", { name: "I’m ready" }));
    expect(onPhaseChange).toHaveBeenCalledWith("reconstructing");
    expect(reconstruction.begin).toHaveBeenCalledWith({
      claimed: true,
      jobId: "job-a",
      sourceSnapshotVersion: 1,
    });
    expect(screen.getByText("Consensus reached. Reconstruction is starting.")).toBeVisible();
    doc.destroy();
  });

  it("discovers durable work when mounted in reconstructing phase", async () => {
    const doc = new Y.Doc();
    render(
      <ReadinessVote
        doc={doc}
        participantId="participant-a"
        phase="reconstructing"
        roomId={room.id}
      />,
    );
    await vi.waitFor(() => expect(reconstruction.discover).toHaveBeenCalledOnce());
    doc.destroy();
  });

  it("cleans its listener so a later remote threshold does not fetch", () => {
    const doc = new Y.Doc();
    doc.getMap(SERVER_VOTES_MAP_KEY).set("ready", snapshot([]));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const view = render(
      <ReadinessVote
        doc={doc}
        participantId="participant-a"
        phase="sketch"
        roomId={room.id}
      />,
    );
    view.unmount();
    const remote = new Y.Doc();
    remote.getMap(SERVER_VOTES_MAP_KEY).set(
      "ready",
      snapshot(["participant-a", "participant-b"]),
    );

    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote)));
    expect(fetch).not.toHaveBeenCalled();
    remote.destroy();
    doc.destroy();
  });
});
