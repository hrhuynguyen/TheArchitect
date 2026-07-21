import { createHmac, timingSafeEqual } from "node:crypto";

export type ParticipantClaims = {
  roomId: string;
  participantId: string;
};

const INVALID_COOKIE_MESSAGE = "Invalid participant cookie";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function invalidCookie(): never {
  throw new Error(INVALID_COOKIE_MESSAGE);
}

export function signParticipant(
  claims: ParticipantClaims,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const digest = signature(payload, secret).toString("base64url");

  return `${payload}.${digest}`;
}

export function verifyParticipant(
  cookie: string,
  secret: string,
): ParticipantClaims {
  const [payload, encodedSignature, extra] = cookie.split(".");
  if (
    !payload ||
    !encodedSignature ||
    extra !== undefined ||
    !BASE64URL.test(payload) ||
    !BASE64URL.test(encodedSignature)
  ) {
    return invalidCookie();
  }

  const expected = signature(payload, secret);
  const supplied = Buffer.from(encodedSignature, "base64url");
  const canonicalSignature = supplied.toString("base64url") === encodedSignature;
  const comparable =
    supplied.length === expected.length ? supplied : Buffer.alloc(expected.length);
  const validSignature = timingSafeEqual(expected, comparable);

  if (
    !canonicalSignature ||
    !validSignature ||
    supplied.length !== expected.length
  ) {
    return invalidCookie();
  }

  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      typeof claims !== "object" ||
      claims === null ||
      typeof (claims as ParticipantClaims).roomId !== "string" ||
      !(claims as ParticipantClaims).roomId ||
      typeof (claims as ParticipantClaims).participantId !== "string" ||
      !(claims as ParticipantClaims).participantId
    ) {
      return invalidCookie();
    }

    return {
      roomId: (claims as ParticipantClaims).roomId,
      participantId: (claims as ParticipantClaims).participantId,
    };
  } catch {
    return invalidCookie();
  }
}
