import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const KEY_BYTES = 64;
const HASH_PREFIX = "scrypt";

function deriveKey(token: string, salt: Buffer, pepper: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const secret = Buffer.concat([
      Buffer.from(token, "utf8"),
      Buffer.from(pepper, "utf8"),
    ]);

    scrypt(secret, salt, KEY_BYTES, (error, key) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(key);
    });
  });
}

export function createOwnerToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export async function hashOwnerToken(
  token: string,
  pepper: string,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(token, salt, pepper);

  return `${HASH_PREFIX}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyOwnerToken(
  token: string,
  encodedHash: string,
  pepper: string,
): Promise<boolean> {
  const [algorithm, encodedSalt, encodedKey, extra] = encodedHash.split("$");
  if (
    algorithm !== HASH_PREFIX ||
    !encodedSalt ||
    !encodedKey ||
    extra !== undefined
  ) {
    return false;
  }

  const salt = Buffer.from(encodedSalt, "base64url");
  const expectedKey = Buffer.from(encodedKey, "base64url");
  if (salt.length !== SALT_BYTES || expectedKey.length !== KEY_BYTES) {
    return false;
  }

  try {
    const actualKey = await deriveKey(token, salt, pepper);
    return timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  }
}
