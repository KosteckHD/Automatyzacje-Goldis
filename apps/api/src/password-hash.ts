import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const keyLength = 64;
const saltLength = 16;
const scryptOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, scryptOptions, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length > 1024) throw new Error("PASSWORD_INPUT_INVALID");
  const salt = randomBytes(saltLength);
  const derived = await derive(password, salt);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!password || password.length > 1024 || typeof encoded !== "string") return false;
  const [algorithm, saltText, keyText, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !keyText || extra !== undefined
    || !/^[A-Za-z0-9_-]+$/.test(saltText) || !/^[A-Za-z0-9_-]+$/.test(keyText)) return false;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(keyText, "base64url");
  if (salt.length !== saltLength || expected.length !== keyLength) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected);
}
