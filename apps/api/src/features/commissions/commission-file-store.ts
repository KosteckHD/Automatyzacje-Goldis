import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type ArtifactCryptoEnvironment, decryptStoredArtifactBytes, encryptArtifactBytes } from "../results/public";

function root(): string {
  const value = process.env.API_EXPORT_DIR;
  if (!value) throw new Error("COMMISSION_STORAGE_NOT_CONFIGURED");
  return resolve(value);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function writeCommissionFile(
  fileId: string,
  bytes: Uint8Array,
): Promise<{ storageKey: string; sizeBytes: number }> {
  const storageKey = `commission-files/${fileId}.blob`;
  const target = resolve(root(), storageKey);
  const temp = resolve(dirname(target), `.${fileId}.${randomUUID()}.tmp`);
  const stored = encryptArtifactBytes(fileId, bytes);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(stored);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, target);
    return { storageKey, sizeBytes: bytes.byteLength };
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw new Error("COMMISSION_FILE_STORE_FAILED");
  }
}

export async function readCommissionFile(
  fileId: string,
  storageKey: string,
  environment?: ArtifactCryptoEnvironment,
): Promise<Buffer> {
  if (storageKey !== `commission-files/${fileId}.blob`) throw new Error("COMMISSION_FILE_NOT_FOUND");
  const stored = await readFile(resolve(root(), storageKey)).catch(() => {
    throw new Error("COMMISSION_FILE_NOT_FOUND");
  });
  return decryptStoredArtifactBytes(fileId, stored, environment).bytes;
}

export async function deleteCommissionFile(storageKey: string): Promise<void> {
  if (!/^commission-files\/[0-9a-f-]{36}\.blob$/i.test(storageKey)) return;
  await unlink(resolve(root(), storageKey)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw new Error("COMMISSION_FILE_DELETE_FAILED");
  });
}
