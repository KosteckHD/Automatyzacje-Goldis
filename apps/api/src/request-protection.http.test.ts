import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Controller, Get, Module, Post } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { RequestProtectionGuard } from "./request-protection";
import { OriginOnly } from "./request-metadata";

const sessionSecret = "request-protection-http-synthetic-session-secret";
const csrfToken = "synthetic-csrf-token-for-request-protection-http-123456";
const originalNodeEnv = process.env.NODE_ENV;

function sessionCookie(): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 60_000,
    userId: "11111111-1111-4111-8111-111111111111",
    tenantId: "99999999-9999-4999-8999-999999999999",
    csrf: csrfToken,
  })).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `goldis_session=${payload}.${signature}; goldis_csrf=${csrfToken}`;
}

@Controller("guard-test")
class GuardTestController {
  @Get("read") read() { return { ok: true }; }
  @Post("login") login() { return { ok: true }; }
  @Post("mutate") mutate() { return { ok: true }; }
  @Post("logout") @OriginOnly() logout() { return { ok: true }; }
}

@Module({
  controllers: [GuardTestController],
  providers: [{ provide: APP_GUARD, useClass: RequestProtectionGuard }],
})
class RequestProtectionHttpTestModule {}

test("globalny guard wymaga Origin dla mutacji i CSRF dla cookie-sesji", async () => {
  const oldOrigin = process.env.PUBLIC_APP_ORIGIN;
  const oldSecret = process.env.SESSION_SECRET;
  process.env.PUBLIC_APP_ORIGIN = "https://goldis.example";
  process.env.SESSION_SECRET = sessionSecret;
  const app = await NestFactory.create(RequestProtectionHttpTestModule, { logger: false });
  try {
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const root = `http://127.0.0.1:${address.port}/api/guard-test`;

    assert.equal((await fetch(`${root}/read`)).status, 200);
    assert.equal((await fetch(`${root}/login`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${root}/login`, {
      method: "POST", headers: { origin: "https://attacker.example" },
    })).status, 403);
    assert.equal((await fetch(`${root}/login`, {
      method: "POST", headers: { origin: "https://goldis.example", "sec-fetch-site": "cross-site" },
    })).status, 403);
    assert.equal((await fetch(`${root}/login`, {
      method: "POST", headers: { origin: "https://goldis.example" },
    })).status, 201);

    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_ORIGIN = "http://localhost:3000";
    assert.equal((await fetch(`${root}/login`, {
      method: "POST", headers: { origin: "http://localhost:3000" },
    })).status, 403);
    process.env.PUBLIC_APP_ORIGIN = "https://goldis.example";
    process.env.NODE_ENV = originalNodeEnv;

    const cookie = sessionCookie();
    assert.equal((await fetch(`${root}/mutate`, {
      method: "POST", headers: { origin: "https://goldis.example", cookie },
    })).status, 403);
    assert.equal((await fetch(`${root}/mutate`, {
      method: "POST",
      headers: { origin: "https://goldis.example", cookie: cookie.replace(`goldis_csrf=${csrfToken}`, "goldis_csrf=wrong"), "x-csrf-token": csrfToken },
    })).status, 403);
    assert.equal((await fetch(`${root}/mutate`, {
      method: "POST", headers: { origin: "https://goldis.example", cookie, "x-csrf-token": "wrong" },
    })).status, 403);
    assert.equal((await fetch(`${root}/mutate`, {
      method: "POST",
      headers: { origin: "https://goldis.example", cookie, "x-csrf-token": csrfToken },
    })).status, 201);
    assert.equal((await fetch(`${root}/logout`, {
      method: "POST", headers: { origin: "https://goldis.example", cookie: "goldis_session=expired" },
    })).status, 201);
  } finally {
    await app.close();
    if (oldOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = oldOrigin;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = oldSecret;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
