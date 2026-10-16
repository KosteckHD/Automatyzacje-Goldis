import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { loadImportParserRuntimeConfig } from "../../infrastructure/config";

const maxInputBytes = 16 * 1024 * 1024;
const maxOutputBytes = 64 * 1024 * 1024;
const parseTimeoutMs = 60_000;

export type ImportParserServerOptions = Readonly<{
  secret: string;
  host?: string;
  port?: number;
  childPath?: string;
  spawnChild?: typeof spawn;
  timeoutMs?: number;
}>;

function authorized(request: IncomingMessage, secret: string): boolean {
  const supplied = request.headers["x-goldis-import-parser-key"];
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(secret, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function respond(response: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(bytes.length), ...extraHeaders });
  response.end(bytes);
}

export function createImportParserServer(options: ImportParserServerOptions): Server {
  if (Buffer.byteLength(options.secret, "utf8") < 32) throw new Error("IMPORT_PARSER_SHARED_SECRET_INVALID");
  const spawnChild = options.spawnChild ?? spawn;
  const childPath = options.childPath ?? join(__dirname, "../../import-parser-child.js");
  let busy = false;
  let activeChild: ChildProcessWithoutNullStreams | null = null;

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health/live") {
      respond(response, 200, { status: "ok", busy });
      return;
    }
    if (request.method !== "POST" || request.url !== "/internal/parse-xlsx") {
      respond(response, 404, { errorCode: "NOT_FOUND" });
      return;
    }
    if (!authorized(request, options.secret)) {
      request.resume();
      respond(response, 401, { errorCode: "UNAUTHORIZED" });
      return;
    }
    const declaredLength = request.headers["content-length"];
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxInputBytes)) {
      request.resume();
      respond(response, 413, { errorCode: "IMPORT_LIMITS_EXCEEDED" });
      return;
    }
    if (busy) {
      request.resume();
      respond(response, 503, { errorCode: "IMPORT_CAPACITY_EXCEEDED" }, { "retry-after": "2" });
      return;
    }

    busy = true;
    let released = false;
    let childClosed = true;
    let disconnected = false;
    let timer: NodeJS.Timeout | undefined;
    let outputLength = 0;
    const chunks: Buffer[] = [];
    let inputLength = 0;
    let inputTooLarge = false;
    let child: ChildProcessWithoutNullStreams | null = null;
    let childStdout = Buffer.alloc(0);
    const releaseIfDone = () => {
      if (!released && childClosed) {
        released = true;
        busy = false;
      }
    };
    const stopChild = () => {
      if (child && !child.killed) child.kill("SIGKILL");
    };
    const onDisconnect = () => {
      if (response.writableEnded) return;
      disconnected = true;
      if (!child) releaseIfDone();
      stopChild();
    };
    response.once("close", onDisconnect);
    request.once("aborted", onDisconnect);

    const failRequest = (status: number, errorCode: string, headers: Record<string, string> = {}) => {
      if (timer) clearTimeout(timer);
      respond(response, status, { errorCode }, headers);
      if (!child) releaseIfDone();
      stopChild();
    };

    request.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (inputTooLarge) return;
      inputLength += chunk.length;
      if (inputLength > maxInputBytes) {
        inputTooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", () => failRequest(400, "INVALID_WORKBOOK"));
    request.once("end", () => {
      if (disconnected || response.destroyed) { releaseIfDone(); return; }
      if (inputTooLarge) {
        respond(response, 413, { errorCode: "IMPORT_LIMITS_EXCEEDED" });
        releaseIfDone();
        return;
      }
      const input = Buffer.concat(chunks, inputLength);
      childClosed = false;
      try {
        const spawned = spawnChild(process.execPath, ["--max-old-space-size=512", childPath], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { NODE_ENV: "production" },
        });
        child = spawned;
      } catch {
        childClosed = true;
        failRequest(503, "IMPORT_PARSER_UNAVAILABLE");
        return;
      }
      const spawned = child;
      if (!spawned) { childClosed = true; failRequest(503, "IMPORT_PARSER_UNAVAILABLE"); return; }
      activeChild = spawned;
      spawned.stderr.resume();
      spawned.stdout.on("data", (value: Buffer) => {
        outputLength += value.length;
        if (outputLength > maxOutputBytes) {
          failRequest(503, "IMPORT_PARSER_UNAVAILABLE");
          return;
        }
        childStdout = Buffer.concat([childStdout, value], outputLength);
      });
      spawned.once("error", () => {
        if (!disconnected) respond(response, 503, { errorCode: "IMPORT_PARSER_UNAVAILABLE" });
      });
      spawned.once("close", (code) => {
        childClosed = true;
        if (timer) clearTimeout(timer);
        if (activeChild === spawned) activeChild = null;
        if (disconnected) { releaseIfDone(); return; }
        if (code !== 0) {
          let parsed: unknown;
          try { parsed = JSON.parse(childStdout.toString("utf8")); } catch { parsed = null; }
          const errorCode = parsed && typeof parsed === "object" && "errorCode" in parsed
            && typeof parsed.errorCode === "string" ? parsed.errorCode : "IMPORT_PARSER_UNAVAILABLE";
          const status = errorCode === "IMPORT_CAPACITY_EXCEEDED" ? 503
            : errorCode === "IMPORT_PARSER_UNAVAILABLE" ? 503 : 422;
          respond(response, status, { errorCode }, status === 503 ? { "retry-after": "2" } : {});
          releaseIfDone();
          return;
        }
        try {
          const parsed = JSON.parse(childStdout.toString("utf8")) as { rows?: unknown };
          if (!Array.isArray(parsed.rows)) throw new Error("INVALID_RESULT");
          respond(response, 200, { rows: parsed.rows });
        } catch {
          respond(response, 503, { errorCode: "IMPORT_PARSER_UNAVAILABLE" }, { "retry-after": "2" });
        }
        releaseIfDone();
      });
      timer = setTimeout(() => failRequest(503, "IMPORT_PARSE_TIMEOUT"), options.timeoutMs ?? parseTimeoutMs);
      spawned.stdin.once("error", () => failRequest(503, "IMPORT_PARSER_UNAVAILABLE"));
      spawned.stdin.end(input);
    });
  });
  server.requestTimeout = 75_000;
  server.headersTimeout = 15_000;

  server.on("close", () => activeChild?.kill("SIGKILL"));
  return server;
}

export function startImportParserProcess(): void {
  try {
    const runtimeConfig = loadImportParserRuntimeConfig(process.env);
    const server = createImportParserServer({ secret: runtimeConfig.secret });
    server.listen(runtimeConfig.port, runtimeConfig.host);
    const shutdown = () => server.close(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error("IMPORT_PARSER_START_FAILED", error instanceof Error ? error.message : "CONFIG_INVALID");
    process.exitCode = 1;
  }
}
