"use strict";
// Sends only public package names and pinned versions from requirements.lock.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../../..");
const lockPath = path.join(root, "services/commission-engine/requirements.lock");
const bytes = fs.readFileSync(lockPath);
const packages = bytes.toString("utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => {
  const match = /^([A-Za-z0-9_.-]+)==([^\s;]+)$/.exec(line);
  if (!match) throw Error("UNSUPPORTED_REQUIREMENTS_LINE");
  return { name: match[1], version: match[2] };
});
(async () => {
  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: packages.map(pkg => ({ package: { name: pkg.name, ecosystem: "PyPI" }, version: pkg.version })) }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw Error(`OSV_QUERY_FAILED_${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.results) || payload.results.length !== packages.length) throw Error("OSV_RESULT_LENGTH_MISMATCH");
  const report = {
    checkedAt: new Date().toISOString(), endpoint: "https://api.osv.dev/v1/querybatch",
    lockSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    scope: "Pinned Python lock entries only; no pip resolver, image scan or installed-environment equivalence check",
    results: packages.map((pkg, i) => ({ ...pkg, advisories: payload.results[i].vulns || [] })),
  };
  fs.writeFileSync(path.join(__dirname, "python-lock-osv-current.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
