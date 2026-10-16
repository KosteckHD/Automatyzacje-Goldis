import assert from "node:assert/strict";
import { test } from "node:test";
import { containsControlCharacters } from "./control-characters";

test("detects ASCII control characters and preserves ordinary Unicode text", () => {
  assert.equal(containsControlCharacters("ordinary text"), false);
  assert.equal(containsControlCharacters("Zażółć gęślą jaźń"), false);
  assert.equal(containsControlCharacters(`nul${String.fromCharCode(0)}`), true);
  assert.equal(containsControlCharacters(`tab${String.fromCharCode(9)}`), true);
  assert.equal(containsControlCharacters(`del${String.fromCharCode(127)}`), true);
});
