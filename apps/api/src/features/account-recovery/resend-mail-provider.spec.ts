import assert from "node:assert/strict";
import test from "node:test";
import { ResendMailProvider } from "./resend-mail-provider";

const message = {
  idempotencyKey: "goldis-auth-mail/11111111-1111-4111-8111-111111111111",
  from: "Goldis <recovery@example.test>",
  to: "user@example.test",
  replyTo: "help@example.test",
  subject: "Ustaw nowe hasło",
  html: "<p>Link</p>",
  text: "Link",
};
const saved = new Map<string, string | undefined>();
const keys = [
  "GOLDIS_PASSWORD_RECOVERY_ENABLED",
  "GOLDIS_EMAIL_PROVIDER",
  "PUBLIC_APP_ORIGIN",
  "GOLDIS_EMAIL_FROM",
  "GOLDIS_EMAIL_REPLY_TO",
  "RESEND_API_KEY",
  "NODE_ENV",
];
function configure() {
  for (const key of keys) saved.set(key, process.env[key]);
  Object.assign(process.env, {
    GOLDIS_PASSWORD_RECOVERY_ENABLED: "1",
    GOLDIS_EMAIL_PROVIDER: "resend",
    PUBLIC_APP_ORIGIN: "https://app.example.test",
    GOLDIS_EMAIL_FROM: "Goldis <recovery@example.test>",
    GOLDIS_EMAIL_REPLY_TO: "help@example.test",
    RESEND_API_KEY: `re_${"b".repeat(32)}`,
    NODE_ENV: "test",
  });
}
function restore() {
  for (const key of keys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
}

test("sends only to the fixed Resend endpoint and returns the provider message id", async (t) => {
  configure();
  t.after(restore);
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  const provider = new ResendMailProvider(async (input, init) => {
    capturedUrl = String(input);
    captured = init;
    return new Response(JSON.stringify({ id: "resend-message-123" }), { status: 200 });
  });
  assert.deepEqual(await provider.send(message), { kind: "submitted", providerMessageId: "resend-message-123" });
  assert.equal(capturedUrl, "https://api.resend.com/emails");
  assert.equal(new Headers(captured?.headers).get("authorization"), `Bearer re_${"b".repeat(32)}`);
  assert.equal(new Headers(captured?.headers).get("idempotency-key"), message.idempotencyKey);
  const body = JSON.parse(String(captured?.body));
  assert.deepEqual(body.to, [message.to]);
  assert.equal(body.reply_to, message.replyTo);
});

test("classifies Resend throttling, server errors and permanent response errors", async (t) => {
  configure();
  t.after(restore);
  const throttled = new ResendMailProvider(
    async () => new Response("{}", { status: 429, headers: { "retry-after": "17" } }),
  );
  assert.deepEqual(await throttled.send(message), {
    kind: "retry",
    errorCode: "provider_rate_limited",
    retryAfterSeconds: 17,
  });
  const temporary = new ResendMailProvider(async () => new Response("{}", { status: 503 }));
  assert.deepEqual(await temporary.send(message), { kind: "retry", errorCode: "provider_temporary_failure" });
  const unauthorized = new ResendMailProvider(async () => new Response("private provider details", { status: 401 }));
  assert.deepEqual(await unauthorized.send(message), { kind: "failed", errorCode: "provider_auth_rejected" });
  const invalidResponse = new ResendMailProvider(async () => new Response("not-json", { status: 200 }));
  assert.deepEqual(await invalidResponse.send(message), { kind: "retry", errorCode: "provider_response_invalid" });
});

test("network timeout is retriable and never includes the API key in its error", async (t) => {
  configure();
  t.after(restore);
  const hanging = (_input: URL | RequestInfo, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
  const result = await new ResendMailProvider(hanging, Date.now, 5).send(message);
  assert.deepEqual(result, { kind: "retry", errorCode: "provider_timeout" });
  assert.equal(JSON.stringify(result).includes(process.env.RESEND_API_KEY!), false);
});
