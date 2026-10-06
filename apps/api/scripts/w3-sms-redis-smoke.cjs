const assert = require("node:assert/strict");
const { Queue } = require("bullmq");

const syntheticCode = "684203";
const runId = "44444444-4444-4444-8444-444444444444";

function parseRedisUrl(value) {
  if (!value) throw new Error("REDIS_URL_REQUIRED_FOR_SYNTHETIC_SMOKE");
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL_INVALID");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

async function readRedisValues(client) {
  const values = [];
  let cursor = "0";
  do {
    const result = await client.scan(cursor, "COUNT", 100);
    cursor = result[0];
    for (const key of result[1]) {
      const type = await client.type(key);
      if (type === "string") values.push(key, await client.get(key));
      else if (type === "hash") values.push(key, JSON.stringify(await client.hgetall(key)));
      else if (type === "list") values.push(key, JSON.stringify(await client.lrange(key, 0, -1)));
      else if (type === "set") values.push(key, JSON.stringify(await client.smembers(key)));
      else if (type === "zset") values.push(key, JSON.stringify(await client.zrange(key, 0, -1, "WITHSCORES")));
      else if (type === "stream") values.push(key, JSON.stringify(await client.xrange(key, "-", "+")));
      else throw new Error("REDIS_SCAN_UNSUPPORTED_VALUE_TYPE");
    }
  } while (cursor !== "0");
  return values.filter((value) => value !== null && value !== undefined).join("\n");
}

async function main() {
  const queue = new Queue(`goldis-w3-sms-scan-${Date.now()}`, { connection: parseRedisUrl(process.env.REDIS_URL) });
  try {
    await queue.waitUntilReady();
    const job = await queue.add("synthetic-run", { runId }, { jobId: runId, removeOnComplete: false, removeOnFail: false });
    assert.deepEqual(job.data, { runId }, "job zawiera wyłącznie identyfikator zadania");
    const redis = await queue.client;
    const serializedQueueData = await readRedisValues(redis);
    assert.equal(serializedQueueData.includes(syntheticCode), false, "kod nie trafia do żadnej wartości Redis/BullMQ");
    assert.equal(serializedQueueData.includes(runId), true, "syntetyczne zadanie jest widoczne w Redis");
    console.log("W3_SMS_REDIS_SMOKE_PASS jobFields=runId codeAbsentFromAllRedisValues=true queueKeysScanned=true");
  } finally {
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  }
}

main().catch((error) => {
  const code = error?.code ?? error?.name ?? "UnknownError";
  const message = typeof error?.message === "string" ? error.message.slice(0, 160) : "";
  console.error("W3_SMS_REDIS_SMOKE_FAILED", code, message);
  process.exitCode = 1;
});
