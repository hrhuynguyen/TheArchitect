"use client";

import type {
  AwarenessCursor,
  ParticipantSummary,
  RoomSummary,
} from "@architect/contracts";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { createTLStore, Tldraw, type Editor, type TLStore } from "tldraw";
import "tldraw/tldraw.css";
import { createRoomCollab } from "../workspace/collab";
import { CursorOverlay } from "../workspace/CursorOverlay";
import { MemberStrip } from "../workspace/MemberStrip";
import { usePresence } from "../workspace/usePresence";
import { createBoundedCursorPublisher } from "./cursorPublisher";
import { RequirementsPanel } from "./RequirementsPanel";
import { createTldrawBinding } from "./tldrawBinding";

type WhiteboardProps = {
  room: RoomSummary;
};

type CanvasState = "connecting" | "ready" | "error";

export function Whiteboard({ room }: WhiteboardProps) {
  const localParticipant = room.currentParticipantId
    ? room.participants.find(
        (participant) => participant.id === room.currentParticipantId,
      )
    : undefined;
  if (!localParticipant) {
    return (
      <div className="whiteboard-state">
        <p role="alert">
          Your room session is unavailable. Join the room again to collaborate.
        </p>
      </div>
    );
  }

  return <ConnectedWhiteboard localParticipant={localParticipant} room={room} />;
}

function ConnectedWhiteboard({
  localParticipant,
  room,
}: WhiteboardProps & { localParticipant: ParticipantSummary }) {
  const [canvasState, setCanvasState] = useState<CanvasState>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<AwarenessCursor | undefined>();
  const [doc, setDoc] = useState<import("yjs").Doc | null>(null);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [store, setStore] = useState<TLStore | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const cursorPublisherRef = useRef<
    ReturnType<typeof createBoundedCursorPublisher> | undefined
  >(undefined);

  const identity = useMemo(
    () => ({
      participantId: localParticipant.id,
      name: localParticipant.name,
      color: localParticipant.color,
      phase: "sketch" as const,
      ...(cursor ? { cursor } : {}),
    }),
    [cursor, localParticipant.color, localParticipant.id, localParticipant.name],
  );
  const profiles = usePresence({ profile: identity, provider });

  useEffect(() => {
    const publisher = createBoundedCursorPublisher({
      intervalMs: 50,
      onPublish: setCursor,
    });
    cursorPublisherRef.current = publisher;
    return () => {
      publisher.clear();
      cursorPublisherRef.current = undefined;
      publisher.destroy();
    };
  }, [room.id]);

  useEffect(() => {
    let active = true;
    let drawingStore: TLStore | null = null;
    let binding: ReturnType<typeof createTldrawBinding> | null = null;

    setCanvasState("connecting");
    setConnectionError(null);
    setDoc(null);
    setProvider(null);
    setStore(null);
    editorRef.current = null;

    let collaboration: ReturnType<typeof createRoomCollab>;
    try {
      collaboration = createRoomCollab({ roomId: room.id });
    } catch {
      setCanvasState("error");
      setConnectionError("Shared canvas connection is unavailable.");
      return;
    }

    setDoc(collaboration.doc);
    setProvider(collaboration.provider);

    const startDrawing = () => {
      if (!active || drawingStore) return;
      try {
        drawingStore = createTLStore({ defaultName: "Architecture sketch" });
        binding = createTldrawBinding({
          doc: collaboration.doc,
          onError: () => {
            if (active) {
              setConnectionError("Some shared drawing data could not be loaded.");
            }
          },
          store: drawingStore,
        });
        setStore(drawingStore);
        setCanvasState("ready");
        setConnectionError(null);
      } catch {
        binding?.destroy();
        binding = null;
        drawingStore?.dispose();
        drawingStore = null;
        setCanvasState("error");
        setConnectionError("Shared canvas data could not be opened.");
      }
    };
    const receiveSynced = ({ state }: { state: boolean }) => {
      if (state) startDrawing();
    };
    const receiveStatus = ({ status }: { status: string }) => {
      if (!active) return;
      if (status === "disconnected") {
        setConnectionError(
          "Shared canvas connection is unavailable. Retrying…",
        );
      } else if (status === "connected") {
        setConnectionError(null);
      }
    };

    collaboration.provider.on("synced", receiveSynced);
    collaboration.provider.on("status", receiveStatus);
    if (collaboration.provider.synced) startDrawing();

    return () => {
      active = false;
      collaboration.provider.off("synced", receiveSynced);
      collaboration.provider.off("status", receiveStatus);
      binding?.destroy();
      drawingStore?.dispose();
      collaboration.destroy();
    };
  }, [room.id]);

  const publishPointer = (event: PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    cursorPublisherRef.current?.move({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  };

  if (canvasState === "error" || !doc) {
    return (
      <div className="whiteboard-state">
        {canvasState === "error" ? (
          <p role="alert">{connectionError}</p>
        ) : connectionError ? (
          <p role="alert">{connectionError}</p>
        ) : (
          <p role="status">Connecting shared canvas…</p>
        )}
      </div>
    );
  }

  if (canvasState !== "ready" || !store) {
    return (
      <div className="whiteboard-state">
        {connectionError ? (
          <p role="alert">{connectionError}</p>
        ) : (
          <p role="status">Connecting shared canvas…</p>
        )}
      </div>
    );
  }

  return (
    <div className="sketch-workspace">
      <section
        aria-label="Collaborative architecture sketch"
        className="whiteboard"
      >
        <header className="whiteboard__header">
          <div>
            <p className="section-kicker">Shared sketch</p>
            <h1>Map the system together.</h1>
          </div>
          <MemberStrip profiles={profiles} />
        </header>
        <div
          className="whiteboard__canvas"
          onPointerLeave={() => cursorPublisherRef.current?.clear()}
          onPointerMoveCapture={publishPointer}
        >
          <Tldraw
            onMount={(editor) => {
              editorRef.current = editor;
            }}
            store={store}
          />
          <CursorOverlay
            localParticipantId={localParticipant.id}
            profiles={profiles}
          />
        </div>
      </section>
      <RequirementsPanel connectionError={connectionError} doc={doc} />
    </div>
  );
}

export { captureWhiteboard } from "./captureWhiteboard";
