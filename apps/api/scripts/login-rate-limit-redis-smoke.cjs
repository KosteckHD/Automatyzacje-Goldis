const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required; use an isolated test Redis");

  const prefix = `goldis:auth:login:smoke:${process.pid}:${randomUUID()}`;
  process.env.SESSION_SECRET = "synthetic-login-rate-limit-redis-smoke-secret";
  process.env.LOGIN_RATE_LIMIT_KEY_PREFIX = prefix;
  const RedisModule = require("ioredis");
  const Redis = RedisModule.default || RedisModule;
  const { LoginRateLimiter } = require("../dist/login-rate-limiter.js");
  const limiter = new LoginRateLimiter();
  const cleanup = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await limiter.consumeAttempt("synthetic.user", "203.0.113.77")).allowed, true);
    }
    const blockedPair = await limiter.consumeAttempt("SYNTHETIC.USER", "203.0.113.77");
    assert.equal(blockedPair.allowed, false);
    assert.ok(blockedPair.retryAfterSeconds > 0);

    await limiter.clearPair("synthetic.user", "203.0.113.77");
    assert.equal((await limiter.consumeAttempt("synthetic.user", "203.0.113.77")).allowed, true);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      assert.equal((await limiter.consumeAttempt(`synthetic-${attempt}`, "203.0.113.78")).allowed, true);
    }
    const blockedIp = await limiter.consumeAttempt("synthetic-last", "203.0.113.78");
    assert.equal(blockedIp.allowed, false);
    assert.ok(blockedIp.retryAfterSeconds > 0);
    process.stdout.write("LOGIN_RATE_LIMIT_REDIS_SMOKE_PASS pairLimit=5 ipLimit=60 retryAfter=true\n");
  } finally {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await cleanup.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length) await cleanup.del(...keys);
    } while (cursor !== "0");
    await Promise.all([limiter.onModuleDestroy(), cleanup.quit()]);
  }
}

main().catch((error) => {
  process.stderr.write(`LOGIN_RATE_LIMIT_REDIS_SMOKE_FAIL ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 1;
});
