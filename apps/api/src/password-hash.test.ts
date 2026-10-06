import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "./password-hash";

test("hasło jest zapisywane jako losowany hash scrypt i weryfikowane bez ujawnienia tekstu", async () => {
  const password = "Synthetic-only Password 123!";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt\$/);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
  assert.equal(await verifyPassword(password, "plain-text-password"), false);
  assert.equal(await verifyPassword(password, "scrypt$short$short"), false);
});
