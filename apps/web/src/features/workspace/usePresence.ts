"use client";

import {
  AwarenessIdentitySchema,
  ServerPresenceSnapshotSchema,
  type AwarenessIdentity,
  type AwarenessProfile,
} from "@architect/contracts";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useRef, useState } from "react";

type UsePresenceOptions = {
  heartbeatMs?: number;
  now?: () => number;
  profile: AwarenessIdentity;
  provider: HocuspocusProvider | null;
};

function validateClock(now: () => number): void {
  const timestamp = now();
  if (!Number.isFinite(timestamp)) throw new Error("Invalid presence clock");
  try {
    new Date(timestamp).toISOString();
  } catch {
    throw new Error("Invalid presence clock");
  }
}

export function usePresence({
  heartbeatMs = 15_000,
  now = Date.now,
  profile,
  provider,
}: UsePresenceOptions): AwarenessProfile[] {
  const identity = AwarenessIdentitySchema.safeParse(profile);
  if (!identity.success) throw new Error("Invalid awareness identity");
  if (
    !Number.isFinite(heartbeatMs) ||
    heartbeatMs < 250 ||
    heartbeatMs > 60_000
  ) {
    throw new Error("Invalid presence heartbeat interval");
  }
  validateClock(now);

  const [profiles, setProfiles] = useState<AwarenessProfile[]>([]);
  const nowRef = useRef(now);
  nowRef.current = now;
  const { cursor, phase } = identity.data;
  const presenceRef = useRef({ cursor, phase });
  presenceRef.current = { cursor, phase };
  const publishRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const awareness = provider?.awareness;
    if (!provider || !awareness) {
      publishRef.current = () => undefined;
      setProfiles([]);
      return;
    }

    const publish = () => {
      try {
        validateClock(nowRef.current);
      } catch {
        return;
      }
      const current = presenceRef.current;
      awareness.setLocalState({
        ...(awareness.getLocalState() ?? {}),
        presence: {
          ...(current.cursor ? { cursor: current.cursor } : {}),
          phase: current.phase,
        },
      });
    };
    const receiveSnapshot = ({ payload }: { payload: string }) => {
      let candidate: unknown;
      try {
        candidate = JSON.parse(payload);
      } catch {
        return;
      }
      const snapshot = ServerPresenceSnapshotSchema.safeParse(candidate);
      if (
        !snapshot.success ||
        snapshot.data.roomId !== provider.configuration.name
      ) {
        return;
      }
      setProfiles(
        [...snapshot.data.profiles].sort((left, right) =>
          left.participantId.localeCompare(right.participantId),
        ),
      );
    };

    setProfiles([]);
    publishRef.current = publish;
    provider.on("stateless", receiveSnapshot);
    publish();
    const heartbeat = setInterval(publish, heartbeatMs);

    return () => {
      publishRef.current = () => undefined;
      clearInterval(heartbeat);
      provider.off("stateless", receiveSnapshot);
      awareness.setLocalState(null);
    };
  }, [provider, heartbeatMs]);

  useEffect(() => {
    publishRef.current();
  }, [provider, cursor?.x, cursor?.y, phase]);

  return profiles;
}
