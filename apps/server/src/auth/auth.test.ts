import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ownerCookieName,
  participantCookieName,
  roomCookieOptions,
  serializeRoomCookie,
} from "./cookies.js";
import {
  createOwnerToken,
  hashOwnerToken,
  verifyOwnerToken,
} from "./ownerToken.js";
import { signParticipant, verifyParticipant } from "./participant.js";

const pepper = "p".repeat(32);
const signingSecret = "s".repeat(32);
const base64urlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function replaceHashPart(
  encodedHash: string,
  part: 1 | 2,
  replace: (encoded: string) => string,
): string {
  const components = encodedHash.split("$");
  components[part] = replace(components[part]!);
  return components.join("$");
}

function noncanonicalAlias(encoded: string): string {
  const lastIndex = encoded.length - 1;
  const canonicalIndex = base64urlAlphabet.indexOf(encoded[lastIndex]!);
  expect(canonicalIndex).toBeGreaterThanOrEqual(0);
  expect(canonicalIndex % 4).toBe(0);
  return `${encoded.slice(0, lastIndex)}${base64urlAlphabet[canonicalIndex + 1]}`;
}

describe("owner credentials", () => {
  it("creates distinct owner tokens from 32 random bytes", () => {
    const first = createOwnerToken();
    const second = createOwnerToken();

    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(second).not.toBe(first);
  });

  it("stores only a salted, non-reversible owner token hash", async () => {
    const token = createOwnerToken();
    const first = await hashOwnerToken(token, pepper);
    const second = await hashOwnerToken(token, pepper);

    expect(first).not.toContain(token);
    expect(second).not.toBe(first);
    expect(Buffer.from(first.split("$")[1]!, "base64url")).toHaveLength(16);
    await expect(verifyOwnerToken(token, first, pepper)).resolves.toBe(true);
  });

  it("rejects a wrong token or pepper through the fixed-length digest path", async () => {
    const token = createOwnerToken();
    const encoded = await hashOwnerToken(token, pepper);

    await expect(
      verifyOwnerToken(createOwnerToken(), encoded, pepper),
    ).resolves.toBe(false);
    await expect(
      verifyOwnerToken(token, encoded, "x".repeat(32)),
    ).resolves.toBe(false);
  });

  it("rejects malformed owner hashes without throwing", async () => {
    const token = createOwnerToken();

    await expect(verifyOwnerToken(token, "not-a-hash", pepper)).resolves.toBe(
      false,
    );
    await expect(
      verifyOwnerToken(token, "scrypt$bad$bad", pepper),
    ).resolves.toBe(false);
  });

  it.each([1, 2] as const)(
    "rejects invalid base64url characters in hash component %i",
    async (part) => {
      const token = createOwnerToken();
      const encoded = await hashOwnerToken(token, pepper);
      const malformed = replaceHashPart(
        encoded,
        part,
        (component) => `${component}!`,
      );

      expect(
        Buffer.from(malformed.split("$")[part]!, "base64url").equals(
          Buffer.from(encoded.split("$")[part]!, "base64url"),
        ),
      ).toBe(true);
      await expect(verifyOwnerToken(token, malformed, pepper)).resolves.toBe(
        false,
      );
    },
  );

  it.each([1, 2] as const)(
    "rejects padded base64url in hash component %i",
    async (part) => {
      const token = createOwnerToken();
      const encoded = await hashOwnerToken(token, pepper);
      const padded = replaceHashPart(
        encoded,
        part,
        (component) => `${component}==`,
      );

      await expect(verifyOwnerToken(token, padded, pepper)).resolves.toBe(false);
    },
  );

  it("rejects standard-base64 alternate encodings", async () => {
    const token = "fixture-owner-token";
    const salt = Buffer.alloc(16, 0xff);
    const secret = Buffer.concat([
      Buffer.from(token, "utf8"),
      Buffer.from(pepper, "utf8"),
    ]);
    const key = scryptSync(secret, salt, 64);
    const encoded = `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
    const alternate = encoded.replaceAll("-", "+").replaceAll("_", "/");

    await expect(verifyOwnerToken(token, encoded, pepper)).resolves.toBe(true);
    await expect(verifyOwnerToken(token, alternate, pepper)).resolves.toBe(
      false,
    );
  });

  it.each([1, 2] as const)(
    "rejects a noncanonical unused-bit alias in hash component %i",
    async (part) => {
      const token = createOwnerToken();
      const encoded = await hashOwnerToken(token, pepper);
      const alias = replaceHashPart(encoded, part, noncanonicalAlias);

      expect(
        Buffer.from(alias.split("$")[part]!, "base64url").equals(
          Buffer.from(encoded.split("$")[part]!, "base64url"),
        ),
      ).toBe(true);
      await expect(verifyOwnerToken(token, alias, pepper)).resolves.toBe(false);
    },
  );
});

describe("participant identity", () => {
  it("round-trips signed room-scoped participant claims", () => {
    const claims = { roomId: "room-1", participantId: "participant-1" };

    const cookie = signParticipant(claims, signingSecret);

    expect(cookie).not.toContain("room-1");
    expect(verifyParticipant(cookie, signingSecret)).toEqual(claims);
  });

  it("rejects tampering, a wrong secret, and malformed claims", () => {
    const cookie = signParticipant(
      { roomId: "room-1", participantId: "participant-1" },
      signingSecret,
    );
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("a") ? "b" : "a"}`;

    expect(() => verifyParticipant(tampered, signingSecret)).toThrow(
      "Invalid participant cookie",
    );
    expect(() => verifyParticipant(cookie, "x".repeat(32))).toThrow(
      "Invalid participant cookie",
    );
    expect(() => verifyParticipant("malformed", signingSecret)).toThrow(
      "Invalid participant cookie",
    );
  });
});

describe("room cookies", () => {
  it("uses distinct room-scoped owner and participant names", () => {
    expect(ownerCookieName("room-1")).toBe("architect_owner_room-1");
    expect(participantCookieName("room-1")).toBe(
      "architect_participant_room-1",
    );
    expect(ownerCookieName("room-2")).not.toBe(ownerCookieName("room-1"));
  });

  it("sets the required 30-day security attributes", () => {
    expect(roomCookieOptions("room-1", "development")).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    expect(roomCookieOptions("room-1", "production").secure).toBe(true);

    expect(
      serializeRoomCookie(
        participantCookieName("room-1"),
        "signed value",
        roomCookieOptions("room-1", "production"),
      ),
    ).toBe(
      "architect_participant_room-1=signed%20value; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });
});
