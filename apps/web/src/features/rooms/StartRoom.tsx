"use client";

import { ParticipantProfileSchema, type RoomMode } from "@architect/contracts";
import { Button, Field, StatusBadge } from "@architect/ui";
import { useEffect, useMemo, useState } from "react";
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

function roomIdFromInput(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  const pathMatch = input.match(/(?:^|\/)room\/([^/?#]+)/i);
  const candidate = pathMatch?.[1] ?? input.replace(/^\/+|\/+$/g, "");
  if (!candidate || candidate.includes("/") || /\s/.test(candidate)) return null;
  try {
    return decodeURIComponent(candidate);
  } catch {
    return null;
  }
}

export function StartRoom({ api = roomApi, onRoomReady }: StartRoomProps) {
  const [name, setName] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const [roomInput, setRoomInput] = useState("");
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const profile = loadGuestProfile();
    if (profile) setName(profile.name);
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

  async function create(mode: RoomMode) {
    if (!profile.success) return;
    setError(null);
    setPending(mode);
    try {
      const created = await api.create(profile.data, mode);
      saveGuestProfile(profile.data);
      navigate(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to create the room.");
    } finally {
      setPending(null);
    }
  }

  async function join() {
    if (!profile.success || !parsedRoomId) return;
    setError(null);
    setPending("join");
    try {
      const joined = await api.join(parsedRoomId, profile.data);
      saveGuestProfile(profile.data);
      navigate(joined.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to join the room.");
    } finally {
      setPending(null);
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
