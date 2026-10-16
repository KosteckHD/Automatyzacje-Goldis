import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apiIpRequestLimit,
  apiRequestWindowSeconds,
  LoginRateLimiter,
  loginAccountAttemptLimit,
  loginIpAttemptLimit,
  loginPairAttemptLimit,
  loginRateLimitWindowSeconds,
  recoveryAddressLimit,
  recoveryIpLimit,
} from "./login-rate-limiter";

class SyntheticRedis {
  readonly counters = new Map<string, number>();
  readonly values = new Map<string, string>();
  readonly keysSeen: string[] = [];
  disconnectCount = 0;
  fail = false;

  async eval(_script: string, keyCount: number, ...args: (string | number)[]): Promise<unknown> {
    if (this.fail) throw new Error("synthetic redis unavailable");
    const values = args.map(String);
    if (_script.includes("goldis-recovery-request")) {
      assert.equal(keyCount, 3);
      const [addressKey, cooldownKey, ipKey, ipLimit, addressLimit] = values;
      this.keysSeen.push(addressKey, cooldownKey, ipKey);
      const addressCount = this.counters.get(addressKey) ?? 0;
      const ipCount = this.counters.get(ipKey) ?? 0;
      if (ipCount >= Number(ipLimit)) return [0, 900, "ip"];
      if (this.values.has(cooldownKey)) return [2, 60, "account"];
      if (addressCount >= Number(addressLimit)) return [2, 900, "account"];
      this.counters.set(addressKey, addressCount + 1);
      this.counters.set(ipKey, ipCount + 1);
      this.values.set(cooldownKey, "1");
      assert.equal(Number(ipLimit), recoveryIpLimit);
      assert.equal(Number(addressLimit), recoveryAddressLimit);
      return [1, 0, "allowed"];
    }
    if (_script.includes("goldis-recovery-token-attempt")) {
      assert.equal(keyCount, 1);
      const [key, limitRaw] = values;
      const count = (this.counters.get(key) ?? 0) + 1;
      this.counters.set(key, count);
      this.keysSeen.push(key);
      return count > Number(limitRaw) ? [0, 900] : [1, 0];
    }
    if (_script.includes("goldis-auth-mail-send-budget")) {
      assert.equal(keyCount, 1);
      const [key, limitRaw] = values;
      const count = (this.counters.get(key) ?? 0) + 1;
      this.counters.set(key, count);
      this.keysSeen.push(key);
      return count > Number(limitRaw) ? [0, 60] : [1, 0];
    }
    if (keyCount === 1) {
      const [key, limitRaw, windowRaw] = values;
      if (key.includes(":failed-login-audit-sample")) {
        const count = (this.counters.get(key) ?? 0) + 1;
        this.counters.set(key, count);
        assert.equal(Number(limitRaw), 5);
        assert.equal(Number(windowRaw), loginRateLimitWindowSeconds);
        return count <= Number(limitRaw) ? 1 : 0;
      }
      this.keysSeen.push(key);
      assert.equal(Number(limitRaw), apiIpRequestLimit);
      assert.equal(Number(windowRaw), apiRequestWindowSeconds);
      const count = (this.counters.get(key) ?? 0) + 1;
      this.counters.set(key, count);
      return count > apiIpRequestLimit ? [0, 42] : [1, 0];
    }
    if (keyCount === 7) {
      const [
        pairKey,
        accountKey,
        ipKey,
        pairGenerationKey,
        accountGenerationKey,
        ,
        backoffKey,
        pairLimitRaw,
        accountLimitRaw,
        ipLimitRaw,
        windowRaw,
        generation,
      ] = values;
      this.keysSeen.push(pairKey, accountKey, ipKey);
      const pairCount = this.counters.get(pairKey) ?? 0;
      const accountCount = this.counters.get(accountKey) ?? 0;
      const ipCount = this.counters.get(ipKey) ?? 0;
      assert.equal(Number(pairLimitRaw), loginPairAttemptLimit);
      assert.equal(Number(accountLimitRaw), loginAccountAttemptLimit);
      assert.equal(Number(ipLimitRaw), loginIpAttemptLimit);
      assert.equal(Number(windowRaw), loginRateLimitWindowSeconds);
      if (this.values.has(backoffKey)) return [0, 1, "", ""];
      if (
        pairCount >= loginPairAttemptLimit ||
        accountCount >= loginAccountAttemptLimit ||
        ipCount >= loginIpAttemptLimit
      )
        return [0, 73, "", ""];
      this.counters.set(pairKey, pairCount + 1);
      this.counters.set(accountKey, accountCount + 1);
      this.counters.set(ipKey, ipCount + 1);
      this.values.set(pairGenerationKey, generation);
      this.values.set(accountGenerationKey, generation);
      return [1, 0, generation, generation];
    }
    if (keyCount === 6 && values[0].includes(":reauth-user:")) {
      if (_script.includes("local user_count")) {
        const [
          userKey,
          sessionKey,
          ipKey,
          userGenerationKey,
          sessionGenerationKey,
          backoffKey,
          userLimitRaw,
          sessionLimitRaw,
          ipLimitRaw,
          windowRaw,
          generation,
        ] = values;
        const userCount = this.counters.get(userKey) ?? 0;
        const sessionCount = this.counters.get(sessionKey) ?? 0;
        const ipCount = this.counters.get(ipKey) ?? 0;
        assert.equal(Number(userLimitRaw), 5);
        assert.equal(Number(sessionLimitRaw), 5);
        assert.equal(Number(ipLimitRaw), 30);
        assert.equal(Number(windowRaw), loginRateLimitWindowSeconds);
        if (this.values.has(backoffKey)) return [0, 1, ""];
        if (userCount >= 5 || sessionCount >= 5 || ipCount >= 30) return [0, 73, ""];
        this.counters.set(userKey, userCount + 1);
        this.counters.set(sessionKey, sessionCount + 1);
        this.counters.set(ipKey, ipCount + 1);
        this.values.set(userGenerationKey, generation);
        this.values.set(sessionGenerationKey, generation);
        return [1, 0, generation];
      }
      const [userKey, sessionKey, userGenerationKey, sessionGenerationKey, failureKey, backoffKey, generation] = values;
      if (this.values.get(userGenerationKey) === generation) {
        this.counters.delete(userKey);
        this.values.delete(userGenerationKey);
        this.counters.delete(failureKey);
        this.values.delete(backoffKey);
      }
      if (this.values.get(sessionGenerationKey) === generation) {
        this.counters.delete(sessionKey);
        this.values.delete(sessionGenerationKey);
      }
      return 1;
    }
    if (keyCount === 6) {
      const [
        pairKey,
        accountKey,
        pairGenerationKey,
        accountGenerationKey,
        failureKey,
        backoffKey,
        pairGeneration,
        accountGeneration,
      ] = values;
      if (this.values.get(pairGenerationKey) === pairGeneration) {
        this.counters.delete(pairKey);
        this.values.delete(pairGenerationKey);
      }
      if (this.values.get(accountGenerationKey) === accountGeneration) {
        this.counters.delete(accountKey);
        this.values.delete(accountGenerationKey);
        this.counters.delete(failureKey);
        this.values.delete(backoffKey);
      }
      return 1;
    }
    assert.equal(keyCount, 3);
    const [generationKey, failureKey, backoffKey] = values;
    if (!this.values.has(generationKey)) return 0;
    const failures = (this.counters.get(failureKey) ?? 0) + 1;
    this.counters.set(failureKey, failures);
    const delay = Math.min(30, 2 ** Math.min(5, failures - 1));
    this.values.set(backoffKey, String(delay));
    return delay;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.counters.delete(key)) deleted += 1;
    return deleted;
  }
  async quit(): Promise<"OK"> {
    return "OK";
  }
  disconnect(): void {
    this.disconnectCount += 1;
  }
}

function withSecret<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.LOGIN_RATE_LIMIT_SECRET;
  process.env.LOGIN_RATE_LIMIT_SECRET = "login-rate-limit-synthetic-dedicated-secret";
  return run().finally(() => {
    if (previous === undefined) delete process.env.LOGIN_RATE_LIMIT_SECRET;
    else process.env.LOGIN_RATE_LIMIT_SECRET = previous;
  });
}

test("limiter closes its Redis socket after graceful or failed QUIT", () =>
  withSecret(async () => {
    const gracefulRedis = new SyntheticRedis();
    await new LoginRateLimiter(gracefulRedis as never).onModuleDestroy();
    assert.equal(gracefulRedis.disconnectCount, 1);

    const unavailableRedis = new SyntheticRedis();
    unavailableRedis.quit = async () => {
      throw new Error("REDIS_UNAVAILABLE");
    };
    await new LoginRateLimiter(unavailableRedis as never).onModuleDestroy();
    assert.equal(unavailableRedis.disconnectCount, 1);
  }));

test("limiter limits login/IP, clears only the successful generation, and hashes identifiers", () =>
  withSecret(async () => {
    const redis = new SyntheticRedis();
    const limiter = new LoginRateLimiter(redis as never);
    let lastAllowed = null as Awaited<ReturnType<LoginRateLimiter["consumeAttempt"]>> | null;
    for (let attempt = 0; attempt < loginPairAttemptLimit; attempt += 1) {
      lastAllowed = await limiter.consumeAttempt("  Synthetic.User ", "203.0.113.18");
      assert.equal(lastAllowed.allowed, true);
    }
    const denied = await limiter.consumeAttempt("synthetic.user", "203.0.113.18");
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSeconds, 73);
    assert.ok(redis.keysSeen.every((key) => !key.includes("Synthetic") && !key.includes("203.0.113.18")));
    assert.ok(redis.keysSeen.every((key) => /^[\w:{}-]+:[a-f0-9]{64}$/.test(key)));

    assert.ok(lastAllowed);
    await limiter.clearPair("SYNTHETIC.USER", "203.0.113.18", lastAllowed);
    assert.equal((await limiter.consumeAttempt("synthetic.user", "203.0.113.18")).allowed, true);
  }));

test("account limits span IPs and IPv6 clients share a /64 network key", () =>
  withSecret(async () => {
    const redis = new SyntheticRedis();
    const limiter = new LoginRateLimiter(redis as never);
    let lastAllowed = null as Awaited<ReturnType<LoginRateLimiter["consumeAttempt"]>> | null;
    for (let attempt = 0; attempt < loginAccountAttemptLimit; attempt += 1) {
      lastAllowed = await limiter.consumeAttempt("synthetic.account", `203.0.113.${attempt + 1}`);
      assert.equal(lastAllowed.allowed, true);
    }
    assert.equal((await limiter.consumeAttempt("synthetic.account", "198.51.100.10")).allowed, false);
    assert.ok(lastAllowed);
    await limiter.clearPair("synthetic.account", "203.0.113.10", lastAllowed);
    assert.equal((await limiter.consumeAttempt("synthetic.account", "198.51.100.10")).allowed, true);
    await limiter.consumeAttempt("synthetic.v6.one", "2001:db8:1:2::1");
    await limiter.consumeAttempt("synthetic.v6.two", "2001:db8:1:2::2");
    assert.equal(redis.keysSeen.at(-1), redis.keysSeen.at(-4), "addresses in one IPv6 /64 share the network budget");
  }));

test("failure backoff is shared by account and a stale success cannot clear newer attempts", () =>
  withSecret(async () => {
    const redis = new SyntheticRedis();
    const limiter = new LoginRateLimiter(redis as never);
    const first = await limiter.consumeAttempt("synthetic.account", "203.0.113.21");
    await limiter.recordFailure("synthetic.account", first);
    const blocked = await limiter.consumeAttempt("synthetic.account", "198.51.100.21");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 1);

    const secondRedis = new SyntheticRedis();
    const secondLimiter = new LoginRateLimiter(secondRedis as never);
    const earlier = await secondLimiter.consumeAttempt("synthetic.race", "203.0.113.22");
    const latest = await secondLimiter.consumeAttempt("synthetic.race", "203.0.113.22");
    await secondLimiter.clearPair("synthetic.race", "203.0.113.22", earlier);
    assert.equal(
      (await secondLimiter.consumeAttempt("synthetic.race", "203.0.113.22")).allowed,
      true,
      "an earlier request cannot clear the newer request's counters",
    );
    await secondLimiter.clearPair("synthetic.race", "203.0.113.22", latest);
  }));

test("Redis failure denies login instead of falling back to an in-process counter", () =>
  withSecret(async () => {
    const redis = new SyntheticRedis();
    redis.fail = true;
    await assert.rejects(
      new LoginRateLimiter(redis as never).consumeAttempt("synthetic.user", "203.0.113.19"),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 503,
    );
  }));

test("global API budget hashes client IP and fails closed when Redis is unavailable", () =>
  withSecret(async () => {
    const redis = new SyntheticRedis();
    const limiter = new LoginRateLimiter(redis as never);
    const allowed = await limiter.consumeApiRequest("203.0.113.55");
    assert.deepEqual(allowed, { allowed: true, retryAfterSeconds: 0 });
    assert.ok(redis.keysSeen[0].startsWith("goldis:auth:login:{v2}:api-ip:"));
    assert.equal(redis.keysSeen[0].includes("203.0.113.55"), false);

    redis.fail = true;
    await assert.rejects(
      limiter.consumeApiRequest("203.0.113.55"),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 503,
    );
  }));

test("anonymous failed-login audit samples are bounded per shared Redis window", () =>
  withSecret(async () => {
    const limiter = new LoginRateLimiter(new SyntheticRedis() as never);
    const samples = await Promise.all(Array.from({ length: 20 }, () => limiter.shouldSampleLoginFailure()));
    assert.equal(samples.filter(Boolean).length, 5);
  }));

test("IP limit applies across many usernames", () =>
  withSecret(async () => {
    const limiter = new LoginRateLimiter(new SyntheticRedis() as never);
    for (let attempt = 0; attempt < loginIpAttemptLimit; attempt += 1) {
      assert.equal((await limiter.consumeAttempt(`synthetic-${attempt}`, "203.0.113.20")).allowed, true);
    }
    const blocked = await limiter.consumeAttempt("synthetic-last", "203.0.113.20");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 73);
  }));

test("reauthentication budgets span sessions and share bounded account backoff", () =>
  withSecret(async () => {
    const redis = new SyntheticRedis();
    const limiter = new LoginRateLimiter(redis as never);
    const userId = "11111111-1111-4111-8111-111111111111";
    const decisions = [];
    for (let index = 0; index < 5; index += 1) {
      const decision = await limiter.consumeReauthAttempt(userId, `session-${index}`, `203.0.113.${index + 30}`);
      assert.equal(decision.allowed, true);
      decisions.push(decision);
    }
    assert.equal((await limiter.consumeReauthAttempt(userId, "session-six", "198.51.100.30")).allowed, false);
    await limiter.clearReauth(userId, "session-4", decisions[4]);
    assert.equal((await limiter.consumeReauthAttempt(userId, "session-six", "198.51.100.30")).allowed, true);

    const failed = await limiter.consumeReauthAttempt(
      "22222222-2222-4222-8222-222222222222",
      "session-one",
      "203.0.113.99",
    );
    await limiter.recordReauthFailure("22222222-2222-4222-8222-222222222222", failed);
    const backoff = await limiter.consumeReauthAttempt(
      "22222222-2222-4222-8222-222222222222",
      "session-two",
      "198.51.100.99",
    );
    assert.equal(backoff.allowed, false);
    assert.equal(backoff.retryAfterSeconds, 1);
  }));

test("password recovery hashes the address and suppresses account cooldown without revealing account state", () =>
  withSecret(async () => {
    const redis = new SyntheticRedis();
    const limiter = new LoginRateLimiter(redis as never);
    const first = await limiter.consumeRecoveryRequest("person@example.test", "203.0.113.90");
    const second = await limiter.consumeRecoveryRequest("person@example.test", "203.0.113.90");
    assert.deepEqual(first, { kind: "queue", retryAfterSeconds: 0, limitedBy: null });
    assert.deepEqual(second, { kind: "suppress", retryAfterSeconds: 60, limitedBy: "account" });
    assert.ok(redis.keysSeen.every((key) => !key.includes("person@example.test") && !key.includes("203.0.113.90")));

    redis.values.clear();
    for (let index = 0; index < recoveryAddressLimit; index += 1) {
      assert.equal(
        (await limiter.consumeRecoveryRequest("three@example.test", `198.51.100.${index + 1}`)).kind,
        "queue",
      );
      redis.values.clear();
    }
    assert.equal((await limiter.consumeRecoveryRequest("three@example.test", "198.51.100.8")).kind, "suppress");
  }));

test("password recovery rate limits by IP and mail volume; Redis failure denies", () =>
  withSecret(async () => {
    const redis = new SyntheticRedis();
    const limiter = new LoginRateLimiter(redis as never);
    for (let index = 0; index < recoveryIpLimit; index += 1) {
      assert.equal((await limiter.consumeRecoveryRequest(`user-${index}@example.test`, "203.0.113.92")).kind, "queue");
    }
    assert.equal((await limiter.consumeRecoveryRequest("next@example.test", "203.0.113.92")).limitedBy, "ip");
    const mailDecision = await limiter.consumeAuthMailSendBudget();
    assert.equal(mailDecision.allowed, true);
    const blockedLimiter = new LoginRateLimiter(redis as never);
    redis.fail = true;
    await assert.rejects(
      blockedLimiter.consumeRecoveryRequest("person@example.test", "203.0.113.93"),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 503,
    );
    await assert.rejects(
      blockedLimiter.consumeAuthMailSendBudget(),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 503,
    );
  }));
