"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const imageKeys = ["GOLDIS_POSTGRES_IMAGE", "GOLDIS_REDIS_IMAGE", "GOLDIS_API_IMAGE", "GOLDIS_WORKER_IMAGE", "GOLDIS_WEB_IMAGE"];
const releaseFiles = [
  "compose.yaml", "compose.production.yaml", "deploy/nginx/goldis.conf.example",
  "deploy/docker/chromium-seccomp.json", "docker/postgres/apply-runtime-grants.sql", "config/portal-selectors.example.json",
];

function fail(code) { throw new Error(code); }

function readEnvironment(file) {
  const values = Object.create(null);
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail("RELEASE_ENV_FORMAT_INVALID");
    values[match[1]] = match[2].trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
  }
  return values;
}

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function createReleaseManifest(input) {
  const env = readEnvironment(input.envFile);
  const images = Object.fromEntries(imageKeys.map((key) => {
    const image = env[key] || "";
    if (!/^.+@sha256:[a-f0-9]{64}$/i.test(image)) fail(`RELEASE_IMAGE_DIGEST_REQUIRED_${key}`);
    return [key, image];
  }));
  const version = env.GOLDIS_BUILD_VERSION || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(version)) fail("RELEASE_VERSION_INVALID");
  if (!/^[a-f0-9]{40}$/i.test(env.GOLDIS_BUILD_COMMIT || "") || input.headCommit !== env.GOLDIS_BUILD_COMMIT.toLowerCase()) {
    fail("RELEASE_COMMIT_MISMATCH");
  }
  if (env.GOLDIS_IMAGE_DIGEST !== images.GOLDIS_API_IMAGE.split("@").at(-1)) fail("RELEASE_API_DIGEST_MISMATCH");
  const migrationsDirectory = path.join(root, "apps", "api", "src", "infrastructure", "database", "migrations");
  const migrations = fs.readdirSync(migrationsDirectory).filter((name) => /^\d{3}-[a-z0-9-]+\.ts$/.test(name)).sort();
  if (migrations.length === 0) fail("RELEASE_MIGRATIONS_MISSING");
  const sourcePackages = ["apps/api/package.json", "apps/worker/package.json", "apps/web/package.json", "packages/core/package.json"];
  const checksums = Object.fromEntries([...releaseFiles, ...sourcePackages].map((relative) => [relative, sha256(path.join(root, relative))]));
  return {
    format: "goldis-release",
    formatVersion: 1,
    createdAtUtc: new Date(input.now ?? Date.now()).toISOString(),
    version,
    commit: input.headCommit,
    images,
    apiImageDigest: env.GOLDIS_IMAGE_DIGEST,
    highestMigration: migrations.at(-1),
    runtimeGrantsSha256: checksums["docker/postgres/apply-runtime-grants.sql"],
    checksums,
    validation: { build: "pending", unitTests: "pending", integration: "pending", backupRestore: "pending", productionSmoke: "pending" },
  };
}

function main(args) {
  let envFile = "";
  let outputFile = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--env") envFile = args[++index] || "";
    else if (args[index] === "--output") outputFile = args[++index] || "";
    else fail("USAGE: create-release-manifest.cjs --env <production.env> --output <release-manifest.json>");
  }
  if (!envFile || !outputFile) fail("USAGE: create-release-manifest.cjs --env <production.env> --output <release-manifest.json>");
  const resolvedEnv = path.resolve(envFile);
  const resolvedOutput = path.resolve(outputFile);
  if (!fs.existsSync(resolvedEnv) || fs.lstatSync(resolvedEnv).isSymbolicLink()) fail("RELEASE_ENV_FILE_INVALID");
  let headCommit;
  let status;
  try {
    headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().toLowerCase();
    status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { fail("RELEASE_GIT_STATE_UNAVAILABLE"); }
  if (!/^[a-f0-9]{40}$/.test(headCommit)) fail("RELEASE_GIT_HEAD_INVALID");
  if (status.trim()) fail("RELEASE_WORKTREE_DIRTY");
  const manifest = createReleaseManifest({ envFile: resolvedEnv, headCommit });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`RELEASE_MANIFEST_CREATED version=${manifest.version} commit=${manifest.commit} highestMigration=${manifest.highestMigration}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "RELEASE_MANIFEST_FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createReleaseManifest, readEnvironment };
