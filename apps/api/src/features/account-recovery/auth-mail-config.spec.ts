import assert from "node:assert/strict";
import test from "node:test";
import { assertAuthMailProductionConfiguration, readAuthMailConfig } from "./auth-mail-config";

test("odzyskiwanie poczty jest domyślnie wyłączone i nie wymaga sekretów", () => {
  const config = readAuthMailConfig({ NODE_ENV: "test" });
  assert.equal(config.enabled, false);
  assert.equal(config.provider, "disabled");
  assert.equal(config.resendApiKey, null);
});

test("produkcja wymaga HTTPS, nadawcy, API key i aktywnego keyringu, gdy recovery jest włączone", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const valid = {
    APP_ENV: "production",
    NODE_ENV: "production",
    GOLDIS_PASSWORD_RECOVERY_ENABLED: "1",
    GOLDIS_EMAIL_PROVIDER: "resend",
    PUBLIC_APP_ORIGIN: "https://app.example.test",
    GOLDIS_EMAIL_FROM: "Goldis <recovery@mail.example.test>",
    GOLDIS_EMAIL_REPLY_TO: "help@example.test",
    RESEND_API_KEY: `re_${"a".repeat(32)}`,
    AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION: "1",
    AUTH_MAIL_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify({ "1": key })).toString("base64"),
  };
  assert.doesNotThrow(() => assertAuthMailProductionConfiguration(valid));
  assert.throws(() => assertAuthMailProductionConfiguration({ ...valid, RESEND_API_KEY: "" }), /AUTH_MAIL/);
  assert.throws(
    () => assertAuthMailProductionConfiguration({ ...valid, PUBLIC_APP_ORIGIN: "http://app.example.test" }),
    /AUTH_MAIL/,
  );
  assert.throws(
    () =>
      assertAuthMailProductionConfiguration({
        ...valid,
        AUTH_MAIL_ENCRYPTION_KEYS_BASE64: Buffer.from(
          JSON.stringify({ "1": Buffer.alloc(31).toString("base64") }),
        ).toString("base64"),
      }),
    /AUTH_MAIL/,
  );
});

test("rejects unknown providers and sender header injection", () => {
  assert.throws(() => readAuthMailConfig({ GOLDIS_EMAIL_PROVIDER: "smtp" }), /AUTH_MAIL_PROVIDER_INVALID/);
  assert.throws(
    () =>
      readAuthMailConfig({
        GOLDIS_PASSWORD_RECOVERY_ENABLED: "1",
        GOLDIS_EMAIL_PROVIDER: "resend",
        PUBLIC_APP_ORIGIN: "https://app.example.test",
        GOLDIS_EMAIL_FROM: "Goldis <a@example.test>\r\nBcc: x@example.test>",
        RESEND_API_KEY: `re_${"a".repeat(32)}`,
      }),
    /AUTH_MAIL_SENDER_CONFIGURATION_INVALID/,
  );
});
