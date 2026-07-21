"use client";

import {
  AwarenessProfileSchema,
  type AwarenessIdentity,
  type AwarenessProfile,
} from "@architect/contracts";
import { useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";

type UsePresenceOptions = {
  awareness: Awareness | null;
  heartbeatMs?: number;
  now?: () => number;
  profile: AwarenessIdentity;
};

function profilesFromAwareness(awareness: Awareness): AwarenessProfile[] {
  return [...awareness.getStates().values()]
    .flatMap((state) => {
      const parsed = AwarenessProfileSchema.safeParse(state.profile);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((left, right) =>
      left.participantId.localeCompare(right.participantId),
    );
}

export function usePresence({
  awareness,
  heartbeatMs = 15_000,
  now = Date.now,
  profile,
}: UsePresenceOptions): AwarenessProfile[] {
  const [profiles, setProfiles] = useState<AwarenessProfile[]>([]);
  const nowRef = useRef(now);
  nowRef.current = now;
  const { participantId, name, color, cursor, phase } = profile;

  useEffect(() => {
    if (!awareness) {
      setProfiles([]);
      return;
    }
    const publish = () => {
      awareness.setLocalStateField("profile", {
        participantId,
        name,
        color,
        ...(cursor ? { cursor } : {}),
        phase,
        lastSeenAt: new Date(nowRef.current()).toISOString(),
      });
    };
    const update = () => setProfiles(profilesFromAwareness(awareness));

    awareness.on("change", update);
    publish();
    update();
    const heartbeat = setInterval(publish, heartbeatMs);

    return () => {
      clearInterval(heartbeat);
      awareness.off("change", update);
      awareness.setLocalState(null);
    };
  }, [
    awareness,
    color,
    cursor?.x,
    cursor?.y,
    heartbeatMs,
    name,
    participantId,
    phase,
  ]);

  return profiles;
}
