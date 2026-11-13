"use strict";
// Audit only: real compiled service, synthetic inputs and in-memory adapters.
// Every scenario runs in a disposable child process; no API server or database.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../../..");
const scenarios = ["prototype-property", "revision-race", "audit-failure"];

async function scenario(name) {
  const { CommissionsService } = require(path.join(root, "apps/api/dist/features/commissions/commissions.service.js"));
  let saved = 0;
  let audits = 0;
  const row = () => ({ dictionaryVersionId: "11111111-1111-4111-8111-111111111111", revision: 1 });
  const repository = { findOne: async () => row(), save: async () => { saved += 1; } };
  const audit = { record: async () => { audits += 1; if (name === "audit-failure") throw Error("SYNTHETIC_AUDIT_FAILURE"); } };
  const service = new CommissionsService(repository, audit);
  service.decryptPreset = () => ({ rules: {}, client_dictionary: { entries: [{ id: "fixture-entry", risk: "OC", source: "fixture", sheet: "fixture", agents: { Ola: { status: "RATE", rate: 1 }, Maciek: { status: "RATE", rate: 2 } } }] } });
  const scope = { tenantId: "22222222-2222-4222-8222-222222222222", userId: "33333333-3333-4333-8333-333333333333", role: "admin" };
  const edit = (agent, rate) => service.editDictionaryEntry(scope, "11111111-1111-4111-8111-111111111111", "fixture-entry", 1, { agent, status: "RATE", rate });
  if (name === "prototype-property") {
    const original = Object.getOwnPropertyDescriptors(Object.prototype);
    let result;
    try {
      await edit("__proto__", 12.5);
      result = { mutatedObjectPrototype: Object.prototype.status === "RATE" && Object.prototype.rate === 12.5, unrelatedObjectInheritsRate: ({}).rate === 12.5, saved, audits };
    } finally {
      for (const key of Object.getOwnPropertyNames(Object.prototype)) if (!Object.hasOwn(original, key)) delete Object.prototype[key];
      Object.defineProperties(Object.prototype, original);
    }
    return { ...result, prototypeRestored: !Object.hasOwn(Object.prototype, "rate") };
  }
  if (name === "revision-race") {
    const results = await Promise.allSettled([edit("Ola", 10), edit("Maciek", 20)]);
    return { requestedRevision: 1, accepted: results.filter(row => row.status === "fulfilled").length, returnedRevisions: results.filter(row => row.status === "fulfilled").map(row => row.value.revision), saved, audits, evidenceLevel: "real service with in-memory persistence; PostgreSQL race not executed" };
  }
  let returnedError;
  try { await edit("Ola", 10); } catch (error) { returnedError = error.message; }
  return { savedBeforeAuditError: saved === 1, saved, audits, returnedError, evidenceLevel: "real service with in-memory persistence; PostgreSQL rollback not executed" };
}

if (process.argv[2] === "--child") {
  scenario(process.argv[3]).then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
} else {
  const allowed = /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  env.DATABASE_URL = "postgres://audit:unused@127.0.0.1:1/audit";
  env.WORKER_LIVE_PORTALS = "0";
  env.GOLDIS_ENRICHMENT_PROVIDER = "disabled";
  env.ARTIFACT_ENCRYPTION_ACTIVE_KEY_VERSION = "1";
  env.ARTIFACT_ENCRYPTION_KEYS_BASE64 = Buffer.from(JSON.stringify({ "1": Buffer.alloc(32, 17).toString("base64") })).toString("base64");
  env.ARTIFACT_REQUIRE_ENCRYPTION = "1";
  const results = scenarios.map(name => {
    const child = spawnSync(process.execPath, [__filename, "--child", name], { cwd: root, env, encoding: "utf8", timeout: 15000, windowsHide: true });
    if (child.error || child.status !== 0) throw Error(`AUDIT_REPRODUCER_FAILED:${name}:${child.error?.code ?? child.stderr}`);
    return { scenario: name, result: JSON.parse(child.stdout) };
  });
  fs.writeFileSync(path.join(__dirname, "service-reproductions.json"), JSON.stringify({ checkedAt: new Date().toISOString(), liveServicesUsed: false, results }, null, 2) + "\n");
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
}
