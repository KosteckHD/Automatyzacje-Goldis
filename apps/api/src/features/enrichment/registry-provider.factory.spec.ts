import assert from "node:assert/strict";
import { test } from "node:test";
import { PersistentRegistryCacheProvider } from "./registry-cache";
import { createRegistryProviderFromEnvironment } from "./registry-provider.factory";

const CACHE_KEY = "ab".repeat(32);

test("registry provider factory defaults to disabled and selects explicitly configured providers", () => {
  assert.equal(createRegistryProviderFromEnvironment({}), null);
  assert.equal(createRegistryProviderFromEnvironment({ GOLDIS_ENRICHMENT_PROVIDER: "disabled" }), null);
  assert.throws(
    () => createRegistryProviderFromEnvironment({ GOLDIS_ENRICHMENT_PROVIDER: "mf-vat" }),
    /REGISTRY_CACHE_HMAC_KEY/,
  );
  const live = createRegistryProviderFromEnvironment({
    GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
    REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
  });
  assert.ok(live instanceof PersistentRegistryCacheProvider);
  assert.equal(live.cacheNamespace, "mf-vat");
  const test = createRegistryProviderFromEnvironment({
    GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
    MF_VAT_ENVIRONMENT: "test",
    REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
  });
  assert.ok(test instanceof PersistentRegistryCacheProvider);
  const localFixture = createRegistryProviderFromEnvironment({
    GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
    MF_VAT_ENVIRONMENT: "test",
    MF_VAT_TEST_BASE_URL: "http://127.0.0.1:43123/",
    REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
  });
  assert.ok(localFixture instanceof PersistentRegistryCacheProvider);
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
        MF_VAT_ENVIRONMENT: "production",
        MF_VAT_TEST_BASE_URL: "http://127.0.0.1:43123/",
        REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
      }),
    /MF_VAT_TEST_URL_MUST_BE_LOOPBACK/,
  );
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
        MF_VAT_ENVIRONMENT: "test",
        MF_VAT_TEST_BASE_URL: "https://attacker.example/",
        REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
      }),
    /MF_VAT_TEST_URL_MUST_BE_LOOPBACK/,
  );
  const bir = createRegistryProviderFromEnvironment({
    GOLDIS_ENRICHMENT_PROVIDER: "gus-bir",
    GUS_BIR_ENVIRONMENT: "test",
    GUS_BIR_USER_KEY: "synthetic-key",
    REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
  });
  assert.ok(bir instanceof PersistentRegistryCacheProvider);
  assert.equal(bir.cacheNamespace, "gus-bir");
});

test("registry provider factory refuses unsupported or malformed live configuration", () => {
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        APP_ENV: "production",
        GOLDIS_ENRICHMENT_PROVIDER: "gus-bir",
        GUS_BIR_USER_KEY: "synthetic-key",
        REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
      }),
    /GOLDIS_ENRICHMENT_PROVIDER_INVALID/,
  );
  assert.throws(
    () => createRegistryProviderFromEnvironment({ GOLDIS_ENRICHMENT_PROVIDER: "gus-bir" }),
    /GUS_BIR_USER_KEY_REQUIRED/,
  );
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        GOLDIS_ENRICHMENT_PROVIDER: "gus-bir",
        GUS_BIR_USER_KEY: "synthetic-key",
        REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
        GUS_BIR_ENVIRONMENT: "external-url",
      }),
    /GUS_BIR_ENVIRONMENT_INVALID/,
  );
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        GOLDIS_ENRICHMENT_PROVIDER: "gus-bir",
        GUS_BIR_USER_KEY: "synthetic-key",
      }),
    /REGISTRY_CACHE_HMAC_KEY/,
  );
  assert.throws(
    () => createRegistryProviderFromEnvironment({ GOLDIS_ENRICHMENT_PROVIDER: "other" }),
    /GOLDIS_ENRICHMENT_PROVIDER_INVALID/,
  );
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
        REGISTRY_CACHE_HMAC_KEY: "not-secret",
      }),
    /REGISTRY_CACHE_HMAC_KEY/,
  );
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
        MF_VAT_ENVIRONMENT: "external-url",
        REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
      }),
    /MF_VAT_ENVIRONMENT_INVALID/,
  );
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
        REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
        MF_VAT_MIN_REQUEST_INTERVAL_MS: "0",
      }),
    /MF_VAT_MIN_REQUEST_INTERVAL_MS_INVALID/,
  );
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        GOLDIS_ENRICHMENT_PROVIDER: "gus-bir",
        GUS_BIR_USER_KEY: "synthetic-key",
        REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
        GUS_BIR_MIN_REQUEST_INTERVAL_MS: "60001",
      }),
    /GUS_BIR_MIN_REQUEST_INTERVAL_MS_INVALID/,
  );
  assert.throws(
    () =>
      createRegistryProviderFromEnvironment({
        GOLDIS_ENRICHMENT_PROVIDER: "mf-vat",
        REGISTRY_CACHE_HMAC_KEY: CACHE_KEY,
        MF_VAT_MIN_REQUEST_INTERVAL_MS: "1.5",
      }),
    /MF_VAT_MIN_REQUEST_INTERVAL_MS_INVALID/,
  );
});
