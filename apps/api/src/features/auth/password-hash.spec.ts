import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, needsRehash, verifyPassword } from "./password-hash";

test("hasło jest zapisywane jako losowany hash scrypt i weryfikowane bez ujawnienia tekstu", async () => {
  const password = "Synthetic-only Password 123!";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt\$v1\$N=131072,r=8,p=1\$/);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
  assert.equal(await verifyPassword(password, "plain-text-password"), false);
  assert.equal(await verifyPassword(password, "scrypt$short$short"), false);
  assert.equal(needsRehash(first), false);
});

test("legacy scrypt verifier remains readable and requests an opportunistic rehash", async () => {
  const legacy =
    "scrypt$ABEiM0RVZneImaq7zN3u_w$0mKUoq-QaH7C-Vu7_zwnyPeY0nHfZS7-PsOCrYQqOGV_aRTibMs9rgmUgkf08NwN4LqhljjTsUCy_FSB-qPQOQ";
  assert.equal(await verifyPassword("Legacy-only Synthetic Password!", legacy), true);
  assert.equal(await verifyPassword("wrong synthetic password", legacy), false);
  assert.equal(needsRehash(legacy), true);
  assert.equal(needsRehash("scrypt$v2$N=999999999,r=8,p=1$bad$bad"), true);
});
