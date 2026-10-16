import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";

const keyLength = 64;
const saltLength = 16;
const legacyOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const currentProfile = "N=131072,r=8,p=1";
const currentOptions = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const maxPasswordCodePoints = 1_024;
const maxPasswordBytes = 4_096;
const maxConcurrentKdfs = 2;
const maxQueuedKdfs = 8;
const kdfWaiters: Array<() => void> = [];
let activeKdfs = 0;

function hasValidInput(password: string): boolean {
  return (
    typeof password === "string" &&
    [...password].length <= maxPasswordCodePoints &&
    Buffer.byteLength(password, "utf8") <= maxPasswordBytes
  );
}

async function acquireKdfSlot(): Promise<() => void> {
  if (activeKdfs < maxConcurrentKdfs) {
    activeKdfs += 1;
    return releaseKdfSlot;
  }
  if (kdfWaiters.length >= maxQueuedKdfs) throw new ServiceUnavailableException("Logowanie jest chwilowo niedostępne");
  await new Promise<void>((resolve) => kdfWaiters.push(resolve));
  return releaseKdfSlot;
}

function releaseKdfSlot(): void {
  const next = kdfWaiters.shift();
  if (next) next();
  else activeKdfs = Math.max(0, activeKdfs - 1);
}

async function derive(
  password: string,
  salt: Buffer,
  options: typeof currentOptions | typeof legacyOptions,
): Promise<Buffer> {
  const release = await acquireKdfSlot();
  try {
    return await new Promise((resolve, reject) => {
      scrypt(password, salt, keyLength, options, (error, key) => {
        if (error) reject(error);
        else resolve(key as Buffer);
      });
    });
  } finally {
    release();
  }
}

type ParsedHash = Readonly<{ salt: Buffer; key: Buffer; current: boolean }>;

function parseEncodedHash(encoded: string): ParsedHash | null {
  if (encoded.length > 192) return null;
  const fields = encoded.split("$");
  let saltText: string | undefined;
  let keyText: string | undefined;
  let current = false;
  if (fields.length === 3 && fields[0] === "scrypt") {
    [, saltText, keyText] = fields;
  } else if (fields.length === 5 && fields[0] === "scrypt" && fields[1] === "v1" && fields[2] === currentProfile) {
    [, , , saltText, keyText] = fields;
    current = true;
  } else return null;
  if (!saltText || !keyText || !/^[A-Za-z0-9_-]+$/.test(saltText) || !/^[A-Za-z0-9_-]+$/.test(keyText)) return null;
  const salt = Buffer.from(saltText, "base64url");
  const key = Buffer.from(keyText, "base64url");
  if (
    salt.length !== saltLength ||
    key.length !== keyLength ||
    salt.toString("base64url") !== saltText ||
    key.toString("base64url") !== keyText
  )
    return null;
  return { salt, key, current };
}

export async function hashPassword(password: string): Promise<string> {
  if (!hasValidInput(password) || password.length === 0) throw new Error("PASSWORD_INPUT_INVALID");
  const salt = randomBytes(saltLength);
  const derived = await derive(password, salt, currentOptions);
  return `scrypt$v1$${currentProfile}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function dummyVerifyPassword(password: string): Promise<false> {
  if (!hasValidInput(password)) return false;
  const salt = Buffer.from("dummy-pass-salt!", "utf8");
  const actual = await derive(password, salt, currentOptions);
  const dummy = Buffer.alloc(keyLength, 0xa5);
  timingSafeEqual(actual, dummy);
  return false;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!hasValidInput(password) || password.length === 0 || typeof encoded !== "string") return false;
  const parsed = parseEncodedHash(encoded);
  if (!parsed) return dummyVerifyPassword(password);
  const actual = await derive(password, parsed.salt, parsed.current ? currentOptions : legacyOptions);
  return timingSafeEqual(actual, parsed.key);
}

export function needsRehash(encoded: string): boolean {
  return !parseEncodedHash(encoded)?.current;
}
