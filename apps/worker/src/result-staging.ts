import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateIdentityMatchV1, validateOcSnapshotV1, type IdentityMatchV1, type OcSnapshotV1 } from "@goldis/core";

const fileMagic = Buffer.from("GOLDIS-STAGE-1\0", "ascii");
const formatVersion = 1;

export type StagedResultMetadata = Readonly<{
  fileId: string;
  sha256: string;
  keyVersion: number;
  formatVersion: number;
}>;

export class WorkerResultStagingStore {
  private readonly directory: string;
  private readonly keyVersion: number;
  private readonly keys: Map<number, Buffer>;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const configuredDirectory = environment.WORKER_STAGING_DIR;
    const keyVersion = Number(environment.WORKER_STAGING_KEY_VERSION ?? "1");
    if (!configuredDirectory || !path.isAbsolute(configuredDirectory) || !Number.isInteger(keyVersion) || keyVersion < 1) {
      throw new Error("WORKER_STAGING_CONFIG_INVALID");
    }
    const keys = new Map<number, Buffer>();
    for (const [name, value] of Object.entries(environment)) {
      const match = /^WORKER_STAGING_KEY_V([1-9]\d*)$/.exec(name);
      if (!match || !value || !/^[A-Za-z0-9_-]{43}=?$/.test(value)) continue;
      const decoded = Buffer.from(value, "base64url");
      if (decoded.length === 32) keys.set(Number(match[1]), decoded);
      else decoded.fill(0);
    }
    if (!keys.has(keyVersion)) { for (const key of keys.values()) key.fill(0); throw new Error("WORKER_STAGING_CONFIG_INVALID"); }
    this.directory = path.resolve(configuredDirectory);
    this.keyVersion = keyVersion;
    this.keys = keys;
  }

  async write(runId: string, sourceRowId: string, identityInput: IdentityMatchV1, snapshotInput: OcSnapshotV1): Promise<StagedResultMetadata> {
    const identity = validateIdentityMatchV1(identityInput);
    const snapshot = validateOcSnapshotV1(snapshotInput);
    if (identity.sourceRowId !== sourceRowId || !this.uuid(runId) || !this.uuid(sourceRowId)) throw new Error("WORKER_STAGING_INPUT_INVALID");
    const fileId = randomUUID();
    const plaintext = Buffer.from(JSON.stringify({ runId, sourceRowId, identity, snapshot }), "utf8");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.keyVersion)!, iv);
    cipher.setAAD(this.aad(runId, sourceRowId));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    plaintext.fill(0);
    const encoded = Buffer.concat([fileMagic, Buffer.from([this.keyVersion >> 8, this.keyVersion & 0xff]), iv, tag, encrypted]);
    const sha256 = createHash("sha256").update(encoded).digest("hex");
    encrypted.fill(0);
    await this.ensureDirectory();
    const finalPath = this.pathFor(fileId);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(temporaryPath, 0o600).catch(() => undefined);
      await rename(temporaryPath, finalPath);
      return { fileId, sha256, keyVersion: this.keyVersion, formatVersion };
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new Error("WORKER_STAGING_WRITE_FAILED");
    } finally { encoded.fill(0); iv.fill(0); tag.fill(0); }
  }

  async read(runId: string, sourceRowId: string, metadata: StagedResultMetadata): Promise<Readonly<{ identity: IdentityMatchV1; snapshot: OcSnapshotV1 }>> {
    if (!this.uuid(runId) || !this.uuid(sourceRowId) || !this.uuid(metadata.fileId)
      || !this.keys.has(metadata.keyVersion) || metadata.formatVersion !== formatVersion
      || !/^[0-9a-f]{64}$/.test(metadata.sha256)) throw new Error("WORKER_STAGING_METADATA_INVALID");
    let encoded: Buffer;
    try { encoded = await readFile(this.pathFor(metadata.fileId)); }
    catch { throw new Error("WORKER_STAGING_READ_FAILED"); }
    try {
      const digest = createHash("sha256").update(encoded).digest("hex");
      if (digest !== metadata.sha256 || encoded.length < fileMagic.length + 30
        || !encoded.subarray(0, fileMagic.length).equals(fileMagic)
        || encoded.readUInt16BE(fileMagic.length) !== metadata.keyVersion) throw new Error("WORKER_STAGING_INTEGRITY_FAILED");
      const start = fileMagic.length + 2;
      const key = this.keys.get(metadata.keyVersion);
      if (!key) throw new Error("WORKER_STAGING_KEY_UNAVAILABLE");
      const iv = encoded.subarray(start, start + 12);
      const tag = encoded.subarray(start + 12, start + 28);
      const ciphertext = encoded.subarray(start + 28);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(this.aad(runId, sourceRowId));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        const parsed = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
        if (parsed.runId !== runId || parsed.sourceRowId !== sourceRowId) throw new Error("WORKER_STAGING_CONTEXT_MISMATCH");
        return {
          identity: validateIdentityMatchV1(parsed.identity),
          snapshot: validateOcSnapshotV1(parsed.snapshot),
        };
      } finally { plaintext.fill(0); }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("WORKER_STAGING_")) throw error;
      throw new Error("WORKER_STAGING_INTEGRITY_FAILED");
    } finally { encoded.fill(0); }
  }

  async remove(fileId: string): Promise<void> {
    if (!this.uuid(fileId)) throw new Error("WORKER_STAGING_METADATA_INVALID");
    await unlink(this.pathFor(fileId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw new Error("WORKER_STAGING_REMOVE_FAILED");
    });
  }

  destroyKey(): void { for (const key of this.keys.values()) key.fill(0); }

  private async ensureDirectory(): Promise<void> {
    try { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
    catch { throw new Error("WORKER_STAGING_DIRECTORY_UNAVAILABLE"); }
    try {
      const info = await lstat(this.directory);
      const resolved = await realpath(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(resolved) !== this.directory) {
        throw new Error("WORKER_STAGING_DIRECTORY_INVALID");
      }
      await chmod(this.directory, 0o700).catch(() => undefined);
    } catch (error) {
      if (error instanceof Error && error.message === "WORKER_STAGING_DIRECTORY_INVALID") throw error;
      throw new Error("WORKER_STAGING_DIRECTORY_UNAVAILABLE");
    }
  }

  private pathFor(fileId: string): string {
    if (!this.uuid(fileId)) throw new Error("WORKER_STAGING_METADATA_INVALID");
    return path.join(this.directory, `${fileId}.stage`);
  }

  private aad(runId: string, sourceRowId: string): Buffer {
    return Buffer.from(`${runId}\0${sourceRowId}\0${formatVersion}`, "utf8");
  }

  private uuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
