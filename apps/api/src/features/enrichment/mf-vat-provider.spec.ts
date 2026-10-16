import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MfVatRegistryProvider } from "./mf-vat-provider";
import { RegistryProviderError } from "./registry-provider";

const nip = "0000000000";
const fixedNow = () => new Date("2026-10-07T00:30:00.000Z");

async function withServer(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

test("MF adapter calls the official search contract and returns only minimal identity fields", async () => {
  let requestPath = "";
  await withServer(
    (request, response) => {
      requestPath = request.url ?? "";
      sendJson(response, 200, {
        result: {
          subject: {
            nip,
            name: "FIKCYJNY PODMIOT",
            regon: "001234567",
            pesel: "00000000000",
            representatives: [{ firstName: "SYNTHETIC", pesel: "11111111111" }],
            residenceAddress: "NIE ZWRACAĆ TEJ DANEJ",
          },
        },
      });
    },
    async (baseUrl) => {
      const provider = new MfVatRegistryProvider({ environment: "test", testBaseUrl: baseUrl, now: fixedNow });
      const result = await provider.lookupByNip(nip);
      assert.deepEqual(result, {
        providerName: "mf-vat",
        providerVersion: "1.6.1",
        dataVersion: null,
        fetchedAt: fixedNow(),
        candidates: [{ nip, name: "FIKCYJNY PODMIOT", regon: "001234567" }],
      });
    },
  );
  assert.equal(requestPath, `/api/search/nip/${nip}?date=2026-10-07`);
});

test("MF adapter distinguishes an empty search result without claiming the entity does not exist", async () => {
  await withServer(
    (_request, response) => sendJson(response, 200, { result: { subject: null } }),
    async (baseUrl) => {
      const provider = new MfVatRegistryProvider({ environment: "test", testBaseUrl: baseUrl, now: fixedNow });
      const result = await provider.lookupByNip(nip);
      assert.deepEqual(result.candidates, []);
    },
  );
});

test("MF batch performs one official request and maps shuffled entries by NIP without retaining personal fields", async () => {
  const otherNip = "1111111111";
  let requestPath = "";
  let requestCount = 0;
  await withServer(
    (request, response) => {
      requestPath = request.url ?? "";
      requestCount += 1;
      sendJson(response, 200, {
        result: {
          entries: [
            {
              identifier: otherNip,
              subjects: [{ nip: otherNip, name: "DRUGI FIKCYJNY PODMIOT", regon: "123456789", pesel: "11111111111" }],
            },
            {
              identifier: nip,
              subjects: [
                { nip, name: "FIKCYJNY PODMIOT", regon: "001234567", representatives: [{ pesel: "11111111111" }] },
              ],
            },
          ],
        },
      });
    },
    async (baseUrl) => {
      const provider = new MfVatRegistryProvider({ environment: "test", testBaseUrl: baseUrl, now: fixedNow });
      const results = await provider.lookupManyByNip([nip, otherNip]);
      assert.equal(results.size, 2);
      assert.deepEqual(results.get(nip), {
        kind: "result",
        result: {
          providerName: "mf-vat",
          providerVersion: "1.6.1",
          dataVersion: null,
          fetchedAt: fixedNow(),
          candidates: [{ nip, name: "FIKCYJNY PODMIOT", regon: "001234567" }],
        },
      });
      assert.deepEqual(results.get(otherNip), {
        kind: "result",
        result: {
          providerName: "mf-vat",
          providerVersion: "1.6.1",
          dataVersion: null,
          fetchedAt: fixedNow(),
          candidates: [{ nip: otherNip, name: "DRUGI FIKCYJNY PODMIOT", regon: "123456789" }],
        },
      });
    },
  );
  assert.equal(requestCount, 1);
  assert.equal(requestPath, `/api/search/nips/${nip},1111111111?date=2026-10-07`);
});

test("MF batch isolates entry errors by identifier and rejects duplicate, omitted, or unrequested identifiers", async () => {
  const otherNip = "1111111111";
  await withServer(
    (_request, response) =>
      sendJson(response, 200, {
        result: {
          entries: [
            { identifier: nip, subjects: [{ nip, name: "FIKCYJNY PODMIOT", regon: "123456789" }] },
            { identifier: otherNip, error: { code: "WL-101", message: "synthetic-sensitive-error" } },
          ],
        },
      }),
    async (baseUrl) => {
      const provider = new MfVatRegistryProvider({ environment: "test", testBaseUrl: baseUrl, now: fixedNow });
      const outcomes = await provider.lookupManyByNip([nip, otherNip]);
      assert.equal(outcomes.get(nip)?.kind, "result");
      const failed = outcomes.get(otherNip);
      assert.equal(failed?.kind, "error");
      if (failed?.kind === "error") {
        assert.equal(failed.error.code, "INVALID_RESPONSE");
        assert.doesNotMatch(failed.error.message, /synthetic-sensitive-error/);
      }
    },
  );

  for (const entries of [
    [
      { identifier: nip, subjects: [] },
      { identifier: nip, subjects: [] },
    ],
    [{ identifier: nip, subjects: [] }],
    [
      { identifier: "2222222222", subjects: [] },
      { identifier: otherNip, subjects: [] },
    ],
  ]) {
    await withServer(
      (_request, response) => sendJson(response, 200, { result: { entries } }),
      async (baseUrl) => {
        const provider = new MfVatRegistryProvider({ environment: "test", testBaseUrl: baseUrl, now: fixedNow });
        await assert.rejects(provider.lookupManyByNip([nip, otherNip]), (error: unknown) => {
          assert.ok(error instanceof RegistryProviderError);
          assert.equal(error.code, "INVALID_RESPONSE");
          return true;
        });
      },
    );
  }
});

test("MF batch rejects more than thirty NIPs before making a request", async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests += 1;
      sendJson(response, 200, { result: { entries: [] } });
    },
    async (baseUrl) => {
      const provider = new MfVatRegistryProvider({ environment: "test", testBaseUrl: baseUrl, now: fixedNow });
      await assert.rejects(provider.lookupManyByNip(Array.from({ length: 31 }, () => nip)), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "INVALID_RESPONSE");
        return true;
      });
    },
  );
  assert.equal(requests, 0);
});

test("MF adapter rejects malformed or mismatched identity responses", async () => {
  for (const body of [
    { result: {} },
    { result: { subject: { nip: "1111111111", name: "INNY PODMIOT", regon: "123456789" } } },
    { result: { subject: { nip, name: "PODMIOT", regon: "123" } } },
  ]) {
    await withServer(
      (_request, response) => sendJson(response, 200, body),
      async (baseUrl) => {
        const provider = new MfVatRegistryProvider({ environment: "test", testBaseUrl: baseUrl, now: fixedNow });
        await assert.rejects(provider.lookupByNip(nip), (error: unknown) => {
          assert.ok(error instanceof RegistryProviderError);
          assert.equal(error.code, "INVALID_RESPONSE");
          return true;
        });
      },
    );
  }
});

test("MF IP quota WL-191 becomes a bounded typed cooldown without exposing the response body", async () => {
  await withServer(
    (_request, response) => sendJson(response, 400, { code: "WL-191", message: "synthetic-private-provider-text" }),
    async (baseUrl) => {
      const provider = new MfVatRegistryProvider({ environment: "test", testBaseUrl: baseUrl, now: fixedNow });
      await assert.rejects(provider.lookupByNip(nip), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "RATE_LIMITED");
        assert.equal(error.retryAfterSeconds, 77_400);
        assert.doesNotMatch(error.message, /synthetic-private-provider-text/);
        return true;
      });
    },
  );
});

test("MF adapter enforces the response-size limit and aborts a timed-out local request", async () => {
  await withServer(
    (_request, response) => sendJson(response, 200, { result: { subject: null } }),
    async (baseUrl) => {
      const provider = new MfVatRegistryProvider({
        environment: "test",
        testBaseUrl: baseUrl,
        now: fixedNow,
        maxResponseBytes: 10,
      });
      await assert.rejects(provider.lookupByNip(nip), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "INVALID_RESPONSE");
        return true;
      });
    },
  );
  await withServer(
    (_request, response) => {
      setTimeout(() => sendJson(response, 200, { result: { subject: null } }), 100);
    },
    async (baseUrl) => {
      const provider = new MfVatRegistryProvider({
        environment: "test",
        testBaseUrl: baseUrl,
        now: fixedNow,
        timeoutMs: 15,
      });
      await assert.rejects(provider.lookupByNip(nip), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "TIMEOUT");
        return true;
      });
    },
  );
});

test("MF production configuration cannot redirect requests to a caller-supplied host", async () => {
  assert.throws(
    () =>
      new MfVatRegistryProvider({
        environment: "production",
        testBaseUrl: "http://127.0.0.1:3000/",
      }),
    /MF_VAT_TEST_URL_MUST_BE_LOOPBACK/,
  );
  assert.throws(
    () =>
      new MfVatRegistryProvider({
        environment: "test",
        testBaseUrl: "http://example.com/",
      }),
    /MF_VAT_TEST_URL_MUST_BE_LOOPBACK/,
  );
});
