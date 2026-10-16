import assert from "node:assert/strict";
import { test } from "node:test";
import { passwordPolicyFailure } from "./password-policy";

test("polityka liczy punkty Unicode i zachowuje spacje jako część sekretu", () => {
  assert.equal(passwordPolicyFailure("abcdefghijklmn"), "too_short");
  assert.equal(passwordPolicyFailure("abcdefghijklmno"), null);
  assert.equal(passwordPolicyFailure("  abcdefghijklmn"), null);
  assert.equal(passwordPolicyFailure("😀".repeat(15)), null);
  assert.equal(passwordPolicyFailure("😀".repeat(1_025)), "too_long");
});

test("polityka blokuje lokalny placeholder i nie zmienia sekretu przez trim", () => {
  assert.equal(passwordPolicyFailure("REPLACE_WITH_LOCAL_PASSWORD"), "known_placeholder");
  assert.equal(passwordPolicyFailure(" abcdefghijklmno "), null);
});
