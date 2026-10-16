"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const contextFile = path.join(root, "exports/live-acceptance", process.env.ACCEPTANCE_CONTEXT_FILE || "context.json");

async function main() {
  const env = {};
  for (const line of (await fs.readFile(path.join(root, process.env.ACCEPTANCE_ENV_FILE || ".env.local"), "utf8")).split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  if (process.env.ACCEPTANCE_DOCKER_BRIDGE === "1") {
    const { execFileSync } = require("node:child_process");
    const container = JSON.parse(execFileSync("docker", ["inspect", "goldis-automatyzacje-api-1"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
    const configured = Object.fromEntries(container.Config.Env.map(item => {
      const index = item.indexOf("="); return [item.slice(0, index), item.slice(index + 1)];
    }));
    for (const key of ["PUBLIC_APP_ORIGIN", "GOLDIS_ADMIN_USER", "GOLDIS_ADMIN_PASSWORD"]) env[key] = configured[key];
  }
  const origin = env.PUBLIC_APP_ORIGIN;
  const base = "http://127.0.0.1:3001/api";
  const login = await fetch(base + "/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: env.GOLDIS_ADMIN_USER, password: env.GOLDIS_ADMIN_PASSWORD }) });
  if (!login.ok) throw new Error("ACCEPTANCE_ADMIN_LOGIN_FAILED");
  const auth = await login.json();
  const cookie = login.headers.getSetCookie().map(item => item.split(";")[0]).join("; ");
  const api = async (route, body, method = "POST") => {
    const multipart = body instanceof FormData;
    const response = await fetch(base + route, { method,
      headers: { origin, cookie, "x-csrf-token": auth.csrfToken, ...(!multipart && body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const code = failure.code || failure.errorCode || failure.message;
      const knownMessages = ["Rekordy powiązane wymagają rozstrzygnięcia przed uruchomieniem", "Wiersz nie jest gotowy w ostatnim przygotowaniu importu", "Administrator wstrzymał nowe uruchomienia tego narzędzia", "Uruchomienia tego narzędzia są teraz poza dozwolonymi godzinami", "Brak ustawień uruchomienia narzędzia", "Istnieje aktywne zadanie z inną datą odniesienia; wymagany jest przegląd przed dołączeniem"];
      if (knownMessages.includes(code)) console.error(code);
      throw new Error(`ACCEPTANCE_HTTP_${response.status}${typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code) ? "_" + code : ""}`);
    }
    const payload = await response.text();
    return payload ? JSON.parse(payload) : null;
  };
  try {
    if (auth.mustChangePassword) throw new Error("ACCEPTANCE_ADMIN_PASSWORD_CHANGE_REQUIRED");
    let context = {};
    try { context = JSON.parse(await fs.readFile(contextFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (process.argv[2] === "import") {
      if (!context.batchId) {
        const pair = process.env.ACCEPTANCE_TWO_ROWS === "1";
        const inputName = pair ? "input-18001-18002.xlsx" : "input-18001.xlsx";
        const file = await fs.readFile(path.join(root, "exports/live-acceptance", inputName));
        const form = new FormData();
        form.append("file", new Blob([file], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), inputName);
        const imported = await api("/imports", form);
        if (imported.totalRows !== (pair ? 2 : 1) || imported.invalidRows !== 0) throw new Error("ACCEPTANCE_IMPORT_NOT_READY");
        context = { ...(pair ? { rowNumbers: [18001, 18002] } : { rowNumber: 18001 }), batchId: imported.id };
        await fs.writeFile(contextFile, JSON.stringify(context, null, 2));
      }
      console.log(JSON.stringify({ imported: true, ...context }));
    } else if (process.argv[2] === "prepare") {
      if (!context.batchId) throw new Error("ACCEPTANCE_IMPORT_REQUIRED");
      if (!context.preparationId) {
        const prepared = await api(`/imports/${context.batchId}/preparations`, { idempotencyKey: `acceptance-18001-${context.batchId}` });
        context.preparationId = prepared.preparationId;
        await fs.writeFile(contextFile, JSON.stringify(context, null, 2));
      }
      const prepared = await api(`/imports/${context.batchId}/preparations/${context.preparationId}`, undefined, "GET");
      console.log(JSON.stringify({ status: prepared.status, stage: prepared.stage, counts: prepared.counts, errorCode: prepared.errorCode }));
    } else if (process.argv[2] === "restart-stale-auth") {
      if (!context.runId) throw new Error("ACCEPTANCE_RUN_NOT_STARTED");
      const current = await api("/runs/" + context.runId, undefined, "GET");
      if (current.status !== "waiting_for_sms") throw new Error("ACCEPTANCE_RESTART_STATE_UNSAFE");
      const cancelled = await api(`/runs/${context.runId}/cancel`, {});
      if (cancelled.status !== "cancelled") throw new Error("ACCEPTANCE_CANCEL_UNCONFIRMED");
      context.previousRunIds = [...(context.previousRunIds || []), context.runId];
      delete context.runId;
      await fs.writeFile(contextFile, JSON.stringify(context, null, 2));
      console.log("STALE_AUTH_RUN_CANCELLED_NO_PORTAL_DRAFT_CREATED");
    } else if (process.argv[2] === "start-pair") {
      if (!context.batchId || JSON.stringify(context.rowNumbers) !== "[18001,18002]" || context.runId) throw new Error("ACCEPTANCE_PAIR_CONTEXT_REQUIRED");
      const ready = await api("/health/automation", undefined, "GET");
      if (!ready.automationReady || ready.portalMode !== "live") throw new Error("ACCEPTANCE_LIVE_WORKER_NOT_READY");
      context.runs ||= [];
      for (const rowNumber of context.rowNumbers) {
        if (context.runs.some(run => run.rowNumber === rowNumber)) continue;
        const run = await api("/runs", { batchId: context.batchId, rowNumber });
        context.runs.push({ rowNumber, runId: run.id, referenceDate: run.referenceDate });
        await fs.writeFile(contextFile, JSON.stringify(context, null, 2));
        const rowContextFile = contextFile.replace(/\.json$/, `-${rowNumber}.json`);
        await fs.writeFile(rowContextFile, JSON.stringify({ batchId: context.batchId, rowNumber, runId: run.id }, null, 2));
      }
      console.log(JSON.stringify({ batchId: context.batchId, runs: context.runs }));
    } else if (process.argv[2] === "start") {
      if (!context.batchId || context.runId) throw new Error("ACCEPTANCE_RUN_CONTEXT_CONFLICT");
      const ready = await api("/health/automation", undefined, "GET");
      if (!ready.automationReady || ready.portalMode !== "live") throw new Error("ACCEPTANCE_LIVE_WORKER_NOT_READY");
      const run = await api("/runs", { batchId: context.batchId, rowNumber: 18001 });
      context.runId = run.id;
      await fs.writeFile(contextFile, JSON.stringify(context, null, 2));
      console.log(JSON.stringify({ runId: run.id, status: run.status, referenceDate: run.referenceDate }));
    } else if (process.argv[2] === "status") {
      if (!context.runId) throw new Error("ACCEPTANCE_RUN_NOT_STARTED");
      const run = await api("/runs/" + context.runId, undefined, "GET");
      console.log(JSON.stringify({ runId: run.id, status: run.status, currentStep: run.currentStep, errorCode: run.errorCode, referenceDate: run.referenceDate, controlState: run.controlState,
        incident: run.incident ? { kind: run.incident.kind, portal: run.incident.portal, reasonCode: run.incident.reasonCode } : null,
        pzuLoginVerified: Array.isArray(run.events) && run.events.some(event => event.step === "pzu_login_verified_test_paused"),
        authenticatedWithoutCode: Array.isArray(run.events) && run.events.some(event => event.step === "portal_authenticated_without_code") }));
    } else if (process.argv[2] === "download") {
      if (!context.runId) throw new Error("ACCEPTANCE_RUN_NOT_STARTED");
      const run = await api("/runs/" + context.runId, undefined, "GET");
      if (run.status !== "completed" || !run.artifactAvailable) throw new Error("ACCEPTANCE_ARTIFACT_NOT_READY");
      const response = await fetch(base + `/runs/${context.runId}/artifact`, { headers: { origin, cookie, "x-csrf-token": auth.csrfToken }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("ACCEPTANCE_ARTIFACT_DOWNLOAD_FAILED");
      const output = path.join(root, "exports/live-acceptance", `result-${context.runId}.xlsx`);
      await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
      console.log(JSON.stringify({ runId: context.runId, artifactDownloaded: true }));
    } else if (process.argv[2] === "sms-status") {
      if (!context.runId) throw new Error("ACCEPTANCE_RUN_NOT_STARTED");
      const challenges = await api(`/auth-challenges?runId=${context.runId}`, undefined, "GET");
      const page = await api("/interventions?status=open&limit=20", undefined, "GET");
      console.log(JSON.stringify({ runId: context.runId, challenge: challenges ? { portal: challenges.portal, status: challenges.status, expiresAt: challenges.expiresAt } : null,
        interventions: (page.items || []).filter(item => item.runId === context.runId).map(item => ({ kind: item.kind, portal: item.portal, status: item.status })) }));
    } else throw new Error("ACCEPTANCE_COMMAND_INVALID");
  } finally { await api("/auth/logout", {}).catch(() => undefined); }
}

main().catch(error => { console.error(/^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "ACCEPTANCE_API_FAILED"); process.exitCode = 1; });
