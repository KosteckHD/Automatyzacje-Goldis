import { createHmac } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy, Optional, ServiceUnavailableException } from "@nestjs/common";
import Redis from "ioredis";

export const LOGIN_RATE_LIMIT_REDIS = "GOLDIS_LOGIN_RATE_LIMIT_REDIS";
export const loginRateLimitWindowSeconds = 15 * 60;
export const loginPairAttemptLimit = 5;
export const loginIpAttemptLimit = 60;

const consumeLoginAttemptScript = `
local pair_count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ip_count = tonumber(redis.call('GET', KEYS[2]) or '0')
local pair_limit = tonumber(ARGV[1])
local ip_limit = tonumber(ARGV[2])
local window_seconds = tonumber(ARGV[3])
if pair_count >= pair_limit then
  return {0, math.max(1, redis.call('TTL', KEYS[1]))}
end
if ip_count >= ip_limit then
  return {0, math.max(1, redis.call('TTL', KEYS[2]))}
end
local next_pair = redis.call('INCR', KEYS[1])
if next_pair == 1 then redis.call('EXPIRE', KEYS[1], window_seconds) end
local next_ip = redis.call('INCR', KEYS[2])
if next_ip == 1 then redis.call('EXPIRE', KEYS[2], window_seconds) end
return {1, 0}
`;

type RedisRateLimitClient = Pick<Redis, "eval" | "del" | "quit">
  & Partial<Pick<Redis, "connect" | "status">>;
export type LoginAttemptDecision = Readonly<{ allowed: boolean; retryAfterSeconds: number }>;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("SESSION_SECRET must have at least 32 characters");
  return value;
}

function digest(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

function normalizedIp(ip: string): string {
  const trimmed = ip.trim().slice(0, 128);
  return trimmed || "unknown";
}

@Injectable()
export class LoginRateLimiter implements OnModuleDestroy {
  private readonly redis: RedisRateLimitClient;
  private readonly namespace: string = "goldis:auth:login";
  private redisConnectPromise?: Promise<void>;

  constructor(
    @Optional() @Inject(LOGIN_RATE_LIMIT_REDIS) redis?: RedisRateLimitClient,
  ) {
    const redisUrl = process.env.REDIS_URL;
    if (!redis && !redisUrl) throw new Error("REDIS_URL is required for login rate limiting");
    this.redis = redis ?? new Redis(redisUrl!, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const configuredNamespace = process.env.LOGIN_RATE_LIMIT_KEY_PREFIX?.trim();
    if (configuredNamespace && !/^[A-Za-z0-9:_-]{1,96}$/.test(configuredNamespace)) {
      throw new Error("LOGIN_RATE_LIMIT_KEY_PREFIX has an invalid format");
    }
    if (configuredNamespace) this.namespace = configuredNamespace;
  }

  async consumeAttempt(username: string, clientIp: string): Promise<LoginAttemptDecision> {
    const normalizedUsername = username.trim().toLowerCase();
    const ip = normalizedIp(clientIp);
    const pairKey = `${this.namespace}:pair:${digest(`${normalizedUsername}\u0000${ip}`)}`;
    const ipKey = `${this.namespace}:ip:${digest(ip)}`;
    try {
      await this.ensureRedisReady();
      const result = await this.redis.eval(
        consumeLoginAttemptScript,
        2,
        pairKey,
        ipKey,
        String(loginPairAttemptLimit),
        String(loginIpAttemptLimit),
        String(loginRateLimitWindowSeconds),
      );
      if (!Array.isArray(result) || result.length < 2) throw new Error("LOGIN_RATE_LIMIT_RESPONSE_INVALID");
      const allowed = Number(result[0]) === 1;
      const retryAfterSeconds = Math.max(0, Number(result[1]) || 0);
      return { allowed, retryAfterSeconds };
    } catch {
      throw new ServiceUnavailableException("Logowanie jest chwilowo niedostępne");
    }
  }

  async clearPair(username: string, clientIp: string): Promise<void> {
    const normalizedUsername = username.trim().toLowerCase();
    const ip = normalizedIp(clientIp);
    try {
      await this.ensureRedisReady();
      await this.redis.del(`${this.namespace}:pair:${digest(`${normalizedUsername}\u0000${ip}`)}`);
    } catch {
      throw new ServiceUnavailableException("Logowanie jest chwilowo niedostępne");
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // The API may be shutting down while Redis is already unavailable.
    }
  }

  private async ensureRedisReady(): Promise<void> {
    const status = this.redis.status;
    if (status === undefined || status === "ready") return;

    if (this.redisConnectPromise) {
      await this.redisConnectPromise;
      return;
    }

    if (status !== "wait" || !this.redis.connect) {
      throw new Error("LOGIN_RATE_LIMIT_REDIS_NOT_READY");
    }

    const connection = this.redis.connect();
    this.redisConnectPromise = connection;
    try {
      await connection;
    } finally {
      if (this.redisConnectPromise === connection) this.redisConnectPromise = undefined;
    }
  }
}
