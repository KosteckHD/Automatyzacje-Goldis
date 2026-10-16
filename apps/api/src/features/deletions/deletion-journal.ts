import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadApiRuntimeConfig } from "../../infrastructure/config";
import { configuredArtifactRoot } from "../results/public";

const zeroHash = "0".repeat(64);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const targetTypes = new Set(["artifact", "run", "import", "tenant"]);

export type DeletionJournalTargetType = "artifact" | "run" | "import" | "tenant";
export type DeletionJournalIntent = Readonly<{
  jobId: string;
  tenantId: string;
  targetType: DeletionJournalTargetType;
  targetId: string;
}>;
export type DeletionJournalEntry = DeletionJournalIntent &
  Readonly<{
    formatVersion: 1;
    sequence: number;
    previousHash: string;
    createdAt: string;
    hash: string;
  }>;

export class DeletionJournalError extends Error {
  constructor(
    readonly code:
      | "DELETION_JOURNAL_PATH_INVALID"
      | "DELETION_JOURNAL_KEY_MISSING"
      | "DELETION_JOURNAL_KEY_INVALID"
      | "DELETION_JOURNAL_TAMPERED"
      | "DELETION_JOURNAL_WRITE_FAILED",
  ) {
    super(code);
    this.name = "DeletionJournalError";
  }
}

type JournalPaths = Readonly<{ directory: string; journalFile: string; keyFile: string }>;

function normalizedPath(value: string): string {
  const normalized = resolve(value).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function configuredPaths(environment?: Readonly<Record<string, string | undefined>>): JournalPaths {
  const runtimeConfig = environment ? null : loadApiRuntimeConfig();
  const journalDirectory = environment?.GOLDIS_DELETION_JOURNAL_DIR ?? runtimeConfig?.deletionJournalDirectory;
  const exportDirectory = environment?.API_EXPORT_DIR ?? runtimeConfig?.apiExportDirectory;
  const directory = journalDirectory?.trim()
    ? resolve(journalDirectory)
    : resolve(dirname(configuredArtifactRoot({ API_EXPORT_DIR: exportDirectory })), "deletion-journal");
  return {
    directory,
    journalFile: resolve(directory, "deletion-journal.jsonl"),
    keyFile: resolve(directory, "deletion-journal.key"),
  };
}

function canonicalPayload(entry: Omit<DeletionJournalEntry, "hash">): string {
  return JSON.stringify({
    formatVersion: entry.formatVersion,
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    jobId: entry.jobId,
    tenantId: entry.tenantId,
    targetType: entry.targetType,
    targetId: entry.targetId,
    createdAt: entry.createdAt,
  });
}

function hasUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function validateIntent(intent: DeletionJournalIntent): void {
  if (
    !hasUuid(intent.jobId) ||
    !hasUuid(intent.tenantId) ||
    !hasUuid(intent.targetId) ||
    !targetTypes.has(intent.targetType)
  )
    throw new DeletionJournalError("DELETION_JOURNAL_WRITE_FAILED");
}

async function assertSafeFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path)) {
      throw new DeletionJournalError("DELETION_JOURNAL_PATH_INVALID");
    }
  } catch (error) {
    if (error instanceof DeletionJournalError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new DeletionJournalError("DELETION_JOURNAL_PATH_INVALID");
  }
}

async function ensureSafeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || normalizedPath(await realpath(path)) !== normalizedPath(path)) {
      throw new DeletionJournalError("DELETION_JOURNAL_PATH_INVALID");
    }
  } catch (error) {
    if (error instanceof DeletionJournalError) throw error;
    throw new DeletionJournalError("DELETION_JOURNAL_PATH_INVALID");
  }
}

async function loadOrCreateKey(paths: JournalPaths): Promise<Buffer> {
  await assertSafeFile(paths.keyFile);
  try {
    const key = await readFile(paths.keyFile);
    if (key.byteLength !== 32) throw new DeletionJournalError("DELETION_JOURNAL_KEY_INVALID");
    return key;
  } catch (error) {
    if (error instanceof DeletionJournalError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new DeletionJournalError("DELETION_JOURNAL_KEY_INVALID");
  }

  let existingJournal: Buffer | null = null;
  try {
    existingJournal = await readFile(paths.journalFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DeletionJournalError("DELETION_JOURNAL_TAMPERED");
  }
  if (existingJournal?.byteLength) throw new DeletionJournalError("DELETION_JOURNAL_KEY_MISSING");

  const key = randomBytes(32);
  try {
    const handle = await open(paths.keyFile, "wx", 0o600);
    try {
      await handle.writeFile(key);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateKey(paths);
    throw new DeletionJournalError("DELETION_JOURNAL_WRITE_FAILED");
  }
}

function parseJournal(content: Buffer, key: Buffer): DeletionJournalEntry[] {
  if (content.byteLength === 0) return [];
  const lines = content.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entries: DeletionJournalEntry[] = [];
  let previousHash = zeroHash;
  for (const [index, line] of lines.entries()) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new DeletionJournalError("DELETION_JOURNAL_TAMPERED");
    }
    const expectedKeys = [
      "formatVersion",
      "sequence",
      "previousHash",
      "jobId",
      "tenantId",
      "targetType",
      "targetId",
      "createdAt",
      "hash",
    ];
    if (
      Object.keys(raw).sort().join("|") !== expectedKeys.sort().join("|") ||
      raw.formatVersion !== 1 ||
      raw.sequence !== index + 1 ||
      raw.previousHash !== previousHash ||
      !hasUuid(raw.jobId) ||
      !hasUuid(raw.tenantId) ||
      !hasUuid(raw.targetId) ||
      typeof raw.targetType !== "string" ||
      !targetTypes.has(raw.targetType) ||
      typeof raw.createdAt !== "string" ||
      !Number.isFinite(Date.parse(raw.createdAt)) ||
      typeof raw.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.hash)
    ) {
      throw new DeletionJournalError("DELETION_JOURNAL_TAMPERED");
    }
    const unsigned = {
      formatVersion: 1 as const,
      sequence: index + 1,
      previousHash,
      jobId: raw.jobId,
      tenantId: raw.tenantId,
      targetType: raw.targetType as DeletionJournalTargetType,
      targetId: raw.targetId,
      createdAt: raw.createdAt,
    };
    const expectedHash = createHmac("sha256", key).update(canonicalPayload(unsigned), "utf8").digest();
    const actualHash = Buffer.from(raw.hash, "hex");
    if (actualHash.byteLength !== expectedHash.byteLength || !timingSafeEqual(actualHash, expectedHash)) {
      throw new DeletionJournalError("DELETION_JOURNAL_TAMPERED");
    }
    previousHash = raw.hash;
    entries.push({ ...unsigned, hash: raw.hash });
  }
  return entries;
}

async function readEntries(
  paths: JournalPaths,
  key?: Buffer,
): Promise<{ entries: DeletionJournalEntry[]; key: Buffer }> {
  await ensureSafeDirectory(paths.directory);
  await assertSafeFile(paths.journalFile);
  let content: Buffer;
  try {
    content = await readFile(paths.journalFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") content = Buffer.alloc(0);
    else throw new DeletionJournalError("DELETION_JOURNAL_TAMPERED");
  }
  if (!key && content.byteLength === 0) {
    try {
      key = await readFile(paths.keyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], key: Buffer.alloc(0) };
      throw new DeletionJournalError("DELETION_JOURNAL_KEY_INVALID");
    }
    if (key.byteLength !== 32) throw new DeletionJournalError("DELETION_JOURNAL_KEY_INVALID");
  }
  const actualKey = key ?? (await loadOrCreateKey(paths));
  return { entries: parseJournal(content, actualKey), key: actualKey };
}

let appendQueue: Promise<void> = Promise.resolve();

/** Appends a durable deletion intent before the creating database transaction commits. */
export function appendDeletionJournalIntent(
  intent: DeletionJournalIntent,
  options: Readonly<{
    directory?: string;
    now?: Date;
    onAppended?: (entry: DeletionJournalEntry) => void | Promise<void>;
  }> = {},
): Promise<DeletionJournalEntry> {
  const task = appendQueue.then(async () => {
    validateIntent(intent);
    const paths = options.directory
      ? configuredPaths({ GOLDIS_DELETION_JOURNAL_DIR: options.directory })
      : configuredPaths();
    try {
      await ensureSafeDirectory(paths.directory);
      const { entries, key } = await readEntries(paths, await loadOrCreateKey(paths));
      const previous = entries.at(-1);
      const unsigned = {
        formatVersion: 1 as const,
        sequence: (previous?.sequence ?? 0) + 1,
        previousHash: previous?.hash ?? zeroHash,
        jobId: intent.jobId.toLowerCase(),
        tenantId: intent.tenantId.toLowerCase(),
        targetType: intent.targetType,
        targetId: intent.targetId.toLowerCase(),
        createdAt: (options.now ?? new Date()).toISOString(),
      };
      const hash = createHmac("sha256", key).update(canonicalPayload(unsigned), "utf8").digest("hex");
      const entry: DeletionJournalEntry = { ...unsigned, hash };
      const handle = await open(paths.journalFile, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await options.onAppended?.(entry);
      return entry;
    } catch (error) {
      if (error instanceof DeletionJournalError) throw error;
      throw new DeletionJournalError("DELETION_JOURNAL_WRITE_FAILED");
    }
  });
  appendQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** Verifies the complete chain; callers must fail closed on an invalid journal. */
export async function readDeletionJournal(
  options: Readonly<{ directory?: string }> = {},
): Promise<readonly DeletionJournalEntry[]> {
  const paths = options.directory
    ? configuredPaths({ GOLDIS_DELETION_JOURNAL_DIR: options.directory })
    : configuredPaths();
  try {
    const { entries } = await readEntries(paths);
    return entries;
  } catch (error) {
    if (error instanceof DeletionJournalError) throw error;
    throw new DeletionJournalError("DELETION_JOURNAL_TAMPERED");
  }
}
