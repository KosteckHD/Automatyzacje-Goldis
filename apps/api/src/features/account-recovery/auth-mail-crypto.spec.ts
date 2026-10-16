import assert from "node:assert/strict";
import test from "node:test";
import { decryptAuthMailContent, encryptAuthMailContent } from "./auth-mail-crypto";
import { passwordResetMail, verifyRecoveryEmailMail } from "./auth-mail-templates";

const mailId = "d6df1f6b-87d5-4f11-a11b-0c1e58a55e88";
const keyId = "1";
const token = "A".repeat(43);
const config = {
  enabled: true,
  provider: "resend" as const,
  publicOrigin: "https://app.example.test",
  from: "Goldis <recovery@mail.example.test>",
  replyTo: null,
  resendApiKey: `re_${"x".repeat(32)}`,
};

function withKeyring<T>(
  run: () => T,
  versions: Readonly<Record<string, string>> = { "1": Buffer.alloc(32, 17).toString("base64") },
  active = "1",
): T {
  const previousKeys = process.env.AUTH_MAIL_ENCRYPTION_KEYS_BASE64;
  const previousActive = process.env.AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION;
  process.env.AUTH_MAIL_ENCRYPTION_KEYS_BASE64 = Buffer.from(JSON.stringify(versions)).toString("base64");
  process.env.AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION = active;
  try {
    return run();
  } finally {
    if (previousKeys === undefined) delete process.env.AUTH_MAIL_ENCRYPTION_KEYS_BASE64;
    else process.env.AUTH_MAIL_ENCRYPTION_KEYS_BASE64 = previousKeys;
    if (previousActive === undefined) delete process.env.AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION;
    else process.env.AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION = previousActive;
  }
}

test("auth mail payload is encrypted with AES-GCM and bound to its mail id", () =>
  withKeyring(() => {
    const content = passwordResetMail(config, "alice@example.test", token);
    const encrypted = encryptAuthMailContent(mailId, content);
    assert.equal(encrypted.keyVersion, 1);
    assert.equal(encrypted.ciphertext.includes(Buffer.from(token)), false);
    assert.deepEqual(
      decryptAuthMailContent(mailId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion),
      content,
    );
    assert.throws(
      () =>
        decryptAuthMailContent(
          "a67e9bd4-982e-4edb-a8fa-309c72a4bd40",
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.keyVersion,
        ),
      /AUTH_MAIL_PAYLOAD_DECRYPT_FAILED/,
    );
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] ^= 1;
    assert.throws(
      () => decryptAuthMailContent(mailId, tampered, encrypted.nonce, encrypted.authTag, encrypted.keyVersion),
      /AUTH_MAIL_PAYLOAD_DECRYPT_FAILED/,
    );
  }));

test("rotating the active mail key keeps ciphertext readable with its recorded key version", () => {
  const oldKey = Buffer.alloc(32, 12).toString("base64");
  const newKey = Buffer.alloc(32, 24).toString("base64");
  const encrypted = withKeyring(
    () => encryptAuthMailContent(mailId, verifyRecoveryEmailMail(config, "alice@example.test", token)),
    { "1": oldKey },
    "1",
  );
  const decrypted = withKeyring(
    () =>
      decryptAuthMailContent(mailId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion),
    { "1": oldKey, "2": newKey },
    "2",
  );
  assert.match(decrypted.text, /24 godzin/);
});

test("recovery links keep their token in the URL fragment rather than query or path", () =>
  withKeyring(() => {
    const mail = passwordResetMail(config, "alice@example.test", token);
    assert.match(mail.text, /https:\/\/app\.example\.test\/reset-hasla#token=A{43}/);
    assert.equal(mail.text.includes("?token="), false);
    assert.equal(
      verifyRecoveryEmailMail(config, "alice@example.test", token).text.includes("/potwierdz-email#token="),
      true,
    );
  }));
