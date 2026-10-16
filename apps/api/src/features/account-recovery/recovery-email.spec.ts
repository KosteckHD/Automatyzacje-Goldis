import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRecoveryEmail } from "./recovery-email";

test("recovery email normalization trims and case-folds without provider-specific rewriting", () => {
  assert.deepEqual(normalizeRecoveryEmail("  Alice+sales@EXAMPLE.COM  "), {
    address: "Alice+sales@EXAMPLE.COM",
    normalized: "alice+sales@example.com",
  });
  assert.equal(normalizeRecoveryEmail("a.l.i.c.e@example.com")?.normalized, "a.l.i.c.e@example.com");
  assert.equal(normalizeRecoveryEmail("user@bücher.de")?.normalized, "user@xn--bcher-kva.de");
});

test("rejects malformed, oversized, and control-character recovery addresses", () => {
  for (const value of [
    "",
    " user ",
    "a@@example.com",
    ".a@example.com",
    "a..b@example.com",
    "a@example",
    "a@-example.com",
    "a@example..com",
    "a@example.com\r\nBcc:x@example.net",
    `${"a".repeat(65)}@example.com`,
    `${"a".repeat(245)}@example.com`,
  ]) {
    assert.equal(normalizeRecoveryEmail(value), null, value);
  }
  assert.equal(normalizeRecoveryEmail(null), null);
});
