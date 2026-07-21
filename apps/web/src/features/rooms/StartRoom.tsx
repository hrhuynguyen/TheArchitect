"use client";

import { ParticipantProfileSchema, type RoomMode } from "@architect/contracts";
import { Button, Field, StatusBadge } from "@architect/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { roomApi, type RoomApi } from "./api";
import {
  DEFAULT_PROFILE_COLOR,
  loadGuestProfile,
  saveGuestProfile,
} from "./profile";

type StartRoomProps = {
  api?: RoomApi;
  onRoomReady?: (roomId: string) => void;
};

type PendingAction = RoomMode | "join" | null;

function decodedRoomId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function roomIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/room\/([^/]+)$/);
  return match ? decodedRoomId(match[1]!) : null;
}

function roomIdFromInput(value: string): string | null {
  if (!value || value !== value.trim() || /\s/.test(value)) return null;

  if (/^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.search || url.hash) return null;
      return roomIdFromPath(url.pathname);
    } catch {
      return null;
    }
  }

  if (value.includes("://")) return null;
  if (value.startsWith("/room/") || value.startsWith("room/")) {
    return roomIdFromPath(value.startsWith("/") ? value : `/${value}`);
  }
  return decodedRoomId(value);
}

export function StartRoom({ api = roomApi, onRoomReady }: StartRoomProps) {
  const [name, setName] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const [roomInput, setRoomInput] = useState("");
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const requestGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const profile = loadGuestProfile();
    if (profile) setName(profile.name);
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  const profile = useMemo(
    () => ParticipantProfileSchema.safeParse({ name, color: DEFAULT_PROFILE_COLOR }),
    [name],
  );
  const canContinue = profile.success && pending === null;
  const parsedRoomId = roomIdFromInput(roomInput);

  function navigate(roomId: string) {
    if (onRoomReady) onRoomReady(roomId);
    else window.location.assign(`/room/${encodeURIComponent(roomId)}`);
  }

  function isCurrentRequest(generation: number) {
    return mounted.current && requestGeneration.current === generation;
  }

  async function create(mode: RoomMode) {
    if (!profile.success) return;
    const generation = ++requestGeneration.current;
    setError(null);
    setPending(mode);
    try {
      const created = await api.create(profile.data, mode);
      if (!isCurrentRequest(generation)) return;
      saveGuestProfile(profile.data);
      navigate(created.id);
    } catch (reason) {
      if (!isCurrentRequest(generation)) return;
      setError(reason instanceof Error ? reason.message : "Unable to create the room.");
    } finally {
      if (isCurrentRequest(generation)) setPending(null);
    }
  }

  async function join() {
    if (!profile.success || !parsedRoomId) return;
    const generation = ++requestGeneration.current;
    setError(null);
    setPending("join");
    try {
      const joined = await api.join(parsedRoomId, profile.data);
      if (!isCurrentRequest(generation)) return;
      saveGuestProfile(profile.data);
      navigate(joined.id);
    } catch (reason) {
      if (!isCurrentRequest(generation)) return;
      setError(reason instanceof Error ? reason.message : "Unable to join the room.");
    } finally {
      if (isCurrentRequest(generation)) setPending(null);
    }
  }

  return (
    <section className="start-room" aria-labelledby="start-room-title">
      <div className="start-room__heading">
        <StatusBadge tone="success">No account required</StatusBadge>
        <h1 id="start-room-title">How do you want to begin?</h1>
        <p>
          Choose a display name, then open a shared workspace or keep the room to
          yourself.
        </p>
      </div>

      <Field
        label="Display name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={60}
        autoComplete="nickname"
        placeholder="Ada"
        hint="This is shown to collaborators in this room."
      />

      <div className="start-room__actions">
        <Button
          type="button"
          disabled={!canContinue}
          isLoading={pending === "shared"}
          loadingLabel="Creating room…"
          onClick={() => void create("shared")}
        >
          Create shared room
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!canContinue}
          aria-expanded={joinOpen}
          aria-controls="join-room-fields"
          onClick={() => {
            setJoinOpen((open) => !open);
            setError(null);
          }}
        >
          Join room
        </Button>
        <Button
          type="button"
          variant="quiet"
          disabled={!canContinue}
          isLoading={pending === "solo"}
          loadingLabel="Opening solo room…"
          onClick={() => void create("solo")}
        >
          Work alone
        </Button>
      </div>

      {joinOpen ? (
        <div className="start-room__join" id="join-room-fields">
          <Field
            label="Room ID or link"
            value={roomInput}
            onChange={(event) => setRoomInput(event.target.value)}
            autoComplete="off"
            placeholder="Paste a room link"
          />
          <Button
            type="button"
            disabled={!canContinue || !parsedRoomId}
            isLoading={pending === "join"}
            loadingLabel="Joining workspace…"
            onClick={() => void join()}
          >
            Join workspace
          </Button>
        </div>
      ) : null}

      {error ? <p role="alert" className="start-room__error">{error}</p> : null}
      <p className="start-room__authority">
        Your profile is saved on this device for convenience. Secure room access is
        always verified by the server.
      </p>
    </section>
  );
}
