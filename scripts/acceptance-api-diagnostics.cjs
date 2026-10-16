"use strict";
// Private acceptance logging: error types and database codes only, no SQL/data.
if (process.env.COMPOSE_PROJECT_NAME !== "goldis-acceptance-20261015") throw new Error("ACCEPTANCE_SCOPE_REQUIRED");
const { PublicExceptionFilter } = require("../apps/api/dist/infrastructure/http");
const original = PublicExceptionFilter.prototype.catch;
PublicExceptionFilter.prototype.catch = function (error, host) {
  const database = error?.parent || error?.original;
  console.error(JSON.stringify({ acceptanceError: error?.name, code: database?.code,
    table: database?.table, column: database?.column, constraint: database?.constraint,
    safeMessage: /^[A-Z][A-Z0-9_]+$/.test(error?.message || "") ? error.message : undefined,
    callSites: String(error?.stack || "").split("\n").slice(1, 4).map(line => line.replace(/.*[\\/]([^\\/]+:\d+:\d+).*/, "$1")) }));
  return original.call(this, error, host);
};
require("../apps/api/dist/composition/main.js");
