import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Inject, Injectable, type OnModuleDestroy, Optional, ServiceUnavailableException } from "@nestjs/common";
import Redis from "ioredis";
import { loadApiRuntimeConfig, loadApiSecretConfig } from "../../infrastructure/config";

export const LOGIN_RATE_LIMIT_REDIS = "GOLDIS_LOGIN_RATE_LIMIT_REDIS";
export const loginRateLimitWindowSeconds = 15 * 60;
export const loginPairAttemptLimit = 5;
export const loginAccountAttemptLimit = 10;
export const loginIpAttemptLimit = 60;
export const reauthUserAttemptLimit = 5;
export const reauthSessionAttemptLimit = 5;
export const reauthIpAttemptLimit = 30;
export const apiIpRequestLimit = 300;
export const apiRequestWindowSeconds = 60;
export const loginFailureAuditWindowSeconds = 15 * 60;
export const loginFailureAuditSampleLimit = 5;
export const recoveryAddressLimit = 3;
export const recoveryIpLimit = 10;
export const recoveryWindowSeconds = 15 * 60;
export const recoveryAddressCooldownSeconds = 60;
export const recoveryTokenIpLimit = 10;
export const recoveryTokenWindowSeconds = 15 * 60;
export const authMailSendLimit = 60;
export const authMailSendWindowSeconds = 60;

const consumeApiRequestScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if count > tonumber(ARGV[1]) then return {0, math.max(1, redis.call('TTL', KEYS[1]))} end
return {1, 0}
`;

const sampleLoginFailureScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return count <= tonumber(ARGV[1]) and 1 or 0
`;

const consumeRecoveryRequestScript = `
-- goldis-recovery-request
local address_count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ip_count = tonumber(redis.call('GET', KEYS[3]) or '0')
local cooldown = tonumber(redis.call('PTTL', KEYS[2]) or '-2')
if ip_count >= tonumber(ARGV[1]) then return {0, math.max(1, redis.call('TTL', KEYS[3])), 'ip'} end
if cooldown > 0 then return {2, math.max(1, math.ceil(cooldown / 1000)), 'account'} end
if address_count >= tonumber(ARGV[2]) then return {2, math.max(1, redis.call('TTL', KEYS[1])), 'account'} end
local next_address = redis.call('INCR', KEYS[1])
if next_address == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
local next_ip = redis.call('INCR', KEYS[3])
if next_ip == 1 then redis.call('EXPIRE', KEYS[3], ARGV[3]) end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[4])
return {1, 0, 'allowed'}
`;

const consumeRecoveryTokenAttemptScript = `
-- goldis-recovery-token-attempt
local ip_count = redis.call('INCR', KEYS[1])
if ip_count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if ip_count > tonumber(ARGV[1]) then return {0, math.max(1, redis.call('TTL', KEYS[1]))} end
return {1, 0}
`;

const consumeAuthMailSendBudgetScript = `
-- goldis-auth-mail-send-budget
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if count > tonumber(ARGV[1]) then return {0, math.max(1, redis.call('TTL', KEYS[1]))} end
return {1, 0}
`;

const consumeLoginAttemptScript = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) + tonumber(clock[2]) / 1000000
local blocked_until = tonumber(redis.call('GET', KEYS[7]) or '0')
if blocked_until > now then return {0, math.max(1, math.ceil(blocked_until - now)), '', ''} end
local pair_count = tonumber(redis.call('GET', KEYS[1]) or '0')
local account_count = tonumber(redis.call('GET', KEYS[2]) or '0')
local ip_count = tonumber(redis.call('GET', KEYS[3]) or '0')
local pair_limit = tonumber(ARGV[1])
local account_limit = tonumber(ARGV[2])
local ip_limit = tonumber(ARGV[3])
local window_seconds = tonumber(ARGV[4])
if pair_count >= pair_limit then
  return {0, math.max(1, redis.call('TTL', KEYS[1])), '', ''}
end
if account_count >= account_limit then
  return {0, math.max(1, redis.call('TTL', KEYS[2])), '', ''}
end
if ip_count >= ip_limit then
  return {0, math.max(1, redis.call('TTL', KEYS[3])), '', ''}
end
local next_pair = redis.call('INCR', KEYS[1])
if next_pair == 1 then redis.call('EXPIRE', KEYS[1], window_seconds) end
local next_account = redis.call('INCR', KEYS[2])
if next_account == 1 then redis.call('EXPIRE', KEYS[2], window_seconds) end
local next_ip = redis.call('INCR', KEYS[3])
if next_ip == 1 then redis.call('EXPIRE', KEYS[3], window_seconds) end
if next_pair == 1 then redis.call('SET', KEYS[4], ARGV[5], 'EX', window_seconds)
else redis.call('SET', KEYS[4], ARGV[5], 'KEEPTTL') end
if next_account == 1 then redis.call('SET', KEYS[5], ARGV[5], 'EX', window_seconds)
else redis.call('SET', KEYS[5], ARGV[5], 'KEEPTTL') end
return {1, 0, ARGV[5], ARGV[5]}
`;

const clearSuccessfulAttemptScript = `
local deleted = 0
if redis.call('GET', KEYS[3]) == ARGV[1] then
  deleted = deleted + redis.call('DEL', KEYS[1], KEYS[3])
end
if redis.call('GET', KEYS[4]) == ARGV[2] then
  deleted = deleted + redis.call('DEL', KEYS[2], KEYS[4], KEYS[5], KEYS[6])
end
return deleted
`;

const recordFailureScript = `
if not redis.call('GET', KEYS[1]) then return 0 end
local failures = redis.call('INCR', KEYS[2])
if failures == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
local delay = math.min(30, 2 ^ math.min(5, failures - 1))
local clock = redis.call('TIME')
local now = tonumber(clock[1]) + tonumber(clock[2]) / 1000000
redis.call('SET', KEYS[3], tostring(now + delay), 'PX', delay * 1000)
return delay
`;

const consumeReauthScript = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) + tonumber(clock[2]) / 1000000
local blocked_until = tonumber(redis.call('GET', KEYS[6]) or '0')
if blocked_until > now then return {0, math.max(1, math.ceil(blocked_until - now)), ''} end
local user_count = tonumber(redis.call('GET', KEYS[1]) or '0')
local session_count = tonumber(redis.call('GET', KEYS[2]) or '0')
local ip_count = tonumber(redis.call('GET', KEYS[3]) or '0')
if user_count >= tonumber(ARGV[1]) then return {0, math.max(1, redis.call('TTL', KEYS[1])), ''} end
if session_count >= tonumber(ARGV[2]) then return {0, math.max(1, redis.call('TTL', KEYS[2])), ''} end
if ip_count >= tonumber(ARGV[3]) then return {0, math.max(1, redis.call('TTL', KEYS[3])), ''} end
local next_user = redis.call('INCR', KEYS[1])
if next_user == 1 then redis.call('EXPIRE', KEYS[1], ARGV[4]) end
local next_session = redis.call('INCR', KEYS[2])
if next_session == 1 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
local next_ip = redis.call('INCR', KEYS[3])
if next_ip == 1 then redis.call('EXPIRE', KEYS[3], ARGV[4]) end
if next_user == 1 then redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[4])
else redis.call('SET', KEYS[4], ARGV[5], 'KEEPTTL') end
if next_session == 1 then redis.call('SET', KEYS[5], ARGV[5], 'EX', ARGV[4])
else redis.call('SET', KEYS[5], ARGV[5], 'KEEPTTL') end
return {1, 0, ARGV[5]}
`;

const clearReauthScript = `
local deleted = 0
if redis.call('GET', KEYS[3]) == ARGV[1] then
  deleted = deleted + redis.call('DEL', KEYS[1], KEYS[3], KEYS[5], KEYS[6])
end
if redis.call('GET', KEYS[4]) == ARGV[1] then
  deleted = deleted + redis.call('DEL', KEYS[2], KEYS[4])
end
return deleted
`;

type RedisRateLimitClient = Pick<Redis, "eval" | "del" | "quit"> &
  Partial<Pick<Redis, "connect" | "status" | "disconnect">>;
export type LoginAttemptDecision = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
  pairGeneration: string;
  accountGeneration: string;
}>;
export type ReauthAttemptDecision = Readonly<{ allowed: boolean; retryAfterSeconds: number; generation: string }>;
export type ApiRequestDecision = Readonly<{ allowed: boolean; retryAfterSeconds: number }>;
export type RecoveryRequestDecision = Readonly<{
  kind: "queue" | "suppress" | "limited";
  retryAfterSeconds: number;
  limitedBy: "account" | "ip" | "global" | null;
}>;

function secret(): string {
  const value = loadApiSecretConfig().loginRateLimitSecret;
  if (!value || value.startsWith("REPLACE_WITH") || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("LOGIN_RATE_LIMIT_SECRET must have at least 32 non-placeholder bytes");
  }
  return value;
}

function digest(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

function normalizedIp(ip: string): string {
  const raw = ip.trim().replace(/^\[|\]$/g, "");
  if (isIP(raw) === 4)
    return raw
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  if (isIP(raw) !== 6) return "invalid";
  try {
    const canonical = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
    const [leftText, rightText = ""] = canonical.split("::");
    const left = leftText ? leftText.split(":") : [];
    const right = rightText ? rightText.split(":") : [];
    const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map((part) =>
      Number.parseInt(part || "0", 16),
    );
    if (groups.length !== 8 || groups.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff))
      return "invalid";
    if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
      return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
    }
    return `${groups
      .slice(0, 4)
      .map((part) => part.toString(16))
      .join(":")}::/64`;
  } catch {
    return "invalid";
  }
}

@Injectable()
export class LoginRateLimiter implements OnModuleDestroy {
  private readonly redis: RedisRateLimitClient;
  private readonly namespace: string = "goldis:auth:login:{v2}";
  private redisConnectPromise?: Promise<void>;

  constructor(@Optional() @Inject(LOGIN_RATE_LIMIT_REDIS) redis?: RedisRateLimitClient) {
    const runtimeConfig = loadApiRuntimeConfig();
    const redisUrl = loadApiSecretConfig().redisUrl;
    if (redis) {
      this.redis = redis;
    } else {
      if (!redisUrl) throw new Error("REDIS_URL is required for login rate limiting");
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
    }
    const configuredNamespace = runtimeConfig.loginRateLimitKeyPrefix;
    if (configuredNamespace) this.namespace = `${configuredNamespace}:{v2}`;
    secret();
  }

  async consumeAttempt(username: string, clientIp: string): Promise<LoginAttemptDecision> {
    const normalizedUsername = username.trim().toLowerCase();
    const ip = normalizedIp(clientIp);
    const pairKey = `${this.namespace}:pair:${digest(`${normalizedUsername}\u0000${ip}`)}`;
    const accountDigest = digest(`goldis\u0000${normalizedUsername}`);
    const accountKey = `${this.namespace}:account:${accountDigest}`;
    const ipKey = `${this.namespace}:ip:${digest(ip)}`;
    const pairGenerationKey = `${this.namespace}:pair-generation:${digest(`${normalizedUsername}\u0000${ip}`)}`;
    const accountGenerationKey = `${this.namespace}:account-generation:${accountDigest}`;
    const accountFailureKey = `${this.namespace}:account-failures:${accountDigest}`;
    const accountBackoffKey = `${this.namespace}:account-backoff:${accountDigest}`;
    const attemptGeneration = randomUUID();
    try {
      await this.ensureRedisReady();
      const result = await this.redis.eval(
        consumeLoginAttemptScript,
        7,
        pairKey,
        accountKey,
        ipKey,
        pairGenerationKey,
        accountGenerationKey,
        accountFailureKey,
        accountBackoffKey,
        String(loginPairAttemptLimit),
        String(loginAccountAttemptLimit),
        String(loginIpAttemptLimit),
        String(loginRateLimitWindowSeconds),
        attemptGeneration,
      );
      if (!Array.isArray(result) || result.length < 4) throw new Error("LOGIN_RATE_LIMIT_RESPONSE_INVALID");
      const allowed = Number(result[0]) === 1;
      const retryAfterSeconds = Math.max(0, Number(result[1]) || 0);
      return {
        allowed,
        retryAfterSeconds,
        pairGeneration: allowed ? String(result[2]) : "",
        accountGeneration: allowed ? String(result[3]) : "",
      };
    } catch {
      throw new ServiceUnavailableException("Logowanie jest chwilowo niedostępne");
    }
  }

  /** Shared pre-parser API IP budget; Redis errors fail closed. */
  async consumeApiRequest(clientIp: string): Promise<ApiRequestDecision> {
    const ipKey = `${this.namespace}:api-ip:${digest(normalizedIp(clientIp))}`;
    try {
      await this.ensureRedisReady();
      const result = await this.redis.eval(
        consumeApiRequestScript,
        1,
        ipKey,
        String(apiIpRequestLimit),
        String(apiRequestWindowSeconds),
      );
      if (!Array.isArray(result) || result.length < 2) throw new Error("API_RATE_LIMIT_RESPONSE_INVALID");
      return { allowed: Number(result[0]) === 1, retryAfterSeconds: Math.max(0, Number(result[1]) || 0) };
    } catch {
      throw new ServiceUnavailableException("Usługa jest chwilowo niedostępna");
    }
  }

  /** Anonymous forgot-password requests consume identical budgets for known and unknown addresses. */
  async consumeRecoveryRequest(normalizedEmail: string, clientIp: string): Promise<RecoveryRequestDecision> {
    const emailKey = `${this.namespace}:recovery-address:${digest(`goldis:recovery-address\u0000${normalizedEmail}`)}`;
    const cooldownKey = `${this.namespace}:recovery-cooldown:${digest(`goldis:recovery-address\u0000${normalizedEmail}`)}`;
    const ipKey = `${this.namespace}:recovery-ip:${digest(normalizedIp(clientIp))}`;
    try {
      await this.ensureRedisReady();
      const result = await this.redis.eval(
        consumeRecoveryRequestScript,
        3,
        emailKey,
        cooldownKey,
        ipKey,
        String(recoveryIpLimit),
        String(recoveryAddressLimit),
        String(recoveryWindowSeconds),
        String(recoveryAddressCooldownSeconds),
      );
      if (!Array.isArray(result) || result.length < 3) throw new Error("RECOVERY_RATE_LIMIT_RESPONSE_INVALID");
      const code = Number(result[0]);
      const limitedBy = result[2] === "account" || result[2] === "ip" || result[2] === "global" ? result[2] : null;
      return {
        kind: code === 1 ? "queue" : code === 2 ? "suppress" : "limited",
        retryAfterSeconds: Math.max(0, Number(result[1]) || 0),
        limitedBy,
      };
    } catch {
      throw new ServiceUnavailableException("Odzyskiwanie konta jest chwilowo niedostępne");
    }
  }

  async consumeRecoveryTokenAttempt(clientIp: string): Promise<ApiRequestDecision> {
    const ipKey = `${this.namespace}:recovery-token-ip:${digest(normalizedIp(clientIp))}`;
    try {
      await this.ensureRedisReady();
      const result = await this.redis.eval(
        consumeRecoveryTokenAttemptScript,
        1,
        ipKey,
        String(recoveryTokenIpLimit),
        String(recoveryTokenWindowSeconds),
      );
      if (!Array.isArray(result) || result.length < 2) throw new Error("RECOVERY_TOKEN_LIMIT_RESPONSE_INVALID");
      return { allowed: Number(result[0]) === 1, retryAfterSeconds: Math.max(0, Number(result[1]) || 0) };
    } catch {
      throw new ServiceUnavailableException("Odzyskiwanie konta jest chwilowo niedostępne");
    }
  }

  async consumeAuthMailSendBudget(): Promise<ApiRequestDecision> {
    try {
      await this.ensureRedisReady();
      const result = await this.redis.eval(
        consumeAuthMailSendBudgetScript,
        1,
        `${this.namespace}:auth-mail-send-global`,
        String(authMailSendLimit),
        String(authMailSendWindowSeconds),
      );
      if (!Array.isArray(result) || result.length < 2) throw new Error("AUTH_MAIL_BUDGET_RESPONSE_INVALID");
      return { allowed: Number(result[0]) === 1, retryAfterSeconds: Math.max(0, Number(result[1]) || 0) };
    } catch {
      throw new ServiceUnavailableException("Wysyłka wiadomości jest chwilowo niedostępna");
    }
  }

  /** Keep anonymous failure audit inserts bounded during credential stuffing. */
  async shouldSampleLoginFailure(): Promise<boolean> {
    try {
      await this.ensureRedisReady();
      const result = await this.redis.eval(
        sampleLoginFailureScript,
        1,
        `${this.namespace}:failed-login-audit-sample`,
        String(loginFailureAuditSampleLimit),
        String(loginFailureAuditWindowSeconds),
      );
      const sampled = Number(result);
      if (sampled !== 0 && sampled !== 1) throw new Error("LOGIN_FAILURE_SAMPLE_RESPONSE_INVALID");
      return sampled === 1;
    } catch {
      return false;
    }
  }

  async clearPair(username: string, clientIp: string, attempt: LoginAttemptDecision): Promise<void> {
    if (!attempt.allowed || !attempt.pairGeneration || !attempt.accountGeneration) return;
    const normalizedUsername = username.trim().toLowerCase();
    const ip = normalizedIp(clientIp);
    const pairDigest = digest(`${normalizedUsername}\u0000${ip}`);
    const accountDigest = digest(`goldis\u0000${normalizedUsername}`);
    try {
      await this.ensureRedisReady();
      await this.redis.eval(
        clearSuccessfulAttemptScript,
        6,
        `${this.namespace}:pair:${pairDigest}`,
        `${this.namespace}:account:${accountDigest}`,
        `${this.namespace}:pair-generation:${pairDigest}`,
        `${this.namespace}:account-generation:${accountDigest}`,
        `${this.namespace}:account-failures:${accountDigest}`,
        `${this.namespace}:account-backoff:${accountDigest}`,
        attempt.pairGeneration,
        attempt.accountGeneration,
      );
    } catch {
      throw new ServiceUnavailableException("Logowanie jest chwilowo niedostępne");
    }
  }

  async recordFailure(username: string, attempt: LoginAttemptDecision): Promise<void> {
    if (!attempt.allowed || !attempt.accountGeneration) return;
    const normalizedUsername = username.trim().toLowerCase();
    const accountDigest = digest(`goldis\u0000${normalizedUsername}`);
    try {
      await this.ensureRedisReady();
      await this.redis.eval(
        recordFailureScript,
        3,
        `${this.namespace}:account-generation:${accountDigest}`,
        `${this.namespace}:account-failures:${accountDigest}`,
        `${this.namespace}:account-backoff:${accountDigest}`,
        attempt.accountGeneration,
        String(loginRateLimitWindowSeconds),
      );
    } catch {
      throw new ServiceUnavailableException("Logowanie jest chwilowo niedostępne");
    }
  }

  async consumeReauthAttempt(userId: string, sessionId: string, clientIp: string): Promise<ReauthAttemptDecision> {
    const userDigest = digest(userId);
    const sessionDigest = digest(`${userId}\u0000${sessionId}`);
    const ipDigest = digest(normalizedIp(clientIp));
    const userKey = `${this.namespace}:reauth-user:${userDigest}`;
    const sessionKey = `${this.namespace}:reauth-session:${sessionDigest}`;
    const ipKey = `${this.namespace}:reauth-ip:${ipDigest}`;
    const userGenerationKey = `${this.namespace}:reauth-user-generation:${userDigest}`;
    const sessionGenerationKey = `${this.namespace}:reauth-session-generation:${sessionDigest}`;
    const backoffKey = `${this.namespace}:reauth-backoff:${userDigest}`;
    const generation = randomUUID();
    try {
      await this.ensureRedisReady();
      const result = await this.redis.eval(
        consumeReauthScript,
        6,
        userKey,
        sessionKey,
        ipKey,
        userGenerationKey,
        sessionGenerationKey,
        backoffKey,
        String(reauthUserAttemptLimit),
        String(reauthSessionAttemptLimit),
        String(reauthIpAttemptLimit),
        String(loginRateLimitWindowSeconds),
        generation,
      );
      if (!Array.isArray(result) || result.length < 3) throw new Error("REAUTH_RATE_LIMIT_RESPONSE_INVALID");
      const allowed = Number(result[0]) === 1;
      return {
        allowed,
        retryAfterSeconds: Math.max(0, Number(result[1]) || 0),
        generation: allowed ? String(result[2]) : "",
      };
    } catch {
      throw new ServiceUnavailableException("Ponowne uwierzytelnienie jest chwilowo niedostępne");
    }
  }

  async recordReauthFailure(userId: string, attempt: ReauthAttemptDecision): Promise<void> {
    if (!attempt.allowed || !attempt.generation) return;
    const userDigest = digest(userId);
    try {
      await this.ensureRedisReady();
      await this.redis.eval(
        recordFailureScript,
        3,
        `${this.namespace}:reauth-user-generation:${userDigest}`,
        `${this.namespace}:reauth-failures:${userDigest}`,
        `${this.namespace}:reauth-backoff:${userDigest}`,
        attempt.generation,
        String(loginRateLimitWindowSeconds),
      );
    } catch {
      throw new ServiceUnavailableException("Ponowne uwierzytelnienie jest chwilowo niedostępne");
    }
  }

  async clearReauth(userId: string, sessionId: string, attempt: ReauthAttemptDecision): Promise<void> {
    if (!attempt.allowed || !attempt.generation) return;
    const userDigest = digest(userId);
    const sessionDigest = digest(`${userId}\u0000${sessionId}`);
    try {
      await this.ensureRedisReady();
      await this.redis.eval(
        clearReauthScript,
        6,
        `${this.namespace}:reauth-user:${userDigest}`,
        `${this.namespace}:reauth-session:${sessionDigest}`,
        `${this.namespace}:reauth-user-generation:${userDigest}`,
        `${this.namespace}:reauth-session-generation:${sessionDigest}`,
        `${this.namespace}:reauth-failures:${userDigest}`,
        `${this.namespace}:reauth-backoff:${userDigest}`,
        attempt.generation,
      );
    } catch {
      throw new ServiceUnavailableException("Ponowne uwierzytelnienie jest chwilowo niedostępne");
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // The API may be shutting down while Redis is already unavailable.
    } finally {
      this.redis.disconnect?.();
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
