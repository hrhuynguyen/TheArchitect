"use client";

import type { RoomSummary } from "@architect/contracts";
import { Button, StatusBadge } from "@architect/ui";
import dynamic from "next/dynamic";
import { use, useEffect, useState } from "react";
import { RoomApiError, roomApi } from "../../../features/rooms/api";
import { visibleWorkspacePhase } from "../../../features/workspace/PhaseRail";
import { WorkspaceShell } from "../../../features/workspace/WorkspaceShell";

const Whiteboard = dynamic(
  () =>
    import("../../../features/sketch/Whiteboard").then(
      (module) => module.Whiteboard,
    ),
  {
    loading: () => (
      <div className="whiteboard-state">
        <p role="status">Loading drawing tools…</p>
      </div>
    ),
    ssr: false,
  },
);

type RoomPageProps = {
  params: Promise<{ roomId: string }>;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; room: RoomSummary }
  | { status: "not-found" }
  | { status: "error"; message: string };

const phaseContent = {
  sketch: {
    kicker: "Sketch workspace ready",
    heading: "Start with the shape of the system.",
    description:
      "The guided canvas will hold the shared model here. Your room and its participants are already durable.",
  },
  architect: {
    kicker: "Architect workspace ready",
    heading: "Shape the system into a buildable plan.",
    description: "Architecture decisions and constraints will stay visible here.",
  },
  deploy: {
    kicker: "Deploy workspace ready",
    heading: "Move forward with the evidence in view.",
    description: "Deployment controls and evidence will stay visible here.",
  },
} as const;

export default function RoomPage({ params }: RoomPageProps) {
  const { roomId } = use(params);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });

    roomApi.get(roomId).then(
      (room) => {
        if (active) setState({ status: "ready", room });
      },
      (reason: unknown) => {
        if (!active) return;
        if (reason instanceof RoomApiError && reason.status === 404) {
          setState({ status: "not-found" });
          return;
        }
        setState({
          status: "error",
          message:
            reason instanceof Error ? reason.message : "Unable to open this workspace.",
        });
      },
    );

    return () => {
      active = false;
    };
  }, [roomId, attempt]);

  if (state.status === "loading") {
    return (
      <main className="route-state" aria-busy="true">
        <span className="route-state__pulse" aria-hidden="true" />
        <p role="status">Opening your workspace…</p>
      </main>
    );
  }

  if (state.status === "not-found") {
    return (
      <main className="route-state">
        <StatusBadge tone="warning">Room not found</StatusBadge>
        <h1>This workspace is no longer here.</h1>
        <p>Check the shared link, or begin again in a new durable room.</p>
        <a className="button-link button-link--primary" href="/start">Start a room</a>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="route-state">
        <StatusBadge tone="warning">Connection issue</StatusBadge>
        <h1>We couldn’t open the workspace.</h1>
        <p role="alert">{state.message}</p>
        <div className="route-state__actions">
          <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
          <a className="text-link" href="/start">Return to start</a>
        </div>
      </main>
    );
  }

  const { room } = state;
  const visiblePhase = visibleWorkspacePhase(room.phase);
  const content = phaseContent[visiblePhase];
  return (
    <WorkspaceShell
      room={room}
      contextPanel={
        <>
          <p className="workspace-context__eyebrow">Room access</p>
          <h2>{room.isOwner ? "You own this room" : "You joined this room"}</h2>
          <p>
            {room.mode === "solo"
              ? "This durable workspace is private and cannot accept collaborators."
              : "Share this path to invite another collaborator."}
          </p>
          {room.mode === "shared" ? (
            <code className="room-path">/room/{room.id}</code>
          ) : null}
        </>
      }
    >
      {visiblePhase === "sketch" ? (
        <div className="workspace-sketch" id="sketch">
          <Whiteboard room={room} />
        </div>
      ) : (
        <div className="workspace-empty" id={visiblePhase}>
          <span className="workspace-empty__mark" aria-hidden="true" />
          <p className="section-kicker">{content.kicker}</p>
          <h1>{content.heading}</h1>
          <p>{content.description}</p>
        </div>
      )}
    </WorkspaceShell>
  );
}
