import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decryptPesel,
  encryptIdentityForPersistence,
  encryptPesel,
  PeselEncryptionError,
  peselErrorCodeForLog,
  type PeselEncryptionContext,
} from "./pesel-crypto";

const context: PeselEncryptionContext = {
  runId: "11111111-1111-4111-8111-111111111111",
  sourceRowId: "22222222-2222-4222-8222-222222222222",
};
const key1 = Buffer.alloc(32, 1).toString("base64");
const key2 = Buffer.alloc(32, 2).toString("base64");
const identity = {
  schemaVersion: 1 as const,
  sourceRowId: context.sourceRowId,
  regon: "012345678",
  companyName: "Synthetic Company",
  firstName: "Jan",
  lastName: "Example",
  pesel: "90010100016",
  matchMethod: "unique_business_identity" as const,
  adapterVersion: "fixture-v1",
};

function config(activeVersion: number, keys: Record<string, string>): Record<string, string> {
  return {
    PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: String(activeVersion),
    PESEL_ENCRYPTION_KEYS_BASE64: Buffer.from(JSON.stringify(keys), "utf8").toString("base64"),
  };
}

test("PESEL szyfruje się losowym IV, wraca w round-trip i zapisuje wersję klucza", () => {
  const value = "90010100016";
  const keyring = config(1, { "1": key1 });
  const first = encryptPesel(value, context, keyring);
  const second = encryptPesel(value, context, keyring);

  assert.equal(first.keyVersion, 1);
  assert.match(first.ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.ciphertext.includes(value), false);
  assert.equal(decryptPesel(first, context, keyring), value);
});

test("rotacja aktywnego klucza zachowuje odczyt starszego szyfrogramu", () => {
  const oldKeyring = config(1, { "1": key1 });
  const encrypted = encryptPesel("90010100016", context, oldKeyring);
  const rotatedKeyring = config(2, { "1": key1, "2": key2 });
  assert.equal(decryptPesel(encrypted, context, rotatedKeyring), "90010100016");
  assert.equal(encryptPesel("90010100016", context, rotatedKeyring).keyVersion, 2);
});

test("rekord przygotowany do DB nie zawiera jawnego PESEL", () => {
  const prepared = encryptIdentityForPersistence(identity, context.runId, config(1, { "1": key1 }));
  const serialized = JSON.stringify(prepared);
  assert.equal("pesel" in prepared, false);
  assert.equal(prepared.peselKeyVersion, 1);
  assert.equal(serialized.includes(identity.pesel), false);
  assert.equal(decryptPesel({ ciphertext: prepared.peselCiphertext, keyVersion: prepared.peselKeyVersion }, context, config(1, { "1": key1 })), identity.pesel);
});

test("brak lub błędny klucz kończy się kodem konfiguracji bez PESEL ani klucza w błędzie", () => {
  const privateMarker = "90010100016";
  const invalidConfigs = [
    {},
    { PESEL_ENCRYPTION_ACTIVE_KEY_VERSION: "1", PESEL_ENCRYPTION_KEYS_BASE64: "not-base64" },
    config(3, { "1": key1 }),
    config(1, { "1": Buffer.alloc(16, 3).toString("base64") }),
  ];
  for (const environment of invalidConfigs) {
    assert.throws(() => encryptPesel(privateMarker, context, environment), (error: unknown) => {
      assert.ok(error instanceof PeselEncryptionError);
      assert.equal(error.code, "PESEL_ENCRYPTION_CONFIG_INVALID");
      assert.equal(error.message.includes(privateMarker), false);
      assert.equal(error.message.includes(key1), false);
      assert.equal(peselErrorCodeForLog(error), "PESEL_ENCRYPTION_CONFIG_INVALID");
      return true;
    });
  }
  assert.equal(peselErrorCodeForLog(new Error("sensitive exception text")), "PESEL_OPERATION_FAILED");
});

test("szyfrogram jest powiązany z runem i wierszem źródłowym", () => {
  const encrypted = encryptPesel("90010100016", context, config(1, { "1": key1 }));
  assert.throws(() => decryptPesel(encrypted, { ...context, runId: "33333333-3333-4333-8333-333333333333" }, config(1, { "1": key1 })), {
    code: "PESEL_DECRYPT_FAILED",
  });
});

test("odrzuca nieprawidłowy format PESEL i kontekst bez zapisu jawnego tekstu", () => {
  const keyring = config(1, { "1": key1 });
  assert.throws(() => encryptPesel("123", context, keyring), { code: "PESEL_FORMAT_INVALID" });
  assert.throws(() => encryptPesel("90010100016", { ...context, runId: "bad" }, keyring), { code: "PESEL_CONTEXT_INVALID" });
  assert.throws(() => decryptPesel(null as never, context, keyring), { code: "PESEL_CIPHERTEXT_INVALID" });
});
