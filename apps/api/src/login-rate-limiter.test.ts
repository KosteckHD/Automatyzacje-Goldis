import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loginIpAttemptLimit,
  loginPairAttemptLimit,
  loginRateLimitWindowSeconds,
  LoginRateLimiter,
} from "./login-rate-limiter";

class SyntheticRedis {
  readonly counters = new Map<string, number>();
  readonly keysSeen: string[] = [];
  fail = false;

  async eval(_script: string, keyCount: number, ...args: (string | number)[]): Promise<unknown> {
    if (this.fail) throw new Error("synthetic redis unavailable");
    assert.equal(keyCount, 2);
    const [pairKey, ipKey, pairLimitRaw, ipLimitRaw, windowRaw] = args.map(String);
    this.keysSeen.push(pairKey, ipKey);
    const pairCount = this.counters.get(pairKey) ?? 0;
    const ipCount = this.counters.get(ipKey) ?? 0;
    const pairLimit = Number(pairLimitRaw);
    const ipLimit = Number(ipLimitRaw);
    const window = Number(windowRaw);
    assert.equal(pairLimit, loginPairAttemptLimit);
    assert.equal(ipLimit, loginIpAttemptLimit);
    assert.equal(window, loginRateLimitWindowSeconds);
    if (pairCount >= pairLimit || ipCount >= ipLimit) return [0, 73];
    this.counters.set(pairKey, pairCount + 1);
    this.counters.set(ipKey, ipCount + 1);
    return [1, 0];
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.counters.delete(key)) deleted += 1;
    return deleted;
  }

  async quit(): Promise<"OK"> { return "OK"; }
}

test("limiter ogranicza parę login/IP, resetuje sukces i nie umieszcza danych jawnych w kluczu", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "login-rate-limit-synthetic-session-secret";
  const redis = new SyntheticRedis();
  const limiter = new LoginRateLimiter(redis as never);
  try {
    for (let attempt = 0; attempt < loginPairAttemptLimit; attempt += 1) {
      assert.deepEqual(await limiter.consumeAttempt("  Synthetic.User ", "203.0.113.18"), { allowed: true, retryAfterSeconds: 0 });
    }
    assert.deepEqual(await limiter.consumeAttempt("synthetic.user", "203.0.113.18"), { allowed: false, retryAfterSeconds: 73 });
    assert.ok(redis.keysSeen.every((key) => !key.includes("Synthetic") && !key.includes("203.0.113.18")));
    assert.ok(redis.keysSeen.every((key) => /^[\w:-]+:[a-f0-9]{64}$/.test(key)));

    await limiter.clearPair("SYNTHETIC.USER", "203.0.113.18");
    assert.deepEqual(await limiter.consumeAttempt("synthetic.user", "203.0.113.18"), { allowed: true, retryAfterSeconds: 0 });
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("awaria Redis blokuje logowanie fail-closed", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "login-rate-limit-synthetic-session-secret";
  const redis = new SyntheticRedis();
  redis.fail = true;
  try {
    await assert.rejects(new LoginRateLimiter(redis as never).consumeAttempt("synthetic.user", "203.0.113.19"),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 503);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("limit adresu IP obejmuje wiele loginów, a nie tylko jedną parę", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "login-rate-limit-synthetic-session-secret";
  const limiter = new LoginRateLimiter(new SyntheticRedis() as never);
  try {
    for (let attempt = 0; attempt < loginIpAttemptLimit; attempt += 1) {
      assert.equal((await limiter.consumeAttempt(`synthetic-${attempt}`, "203.0.113.20")).allowed, true);
    }
    const blocked = await limiter.consumeAttempt("synthetic-last", "203.0.113.20");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 73);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});
