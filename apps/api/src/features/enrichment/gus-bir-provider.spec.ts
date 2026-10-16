import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { GusBirRegistryProvider } from "./gus-bir-provider";
import { RegistryProviderError } from "./registry-provider";

const NIP_A = "1234563218";
const NIP_B = "0123456789";
const SESSION_A = "SYNTHETICSESSION0001";
const SESSION_B = "SYNTHETICSESSION0002";
const FIXED_NOW = () => new Date("2026-10-07T12:00:00.000Z");

type SeenRequest = { headers: IncomingMessage["headers"]; body: string; url: string };
type RequestHandler = (request: SeenRequest, response: ServerResponse) => void | Promise<void>;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function withServer(handler: RequestHandler, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((request, response) => {
    void readBody(request)
      .then((body) => handler({ headers: request.headers, body, url: request.url ?? "" }, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/wsBIR/UslugaBIRzewnPubl.svc`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function soapResponse(inner: string): string {
  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${inner}</s:Body></s:Envelope>`;
}

function loginResponse(sessionId = SESSION_A): string {
  return soapResponse(
    `<ZalogujResponse xmlns="http://CIS/BIR/PUBL/2014/07"><ZalogujResult>${sessionId}</ZalogujResult></ZalogujResponse>`,
  );
}

function searchResponse(resultXml: string): string {
  return soapResponse(
    `<DaneSzukajPodmiotyResponse xmlns="http://CIS/BIR/PUBL/2014/07"><DaneSzukajPodmiotyResult>${escapeXml(resultXml)}</DaneSzukajPodmiotyResult></DaneSzukajPodmiotyResponse>`,
  );
}

function searchFault(message: string): string {
  return soapResponse(
    `<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text>${escapeXml(message)}</s:Text></s:Reason></s:Fault>`,
  );
}

function sendXml(
  response: ServerResponse,
  body: string,
  status = 200,
  contentType = "application/soap+xml; charset=utf-8",
): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function nipFilter(body: string): string[] {
  const match =
    body.match(/<(?:\w+:)?Nipy>([^<]+)<\/(?:\w+:)?Nipy>/) ?? body.match(/<(?:\w+:)?Nip>([^<]+)<\/(?:\w+:)?Nip>/);
  return match ? match[1].split(",") : [];
}

function row(nip: string, regon: string, name: string, extra = ""): string {
  return `<dane><Nip>${nip}</Nip><Nazwa>${escapeXml(name)}</Nazwa><Regon>${regon}</Regon><Typ>P</Typ>${extra}</dane>`;
}

function provider(
  baseUrl: string,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {},
): GusBirRegistryProvider {
  return new GusBirRegistryProvider({
    environment: "test",
    testBaseUrl: baseUrl,
    userKey: "synthetic&<key>",
    now: FIXED_NOW,
    ...options,
  });
}

test("GUS BIR logs in once, sends the sid header and returns a minimal NIP → REGON result", async () => {
  const seen: SeenRequest[] = [];
  await withServer(
    (request, response) => {
      seen.push(request);
      if (request.body.includes("<bir:Zaloguj>")) return sendXml(response, loginResponse());
      return sendXml(
        response,
        searchResponse(
          `<root>${row(NIP_A, "001234567", "FIKCYJNY PODMIOT", "<Pesel>11111111111</Pesel><Adres>TAJNA DANA</Adres>")}</root>`,
        ),
      );
    },
    async (baseUrl) => {
      const result = await provider(baseUrl).lookupByNip(NIP_A);
      assert.deepEqual(result, {
        providerName: "gus-bir",
        providerVersion: "1.2.0",
        dataVersion: null,
        fetchedAt: FIXED_NOW(),
        candidates: [{ nip: NIP_A, name: "FIKCYJNY PODMIOT", regon: "001234567", unitType: "P" }],
      });
    },
  );
  assert.equal(seen.length, 2);
  assert.match(seen[0].body, /synthetic&amp;&lt;key&gt;/);
  assert.match(seen[0].body, /IUslugaBIRzewnPubl\/Zaloguj/);
  assert.match(seen[1].body, /IUslugaBIRzewnPubl\/DaneSzukajPodmioty/);
  assert.match(seen[1].body, new RegExp(`<dc:Nip>${NIP_A}</dc:Nip>`));
  assert.equal(seen[1].headers.sid, SESSION_A);
  assert.equal(seen[0].headers.sid, undefined);
  assert.equal(JSON.stringify(seen[1]).includes("11111111111"), false);
});

test("GUS batch accepts at most 20 NIPs and maps shuffled rows by NIP while preserving distinct candidates", async () => {
  const nips = [NIP_A, NIP_B];
  let searchCount = 0;
  let capturedFilter: string[] = [];
  await withServer(
    (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) return sendXml(response, loginResponse());
      searchCount += 1;
      capturedFilter = nipFilter(request.body);
      return sendXml(
        response,
        searchResponse(
          `<root>${row(NIP_B, "987654321", "DRUGI FIKCYJNY PODMIOT")}${row(NIP_A, "001234567", "FIKCYJNY PODMIOT")}${row(NIP_A, "00123456789012", "FIKCYJNY PODMIOT", "<SilosID>6</SilosID>")}</root>`,
        ),
      );
    },
    async (baseUrl) => {
      const outcomes = await provider(baseUrl).lookupManyByNip(nips);
      assert.deepEqual(capturedFilter, nips);
      assert.equal(outcomes.size, 2);
      const a = outcomes.get(NIP_A);
      assert.equal(a?.kind, "result");
      if (a?.kind === "result") {
        assert.deepEqual(a.result.candidates, [
          { nip: NIP_A, name: "FIKCYJNY PODMIOT", regon: "001234567", unitType: "P" },
          {
            nip: NIP_A,
            name: "FIKCYJNY PODMIOT",
            regon: "00123456789012",
            unitType: "P",
            isLocalUnit: true,
            parentRegon: "001234567",
          },
        ]);
      }
      const b = outcomes.get(NIP_B);
      assert.equal(b?.kind, "result");
      if (b?.kind === "result")
        assert.deepEqual(b.result.candidates, [
          { nip: NIP_B, name: "DRUGI FIKCYJNY PODMIOT", regon: "987654321", unitType: "P" },
        ]);
    },
  );
  assert.equal(searchCount, 1);

  const nips21 = Array.from({ length: 21 }, (_, index) => {
    const base = String(index).padStart(9, "0");
    const check =
      [6, 5, 7, 2, 3, 4, 5, 6, 7].reduce((sum, weight, digit) => sum + weight * Number(base[digit]), 0) % 11;
    return `${base}${check === 10 ? (check + 1) % 10 : check}`;
  });
  await withServer(
    (_request, response) => {
      searchCount += 1;
      sendXml(response, searchResponse("<root/>"));
    },
    async (baseUrl) => {
      await assert.rejects(provider(baseUrl).lookupManyByNip(nips21), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "INVALID_RESPONSE");
        return true;
      });
    },
  );
  assert.equal(searchCount, 1, "oversized batch rejected before transport");
});

test("GUS BIR represents no registry rows and error code 4 as empty outcomes, including a subject without REGON", async () => {
  const responses = [
    "<root><ErrorCode>4</ErrorCode><ErrorMessage>brak danych</ErrorMessage></root>",
    `<root><dane><Nip>${NIP_A}</Nip><Nazwa>BEZ REGON</Nazwa><Typ>P</Typ></dane></root>`,
  ];
  let index = 0;
  await withServer(
    (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) return sendXml(response, loginResponse());
      return sendXml(response, searchResponse(responses[index++]));
    },
    async (baseUrl) => {
      const subject = await provider(baseUrl).lookupByNip(NIP_A);
      assert.deepEqual(subject.candidates, []);
      const noRegon = await provider(baseUrl).lookupByNip(NIP_A);
      assert.deepEqual(noRegon.candidates, [{ nip: NIP_A, name: "BEZ REGON", unitType: "P" }]);
    },
  );
});

test("GUS BIR shares one in-process login across concurrent lookups but never shares it across provider instances", async () => {
  let logins = 0;
  await withServer(
    async (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) {
        logins += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return sendXml(response, loginResponse());
      }
      return sendXml(response, searchResponse("<root/>"));
    },
    async (baseUrl) => {
      const first = provider(baseUrl);
      await Promise.all([first.lookupByNip(NIP_A), first.lookupByNip(NIP_B)]);
      assert.equal(logins, 1);
      await provider(baseUrl).lookupByNip(NIP_A);
      assert.equal(logins, 2);
    },
  );
});

test("GUS BIR refreshes an expired session only once and retries the same search", async () => {
  let logins = 0;
  let searches = 0;
  await withServer(
    (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) {
        logins += 1;
        return sendXml(response, loginResponse(logins === 1 ? SESSION_A : SESSION_B));
      }
      searches += 1;
      if (searches === 1) return sendXml(response, searchFault("Nieprawidłowy identyfikator sesji"), 500);
      assert.equal(request.headers.sid, SESSION_B);
      return sendXml(response, searchResponse(`<root>${row(NIP_A, "123456789", "FIKCYJNY PODMIOT")}</root>`));
    },
    async (baseUrl) => {
      const result = await provider(baseUrl).lookupByNip(NIP_A);
      assert.equal(result.candidates.length, 1);
    },
  );
  assert.equal(logins, 2);
  assert.equal(searches, 2);
});

test("GUS BIR fails safely for repeated session rejection without entering a retry loop", async () => {
  let logins = 0;
  let searches = 0;
  await withServer(
    (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) {
        logins += 1;
        return sendXml(response, loginResponse(logins === 1 ? SESSION_A : SESSION_B));
      }
      searches += 1;
      return sendXml(response, searchFault("Invalid session id"), 500);
    },
    async (baseUrl) => {
      await assert.rejects(provider(baseUrl).lookupByNip(NIP_A), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "UNAVAILABLE");
        assert.doesNotMatch(error.message, /session id/i);
        return true;
      });
    },
  );
  assert.equal(logins, 2);
  assert.equal(searches, 2);
});

test("GUS BIR rejects DTD/XXE, malformed XML, unrelated identities and invalid REGON", async () => {
  const badPayloads = [
    `<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]><root>${row(NIP_A, "123456789", "&xxe;")}</root>`,
    `<root><dane><Nip>${NIP_B}</Nip><Nazwa>OBCA FIRMA</Nazwa><Regon>123456789</Regon></dane></root>`,
    `<root>${row(NIP_A, "123", "FIRMA")}</root>`,
    `<root><dane><Nip>${NIP_A}</Nip><Nazwa>FIRMA</Nazwa></root>`,
    `<root><dane><Nip>${NIP_A}</Nip><Nazwa>FIRMA</Nazwa><Regon>123456789</Regon></dane>`,
  ];
  for (const payload of badPayloads) {
    await withServer(
      (request, response) => {
        if (request.body.includes("<bir:Zaloguj>")) return sendXml(response, loginResponse());
        return sendXml(response, searchResponse(payload));
      },
      async (baseUrl) => {
        await assert.rejects(provider(baseUrl).lookupByNip(NIP_A), (error: unknown) => {
          assert.ok(error instanceof RegistryProviderError);
          assert.equal(error.code, "INVALID_RESPONSE");
          assert.doesNotMatch(error.message, /file:\/\/|Windows|OBCA FIRMA/);
          return true;
        });
      },
    );
  }
});

test("GUS BIR bounds response size, content type and timeout/abort handling", async () => {
  await withServer(
    (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) return sendXml(response, loginResponse());
      return sendXml(response, searchResponse(`<root>${row(NIP_A, "123456789", "X".repeat(900))}</root>`));
    },
    async (baseUrl) => {
      await assert.rejects(provider(baseUrl, { maxResponseBytes: 700 }).lookupByNip(NIP_A), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "INVALID_RESPONSE");
        return true;
      });
    },
  );

  await withServer(
    (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) return sendXml(response, loginResponse());
      return sendXml(response, searchResponse("<root/>"), 200, "text/html");
    },
    async (baseUrl) => {
      await assert.rejects(provider(baseUrl).lookupByNip(NIP_A), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "INVALID_RESPONSE");
        return true;
      });
    },
  );

  await withServer(
    async (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) return sendXml(response, loginResponse());
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!response.destroyed) sendXml(response, searchResponse("<root/>"));
    },
    async (baseUrl) => {
      await assert.rejects(provider(baseUrl, { timeoutMs: 100 }).lookupByNip(NIP_A), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "TIMEOUT");
        return true;
      });

      const controller = new AbortController();
      const cancelled = provider(baseUrl, { timeoutMs: 500 }).lookupByNip(NIP_A, controller.signal);
      setTimeout(() => controller.abort(), 40);
      await assert.rejects(cancelled, (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "TIMEOUT");
        return true;
      });
    },
  );
});

test("GUS BIR rate limits are typed, and redirects cannot move a request off the configured endpoint", async () => {
  await withServer(
    (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) return sendXml(response, loginResponse());
      return sendXml(response, searchResponse("<root/>"), 429);
    },
    async (baseUrl) => {
      await assert.rejects(provider(baseUrl).lookupByNip(NIP_A), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "RATE_LIMITED");
        assert.equal(error.retryAfterSeconds, 300);
        return true;
      });
    },
  );

  await withServer(
    (request, response) => {
      if (request.body.includes("<bir:Zaloguj>")) return sendXml(response, loginResponse());
      response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end();
    },
    async (baseUrl) => {
      await assert.rejects(provider(baseUrl).lookupByNip(NIP_A), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.ok(["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.code));
        return true;
      });
    },
  );
});

test("GUS BIR config requires a key and only permits a loopback fixture override in test mode", () => {
  assert.throws(
    () => new GusBirRegistryProvider({ environment: "production", userKey: "" }),
    /GUS_BIR_USER_KEY_REQUIRED/,
  );
  assert.throws(
    () =>
      new GusBirRegistryProvider({ environment: "production", userKey: "test", testBaseUrl: "http://127.0.0.1:3000/" }),
    /GUS_BIR_TEST_URL_MUST_BE_LOOPBACK/,
  );
  assert.throws(
    () => new GusBirRegistryProvider({ environment: "test", userKey: "test", testBaseUrl: "http://example.com/" }),
    /GUS_BIR_TEST_URL_MUST_BE_LOOPBACK/,
  );
  assert.equal(
    new GusBirRegistryProvider({ environment: "production", userKey: "configured" }).cacheNamespace,
    "gus-bir",
  );
});

test("GUS BIR does not start a login when the caller has already cancelled", async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests += 1;
      sendXml(response, loginResponse());
    },
    async (baseUrl) => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(provider(baseUrl).lookupByNip(NIP_A, controller.signal), (error: unknown) => {
        assert.ok(error instanceof RegistryProviderError);
        assert.equal(error.code, "TIMEOUT");
        return true;
      });
    },
  );
  assert.equal(requests, 0);
});
