import { readFile } from "node:fs/promises";

const maxPayloadBytes = 100 * 1024 * 1024;
const maxResponseBytes = 64 * 1024 * 1024;

async function readJsonResponse<T>(response: Response): Promise<T | { detail?: { code?: string; message?: string } } | null> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxResponseBytes) throw new Error("COMMISSION_ENGINE_RESPONSE_LIMIT");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        throw new Error("COMMISSION_ENGINE_RESPONSE_LIMIT");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return JSON.parse(bytes.toString("utf8")) as T | { detail?: { code?: string; message?: string } };
  } catch {
    return null;
  }
}

async function internalToken(): Promise<string> {
  const token = process.env.COMMISSION_ENGINE_TOKEN_FILE
    ? (await readFile(process.env.COMMISSION_ENGINE_TOKEN_FILE, "utf8")).trim()
    : process.env.COMMISSION_ENGINE_TOKEN?.trim();
  if (!token || Buffer.byteLength(token, "utf8") < 32) throw new Error("COMMISSION_ENGINE_NOT_CONFIGURED");
  return token;
}

export class CommissionEngineClient {
  private async baseAndToken(): Promise<{ base: string; token: string }> {
    const base = process.env.COMMISSION_ENGINE_URL?.replace(/\/$/, "");
    if (!base || !/^https?:\/\//.test(base)) throw new Error("COMMISSION_ENGINE_NOT_CONFIGURED");
    return { base, token: await internalToken() };
  }

  async execute<T>(
    path: "/internal/v1/dictionary/import" | "/internal/v1/compare" | "/internal/v1/export",
    body: unknown,
  ): Promise<T> {
    const { base, token } = await this.baseAndToken();
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, "utf8") > maxPayloadBytes) throw new Error("COMMISSION_ENGINE_PAYLOAD_LIMIT");
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: encoded,
      signal: AbortSignal.timeout(660_000),
      redirect: "error",
    });
    const payload = await readJsonResponse<T>(response);
    if (!response.ok) {
      const detail = payload && typeof payload === "object" && "detail" in payload ? payload.detail : undefined;
      throw new Error(typeof detail?.code === "string" ? detail.code : "COMMISSION_ENGINE_FAILED");
    }
    return payload as T;
  }

  async cancel(executionId: string, attemptToken: string): Promise<void> {
    const { base, token } = await this.baseAndToken();
    await fetch(`${base}/internal/v1/executions/${encodeURIComponent(executionId)}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ attemptToken }),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    }).catch(() => undefined);
  }
}
