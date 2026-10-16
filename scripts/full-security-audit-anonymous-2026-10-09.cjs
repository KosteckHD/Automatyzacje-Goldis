"use strict";
// Reuse existing synthetic probes while keeping earlier audit artifacts intact.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
function compileProbe(name) {
  const filename = path.join(__dirname, name);
  const source = fs.readFileSync(filename, "utf8").replaceAll("docs/security/anonymous-", "docs/security/full-audit-2026-10-09/anonymous-");
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(__dirname);
  instance._compile(source, filename);
  return instance.exports;
}
const webFilename = require.resolve("./audit-anonymous-web-2026-10-09.cjs");
require.cache[webFilename] = { id: webFilename, filename: webFilename, loaded: true,
  exports: compileProbe("audit-anonymous-web-2026-10-09.cjs") };
compileProbe("audit-anonymous-access-2026-10-09.cjs");
