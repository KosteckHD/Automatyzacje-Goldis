import "reflect-metadata";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Body, Controller, Get, Module, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { apiRequestBudgetMiddleware, createHttpApplication, trustedProxyAddresses } from "./http-bootstrap";

@Controller("auth")
class LoginBodyProbe {
  @Post("login")
  login(@Body() body: { username?: string; password?: string }) {
    return { username: body?.username, password: body?.password };
  }
}

@Controller("internal/worker-runs")
class WorkerBodyProbe {
  @Post(":id/result")
  result(@Body() body: { snapshot?: string }) { return { length: body?.snapshot?.length ?? 0 }; }
}

@Controller("internal/worker-runs-extra")
class WorkerPrefixProbe {
  @Post("result")
  result(@Body() body: { snapshot?: string }) { return { length: body?.snapshot?.length ?? 0 }; }
}

@Controller("probe")
class RequestIpProbe {
  @Get("ip")
  ip(@Req() request: Request) { return { ip: request.ip }; }
}

@Module({ controllers: [LoginBodyProbe, WorkerBodyProbe, WorkerPrefixProbe, RequestIpProbe] })
class HttpBootstrapProbeModule {}

test("production HTTP startup parses login JSON and limits large bodies to worker results", async () => {
  const app = await createHttpApplication(HttpBootstrapProbeModule, { logger: false });
  try {
    await app.listen(0, "127.0.0.1");
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const root = `http://127.0.0.1:${port}/api`;
    const credentials = { username: "synthetic-http-probe", password: "synthetic-password-value" };
    const login = await fetch(`${root}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials),
    });
    assert.equal(login.status, 201);
    assert.equal(login.headers.get("cache-control"), "private, no-store");
    assert.equal(login.headers.get("x-content-type-options"), "nosniff");
    assert.equal(login.headers.get("x-frame-options"), "DENY");
    assert.deepEqual(await login.json(), credentials);

    const largeBody = JSON.stringify({ snapshot: "x".repeat(200_000) });
    const result = await fetch(`${root}/internal/worker-runs/test/result`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: largeBody,
    });
    assert.equal(result.status, 201);
    assert.deepEqual(await result.json(), { length: 200_000 });
    for (const endpoint of ["auth/login", "internal/worker-runs-extra/result"]) {
      const oversized = await fetch(`${root}/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: largeBody,
      });
      assert.equal(oversized.status, 413, endpoint);
    }
    const oversizedWorker = await fetch(`${root}/internal/worker-runs/test/result`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot: "x".repeat(5 * 1024 * 1024 + 1) }),
    });
    assert.equal(oversizedWorker.status, 413);
    const malformed = await fetch(`${root}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken",
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get("cache-control"), "private, no-store");
  } finally { await app.close(); }
});

test("proxy trust uses explicit addresses and ignores forwarding headers from untrusted clients", async () => {
  const previousTrustProxyIps = process.env.TRUST_PROXY_IPS;
  let app: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  try {
    delete process.env.TRUST_PROXY_IPS;
    assert.deepEqual(trustedProxyAddresses(undefined), []);
    app = await createHttpApplication(HttpBootstrapProbeModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/probe/ip`, {
      headers: { "X-Forwarded-For": "203.0.113.77" },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { ip: string };
    assert.notEqual(payload.ip, "203.0.113.77", "untrusted X-Forwarded-For must not control req.ip");
    assert.match(payload.ip, /127\.0\.0\.1|::1/);
    await app.close();
    app = undefined;

    const configuredApp = await createHttpApplication(HttpBootstrapProbeModule, { logger: false }, undefined, {
      trustProxyIps: "127.0.0.1",
    });
    try {
      await configuredApp.listen(0, "127.0.0.1");
      const configuredPort = (configuredApp.getHttpServer().address() as AddressInfo).port;
      const configuredResponse = await fetch(`http://127.0.0.1:${configuredPort}/api/probe/ip`, {
        headers: { "X-Forwarded-For": "203.0.113.77" },
      });
      assert.equal(configuredResponse.status, 200);
      assert.equal((await configuredResponse.json() as { ip: string }).ip, "203.0.113.77",
        "API runtime config is applied without reading a second environment snapshot");
    } finally { await configuredApp.close(); }

    process.env.TRUST_PROXY_IPS = "198.51.100.7, ::ffff:198.51.100.7";
    assert.deepEqual(trustedProxyAddresses(process.env.TRUST_PROXY_IPS), ["198.51.100.7"]);
    const proxiedApp = await createHttpApplication(HttpBootstrapProbeModule, { logger: false });
    try {
      await proxiedApp.listen(0, "127.0.0.1");
      const proxiedPort = (proxiedApp.getHttpServer().address() as AddressInfo).port;
      const proxiedResponse = await fetch(`http://127.0.0.1:${proxiedPort}/api/probe/ip`, {
        headers: { "X-Forwarded-For": "203.0.113.77" },
      });
      assert.equal(proxiedResponse.status, 200);
      const proxiedPayload = await proxiedResponse.json() as { ip: string };
      assert.notEqual(proxiedPayload.ip, "203.0.113.77", "direct clients cannot spoof a trusted proxy address");
    } finally { await proxiedApp.close(); }

    for (const invalid of ["-1", "198.51.100.1/24", "loopback", "01"]) {
      assert.throws(() => trustedProxyAddresses(invalid), /TRUST_PROXY_IPS_INVALID/);
    }
  } finally {
    await app?.close();
    if (previousTrustProxyIps === undefined) delete process.env.TRUST_PROXY_IPS;
    else process.env.TRUST_PROXY_IPS = previousTrustProxyIps;
  }
});

test("API IP budget rejects before body parsing and returns bounded retry metadata", async () => {
  let calls = 0;
  const app = await createHttpApplication(HttpBootstrapProbeModule, { logger: false }, (application) => {
    application.use("/api", apiRequestBudgetMiddleware(async (ip) => {
      calls += 1;
      assert.match(ip, /127\.0\.0\.1|::1/);
      return { allowed: false, retryAfterSeconds: 37 };
    }));
  });
  try {
    await app.listen(0, "127.0.0.1");
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "x", password: "x".repeat(200_000) }),
    });
    assert.equal(response.status, 429, "budget rejects before the 100kb JSON parser");
    assert.equal(response.headers.get("retry-after"), "37");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(calls, 1);
  } finally { await app.close(); }
});
