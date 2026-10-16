import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxBodyBytes = 1024;

export type CodeInboxErrorCode = "CHALLENGE_NOT_REGISTERED" | "CHALLENGE_EXPIRED" | "CODE_ALREADY_SUBMITTED" | "CODE_INVALID" | "CODE_WAITER_EXISTS";

export class CodeInboxError extends Error {
  constructor(readonly code: CodeInboxErrorCode) {
    super(code);
    this.name = "CodeInboxError";
  }
}

type InboxEntry = {
  expiresAt: number;
  code: Buffer | null;
  timer: NodeJS.Timeout;
  resolve: ((code: Buffer) => void) | null;
  reject: ((error: Error) => void) | null;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
};

/** In-memory one-time handoff. It has no Redis, database, file, or logging integration. */
export class OneTimeCodeInbox {
  private readonly entries = new Map<string, InboxEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  register(challengeId: string, expiresAt: Date): void {
    const deadline = expiresAt instanceof Date ? expiresAt.getTime() : Number.NaN;
    if (!uuidPattern.test(challengeId) || !Number.isFinite(deadline) || deadline <= this.now()) {
      throw new CodeInboxError("CHALLENGE_EXPIRED");
    }
    if (this.entries.has(challengeId)) throw new CodeInboxError("CODE_ALREADY_SUBMITTED");
    const entry: InboxEntry = {
      expiresAt: deadline,
      code: null,
      timer: setTimeout(() => this.expire(challengeId), Math.min(deadline - this.now(), 2_147_000_000)),
      resolve: null,
      reject: null,
      abortSignal: null,
      abortListener: null,
    };
    entry.timer.unref();
    this.entries.set(challengeId, entry);
  }

  submit(challengeId: string, code: string): void {
    if (!uuidPattern.test(challengeId) || !/^\d{4,10}$/.test(code)) throw new CodeInboxError("CODE_INVALID");
    const entry = this.entries.get(challengeId);
    if (!entry) throw new CodeInboxError("CHALLENGE_NOT_REGISTERED");
    if (entry.expiresAt <= this.now()) {
      this.expire(challengeId);
      throw new CodeInboxError("CHALLENGE_EXPIRED");
    }
    if (entry.code) throw new CodeInboxError("CODE_ALREADY_SUBMITTED");
    const codeBuffer = Buffer.from(code, "ascii");
    if (entry.resolve) {
      const resolve = entry.resolve;
      this.remove(challengeId, entry, false);
      resolve(codeBuffer);
      return;
    }
    entry.code = codeBuffer;
  }

  async waitForCode(challengeId: string, signal?: AbortSignal): Promise<Buffer> {
    const entry = this.entries.get(challengeId);
    if (!entry) throw new CodeInboxError("CHALLENGE_NOT_REGISTERED");
    if (entry.expiresAt <= this.now()) {
      this.expire(challengeId);
      throw new CodeInboxError("CHALLENGE_EXPIRED");
    }
    if (entry.code) {
      const code = entry.code;
      entry.code = null;
      this.remove(challengeId, entry, false);
      return code;
    }
    if (entry.resolve) throw new CodeInboxError("CODE_WAITER_EXISTS");
    if (signal?.aborted) {
      this.remove(challengeId, entry);
      throw new CodeInboxError("CHALLENGE_EXPIRED");
    }
    return new Promise<Buffer>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      entry.abortSignal = signal ?? null;
      entry.abortListener = signal ? () => {
        this.remove(challengeId, entry);
        reject(new CodeInboxError("CHALLENGE_EXPIRED"));
      } : null;
      if (signal && entry.abortListener) signal.addEventListener("abort", entry.abortListener, { once: true });
    });
  }

  invalidate(challengeId: string): void {
    const entry = this.entries.get(challengeId);
    if (!entry) return;
    const reject = entry.reject;
    this.remove(challengeId, entry);
    reject?.(new CodeInboxError("CHALLENGE_EXPIRED"));
  }

  close(): void {
    for (const [challengeId, entry] of this.entries) {
      const reject = entry.reject;
      this.remove(challengeId, entry);
      reject?.(new CodeInboxError("CHALLENGE_EXPIRED"));
    }
  }

  private expire(challengeId: string): void {
    const entry = this.entries.get(challengeId);
    if (!entry) return;
    const reject = entry.reject;
    this.remove(challengeId, entry);
    reject?.(new CodeInboxError("CHALLENGE_EXPIRED"));
  }

  private remove(challengeId: string, entry: InboxEntry, zeroStoredCode = true): void {
    if (this.entries.get(challengeId) === entry) this.entries.delete(challengeId);
    clearTimeout(entry.timer);
    if (zeroStoredCode) entry.code?.fill(0);
    entry.code = null;
    if (entry.abortSignal && entry.abortListener) entry.abortSignal.removeEventListener("abort", entry.abortListener);
    entry.abortSignal = null;
    entry.abortListener = null;
    entry.resolve = null;
    entry.reject = null;
  }
}

export type WorkerCodeReceiverOptions = Readonly<{
  host: string;
  port: number;
  serviceSecret: string;
  inbox: OneTimeCodeInbox;
}>;

function authorized(header: string | undefined, secret: string): boolean {
  const suppliedToken = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedDigest = createHash("sha256").update(secret).digest();
  const suppliedDigest = createHash("sha256").update(suppliedToken).digest();
  return Boolean(suppliedToken) && timingSafeEqual(expectedDigest, suppliedDigest);
}

function respond(res: ServerResponse, status: number, body: Readonly<Record<string, boolean | string>>): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(JSON.stringify(body)),
  });
  res.end(JSON.stringify(body));
}

type JsonBodyReadResult =
  | Readonly<{ kind: "ok"; body: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "invalid" | "too_large" }>;

async function readJsonBody(req: IncomingMessage): Promise<JsonBodyReadResult> {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    req.resume();
    return { kind: "too_large" };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > maxBodyBytes) {
      for (const bufferedPart of chunks) bufferedPart.fill(0);
      part.fill(0);
      req.resume();
      return { kind: "too_large" };
    }
    chunks.push(part);
  }
  const raw = Buffer.concat(chunks);
  try {
    const value = JSON.parse(raw.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
    return { kind: "ok", body: value as Readonly<Record<string, unknown>> };
  } catch {
    return { kind: "invalid" };
  } finally {
    raw.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: WorkerCodeReceiverOptions): Promise<void> {
  if (!authorized(req.headers.authorization, options.serviceSecret)) {
    respond(res, 401, { error: "SERVICE_AUTH_REQUIRED" });
    return;
  }
  const pathname = new URL(req.url ?? "/", "http://worker.internal").pathname;
  const invalidateMatch = /^\/internal\/auth-challenges\/([0-9a-f-]{36})$/i.exec(pathname);
  if (req.method === "DELETE" && invalidateMatch && uuidPattern.test(invalidateMatch[1])) {
    options.inbox.invalidate(invalidateMatch[1]);
    respond(res, 202, { invalidated: true });
    return;
  }
  const match = /^\/internal\/auth-challenges\/([0-9a-f-]{36})\/code$/i.exec(pathname);
  if (req.method !== "POST" || !match || !uuidPattern.test(match[1])) {
    respond(res, 404, { error: "NOT_FOUND" });
    return;
  }
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    req.resume();
    respond(res, 415, { error: "CONTENT_TYPE_INVALID" });
    return;
  }
  const parsed = await readJsonBody(req);
  if (parsed.kind !== "ok") {
    respond(res, parsed.kind === "too_large" ? 413 : 400, { error: "REQUEST_BODY_INVALID" });
    return;
  }
  const body = parsed.body;
  if (Object.keys(body).length !== 1 || typeof body.code !== "string") {
    respond(res, 400, { error: "CODE_INVALID" });
    return;
  }
  try {
    options.inbox.submit(match[1], body.code);
    respond(res, 202, { accepted: true });
  } catch (error) {
    const code = error instanceof CodeInboxError ? error.code : "CODE_INVALID";
    const status = code === "CHALLENGE_EXPIRED" ? 410 : code === "CODE_INVALID" ? 400 : 409;
    respond(res, status, { error: code });
  }
}

export async function startWorkerCodeReceiver(options: WorkerCodeReceiverOptions): Promise<Readonly<{
  server: Server;
  close: () => Promise<void>;
  address: Readonly<{ host: string; port: number }>;
}>> {
  if (!options.host || !Number.isInteger(options.port) || options.port < 0 || options.port > 65_535
    || options.serviceSecret.length < 32) {
    throw new Error("WORKER_CODE_RECEIVER_CONFIG_INVALID");
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res, options).catch(() => {
      if (!res.headersSent) respond(res, 500, { error: "CODE_RECEIVER_FAILED" });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("WORKER_CODE_RECEIVER_ADDRESS_INVALID");
  }
  return {
    server,
    address: { host: options.host, port: address.port },
    close: async () => new Promise<void>((resolve, reject) => {
      options.inbox.close();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
