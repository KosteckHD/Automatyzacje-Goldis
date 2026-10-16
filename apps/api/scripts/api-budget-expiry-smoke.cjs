"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const Redis = require("ioredis");

async function main() {
  const url = new URL(process.env.REDIS_URL || "");
  if (process.env.GOLDIS_TEST_REDIS_DISPOSABLE !== "1" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("LOCAL_TEST_REDIS_REQUIRED");
  const prefix = `goldis:budget-expiry-test:${randomUUID()}`;
  process.env.LOGIN_RATE_LIMIT_KEY_PREFIX = prefix;
  const { LoginRateLimiter } = require("../dist/features/auth");
  const limiter = new LoginRateLimiter();
  const redis = new Redis(process.env.REDIS_URL, { enableReadyCheck: false });
  let keys = [];
  try {
    assert.equal((await limiter.consumeApiRequest("203.0.113.55")).allowed, true);
    [, keys] = await redis.scan("0", "MATCH", `${prefix}:*`, "COUNT", 100);
    assert.equal(keys.length, 1);
    await redis.set(keys[0], "500");
    assert.equal(await redis.ttl(keys[0]), -1);
    const result = await limiter.consumeApiRequest("203.0.113.55");
    assert.equal(result.allowed, false, "repair must preserve the current rate limit");
    assert.ok(result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 60);
    assert.equal(await redis.get(keys[0]), "501", "repair must not clear the counter");
    assert.ok(await redis.ttl(keys[0]) > 0);
    console.log("API_BUDGET_EXPIRY_REPAIR_SMOKE_PASS");
  } finally {
    if (keys.length) await redis.del(...keys);
    await limiter.onModuleDestroy();
    redis.disconnect();
  }
}
main().catch(() => { console.error("API_BUDGET_EXPIRY_REPAIR_SMOKE_FAIL"); process.exitCode = 1; });
