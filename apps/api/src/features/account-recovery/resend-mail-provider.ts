import { containsControlCharacters } from "../../shared/control-characters";
import { type AuthMailConfig, readAuthMailConfig } from "./auth-mail-config";
import type { AuthMailMessage, AuthMailProvider, AuthMailSendResult } from "./auth-mail-provider";

const resendEndpoint = "https://api.resend.com/emails";
const requestTimeoutMs = 8_000;
const maxResponseBytes = 8_192;

async function readBoundedText(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function retryAfterSeconds(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d{1,6}$/.test(value)) return Math.max(1, Math.min(900, Number(value)));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.min(900, Math.ceil((date - now) / 1000))) : undefined;
}

export class ResendMailProvider implements AuthMailProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = requestTimeoutMs,
  ) {}

  async send(message: AuthMailMessage): Promise<AuthMailSendResult> {
    let config: AuthMailConfig;
    try {
      config = readAuthMailConfig();
    } catch {
      return { kind: "failed", errorCode: "provider_configuration_invalid" };
    }
    if (!config.enabled || config.provider !== "resend" || !config.resendApiKey) {
      return { kind: "failed", errorCode: "provider_disabled" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(resendEndpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${config.resendApiKey}`,
          "content-type": "application/json",
          "idempotency-key": message.idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });
      const body = await readBoundedText(response);
      if (response.status === 429)
        return {
          kind: "retry",
          errorCode: "provider_rate_limited",
          retryAfterSeconds: retryAfterSeconds(response, this.now()),
        };
      if (response.status === 408 || response.status >= 500)
        return { kind: "retry", errorCode: "provider_temporary_failure" };
      if (!response.ok)
        return {
          kind: "failed",
          errorCode:
            response.status === 401 || response.status === 403
              ? "provider_auth_rejected"
              : response.status === 409
                ? "provider_idempotency_conflict"
                : "provider_request_rejected",
        };
      if (body === null) return { kind: "retry", errorCode: "provider_response_too_large" };
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return { kind: "retry", errorCode: "provider_response_invalid" };
      }
      const id = payload && typeof payload === "object" ? (payload as Record<string, unknown>).id : null;
      if (typeof id !== "string" || id.length < 1 || id.length > 200 || containsControlCharacters(id)) {
        return { kind: "retry", errorCode: "provider_response_invalid" };
      }
      return { kind: "submitted", providerMessageId: id };
    } catch (error) {
      return {
        kind: "retry",
        errorCode:
          error instanceof Error && error.name === "AbortError" ? "provider_timeout" : "provider_network_failure",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
