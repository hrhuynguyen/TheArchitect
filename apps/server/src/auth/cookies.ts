type NodeEnvironment = "development" | "test" | "production";

export type RoomCookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
};

export function ownerCookieName(roomId: string): string {
  return `architect_owner_${roomId}`;
}

export function participantCookieName(roomId: string): string {
  return `architect_participant_${roomId}`;
}

export function roomCookieOptions(
  _roomId: string,
  nodeEnvironment: NodeEnvironment,
): RoomCookieOptions {
  return {
    httpOnly: true,
    secure: nodeEnvironment === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
}

export function serializeRoomCookie(
  name: string,
  value: string,
  options: RoomCookieOptions,
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
  ];

  if (options.httpOnly) attributes.push("HttpOnly");
  if (options.secure) attributes.push("Secure");
  if (options.sameSite === "lax") attributes.push("SameSite=Lax");

  return attributes.join("; ");
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      continue;
    }
  }

  return cookies;
}
