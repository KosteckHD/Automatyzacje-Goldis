"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FORMAT = "goldis-platform-backup";
const ZERO_HASH = "0".repeat(64);
const IMAGE_KEYS = ["GOLDIS_POSTGRES_IMAGE", "GOLDIS_REDIS_IMAGE", "GOLDIS_API_IMAGE", "GOLDIS_WORKER_IMAGE", "GOLDIS_WEB_IMAGE"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(code) { throw new Error(code); }

function safePath(relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes("\n") || relative.includes("\r")
    || path.posix.isAbsolute(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("BACKUP_MANIFEST_PATH_INVALID");
  }
  return relative;
}

function walkFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    safePath(child);
    const absolute = path.join(root, child);
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink() || info.isBlockDevice() || info.isCharacterDevice() || info.isFIFO() || info.isSocket()) fail("BACKUP_SOURCE_SPECIAL_FILE_UNSUPPORTED");
    if (info.isDirectory()) output.push(...walkFiles(root, child));
    else if (info.isFile()) output.push({ path: child, bytes: info.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") });
    else fail("BACKUP_SOURCE_SPECIAL_FILE_UNSUPPORTED");
  }
  return output;
}

function parseEnvironment(file) {
  const values = Object.create(null);
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail("BACKUP_ENV_FORMAT_INVALID");
    values[match[1]] = match[2].trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
  }
  return values;
}

function verifyJournal(directory, prefix = null) {
  const keyPath = path.join(directory, "deletion-journal.key");
  const journalPath = path.join(directory, "deletion-journal.jsonl");
  if (!fs.existsSync(keyPath) || !fs.existsSync(journalPath)) fail("BACKUP_DELETION_JOURNAL_REQUIRED");
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) fail("BACKUP_DELETION_JOURNAL_KEY_INVALID");
  const content = fs.readFileSync(journalPath, "utf8");
  const lines = content ? content.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    let raw;
    try { raw = JSON.parse(lines[index]); } catch { fail("BACKUP_DELETION_JOURNAL_TAMPERED"); }
    const expectedKeys = ["formatVersion", "sequence", "previousHash", "jobId", "tenantId", "targetType", "targetId", "createdAt", "hash"].sort();
    if (!raw || Object.keys(raw).sort().join("|") !== expectedKeys.join("|") || raw.formatVersion !== 1 || raw.sequence !== index + 1
      || raw.previousHash !== previousHash || !UUID.test(raw.jobId) || !UUID.test(raw.tenantId) || !UUID.test(raw.targetId)
      || !["artifact", "run", "import", "tenant"].includes(raw.targetType) || !Number.isFinite(Date.parse(raw.createdAt))
      || !/^[a-f0-9]{64}$/.test(raw.hash)) fail("BACKUP_DELETION_JOURNAL_TAMPERED");
    const unsigned = { formatVersion: 1, sequence: index + 1, previousHash, jobId: raw.jobId, tenantId: raw.tenantId,
      targetType: raw.targetType, targetId: raw.targetId, createdAt: raw.createdAt };
    const expected = crypto.createHmac("sha256", key).update(JSON.stringify(unsigned), "utf8").digest();
    const actual = Buffer.from(raw.hash, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) fail("BACKUP_DELETION_JOURNAL_TAMPERED");
    previousHash = raw.hash;
  }
  if (prefix) {
    if (!Number.isSafeInteger(prefix.sequence) || prefix.sequence < 0 || prefix.sequence > lines.length
      || !/^[a-f0-9]{64}$/.test(prefix.hash || "")) fail("BACKUP_DELETION_JOURNAL_PREFIX_INVALID");
    const prefixHash = prefix.sequence === 0 ? ZERO_HASH : JSON.parse(lines[prefix.sequence - 1]).hash;
    if (prefixHash !== prefix.hash) fail("BACKUP_DELETION_JOURNAL_PREFIX_MISMATCH");
  }
  return { sequence: lines.length, hash: previousHash };
}

function createManifest(root, environmentFile, migrationHead) {
  const resolvedRoot = fs.realpathSync(root);
  const journalHead = verifyJournal(path.join(resolvedRoot, "deletion-journal"));
  const env = parseEnvironment(environmentFile);
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(env.GOLDIS_BUILD_VERSION || "")) fail("BACKUP_RELEASE_VERSION_REQUIRED");
  if (!/^[a-f0-9]{40}$/i.test(env.GOLDIS_BUILD_COMMIT || "")) fail("BACKUP_RELEASE_COMMIT_REQUIRED");
  const images = Object.fromEntries(IMAGE_KEYS.map((key) => {
    const value = env[key] || "";
    if (!/^.+@sha256:[a-f0-9]{64}$/i.test(value)) fail(`BACKUP_RELEASE_IMAGE_DIGEST_REQUIRED_${key}`);
    return [key, value];
  }));
  if (!/^sha256:[a-f0-9]{64}$/.test(env.GOLDIS_IMAGE_DIGEST || "")
    || env.GOLDIS_IMAGE_DIGEST !== images.GOLDIS_API_IMAGE.split("@").at(-1)) fail("BACKUP_RELEASE_API_DIGEST_MISMATCH");
  if (typeof migrationHead !== "string" || !/^\d{3}-[a-z0-9-]+\.js$/.test(migrationHead)) fail("BACKUP_MIGRATION_HEAD_REQUIRED");
  const manifest = {
    format: FORMAT,
    formatVersion: 1,
    createdAtUtc: new Date().toISOString(),
    release: {
      version: env.GOLDIS_BUILD_VERSION,
      commit: env.GOLDIS_BUILD_COMMIT.toLowerCase(),
      images,
      apiImageDigest: env.GOLDIS_IMAGE_DIGEST,
      migrationHead: migrationHead || null,
      runtimeGrantsSha256: crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname, "../../docker/postgres/apply-runtime-grants.sql"))).digest("hex"),
    },
    included: ["PostgreSQL custom dump", "API encrypted exports", "worker staging checkpoints", "runtime secret files", "production env file", "deletion journal and signing key"],
    excluded: ["Redis ephemeral state; reconstruct from database outbox", "portal browser profile and login cookies", "application logs"],
    deletionJournalHead: journalHead,
    files: walkFiles(resolvedRoot).filter((item) => item.path !== "manifest.json"),
  };
  fs.writeFileSync(path.join(resolvedRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

function verifyManifest(root) {
  const resolvedRoot = fs.realpathSync(root);
  const manifestPath = path.join(resolvedRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== FORMAT || manifest.formatVersion !== 1 || !Array.isArray(manifest.files)
    || !manifest.release || !manifest.release.images || !manifest.deletionJournalHead
    || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(manifest.release.version || "")
    || !/^[a-f0-9]{40}$/.test(manifest.release.commit || "")
    || !/^\d{3}-[a-z0-9-]+\.js$/.test(manifest.release.migrationHead || "")) fail("BACKUP_MANIFEST_INVALID");
  for (const key of IMAGE_KEYS) {
    if (!/^.+@sha256:[a-f0-9]{64}$/i.test(manifest.release.images[key] || "")) fail("BACKUP_MANIFEST_INVALID");
  }
  if (manifest.release.apiImageDigest !== manifest.release.images.GOLDIS_API_IMAGE.split("@").at(-1)
    || !/^[a-f0-9]{64}$/.test(manifest.release.runtimeGrantsSha256 || "")) fail("BACKUP_MANIFEST_INVALID");
  const expected = new Map();
  for (const file of manifest.files) {
    const relative = safePath(file.path);
    if (relative === "manifest.json" || expected.has(relative) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      fail("BACKUP_MANIFEST_INVALID");
    }
    expected.set(relative, file);
  }
  const actualFiles = walkFiles(resolvedRoot).filter((item) => item.path !== "manifest.json");
  if (actualFiles.length !== expected.size) fail("BACKUP_MANIFEST_FILE_SET_MISMATCH");
  for (const actual of actualFiles) {
    const wanted = expected.get(actual.path);
    if (!wanted || wanted.bytes !== actual.bytes || wanted.sha256 !== actual.sha256) fail("BACKUP_MANIFEST_CHECKSUM_MISMATCH");
  }
  const journalHead = verifyJournal(path.join(resolvedRoot, "deletion-journal"));
  if (journalHead.sequence !== manifest.deletionJournalHead.sequence || journalHead.hash !== manifest.deletionJournalHead.hash) {
    fail("BACKUP_DELETION_JOURNAL_HEAD_MISMATCH");
  }
  return manifest;
}

function main(args) {
  const [operation, root, envFile, migrationHead] = args;
  if (operation === "create" && root && envFile) {
    const manifest = createManifest(root, envFile, migrationHead || null);
    process.stdout.write(`BACKUP_MANIFEST_CREATED files=${manifest.files.length} journalSequence=${manifest.deletionJournalHead.sequence}\n`);
    return;
  }
  if (operation === "verify" && root) {
    const manifest = verifyManifest(root);
    process.stdout.write(`BACKUP_MANIFEST_VERIFIED files=${manifest.files.length} journalSequence=${manifest.deletionJournalHead.sequence}\n`);
    return;
  }
  if (operation === "verify-journal" && root) {
    const prefix = args[2] === undefined ? null : { sequence: Number(args[2]), hash: args[3] };
    const head = verifyJournal(root, prefix);
    process.stdout.write(`BACKUP_JOURNAL_VERIFIED sequence=${head.sequence} hash=${head.hash}\n`);
    return;
  }
  fail("USAGE: manifest.cjs create <payload-dir> <env-file> [migration-head] | verify <payload-dir> | verify-journal <journal-dir> [prefix-sequence prefix-hash]");
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "BACKUP_MANIFEST_FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createManifest, verifyManifest, verifyJournal };
