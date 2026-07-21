import {
  ParticipantProfileSchema,
  type ParticipantProfile,
} from "@architect/contracts";

export const DEFAULT_PROFILE_COLOR = "#10A37F";
export const PROFILE_STORAGE_KEY = "architect.guest-profile.v1";

type ProfileStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(storage?: ProfileStorage | null): ProfileStorage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function loadGuestProfile(
  storage?: ProfileStorage | null,
): ParticipantProfile | null {
  try {
    const stored = browserStorage(storage)?.getItem(PROFILE_STORAGE_KEY);
    if (!stored) return null;
    const result = ParticipantProfileSchema.safeParse(JSON.parse(stored));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function saveGuestProfile(
  profile: ParticipantProfile,
  storage?: ProfileStorage | null,
): void {
  const result = ParticipantProfileSchema.safeParse(profile);
  if (!result.success) return;

  try {
    browserStorage(storage)?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(result.data));
  } catch {
    // A local profile is only a convenience. Cookie authority remains server-side.
  }
}
