import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { Op } from "sequelize";
import { loadApiSecretConfig } from "../../infrastructure/config";
import { AutomationRun, RunDispatchOutbox, sequelize } from "../../infrastructure/database/db";
import { createRunJob } from "./run-queue";

const queueName = "oc-verification";

function redisConnection() {
  const value = loadApiSecretConfig().redisUrl;
  if (!value) throw new Error("REDIS_URL is required");
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL must use redis: or rediss:");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: 1,
  };
}

@Injectable()
export class RunDispatchService implements OnModuleDestroy {
  private queue: Queue<{ runId: string }> | null = null;
  private readonly dispatcherId = randomUUID();

  get activeQueue() {
    return this.queue;
  }

  async onModuleDestroy() {
    const queue = this.queue;
    this.queue = null;
    await queue?.close();
  }

  private getQueue(): Queue<{ runId: string }> {
    this.queue ??= new Queue<{ runId: string }>(queueName, { connection: redisConnection() });
    return this.queue;
  }

  async ensureDispatch(
    runId: string,
    intentType: "create" | "resume_auth" | "resume_review" | "recovery" | "result_delivery",
    transaction: import("sequelize").Transaction,
  ) {
    const unresolved = await RunDispatchOutbox.findOne({
      where: { runId, status: ["pending", "publishing", "published"] },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (unresolved) return unresolved;
    const now = new Date();
    return RunDispatchOutbox.create(
      {
        dispatchId: randomUUID(),
        runId,
        intentType,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: now,
        claimedAt: null,
        claimedBy: null,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now,
      },
      { transaction },
    );
  }

  ensureDispatchForAdmission(runId: string, transaction: import("sequelize").Transaction) {
    return this.ensureDispatch(runId, "create", transaction);
  }

  async publishOutbox() {
    const now = new Date();
    const staleClaim = new Date(now.getTime() - 30_000);
    const claimed = await sequelize.transaction(async (transaction) => {
      const rows = await RunDispatchOutbox.findAll({
        where: {
          [Op.or]: [
            { status: "pending", nextAttemptAt: { [Op.lte]: now } },
            { status: "publishing", claimedAt: { [Op.lte]: staleClaim } },
          ],
        },
        order: [
          ["createdAt", "ASC"],
          ["dispatchId", "ASC"],
        ],
        limit: 50,
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      for (const dispatch of rows) {
        dispatch.status = "publishing";
        dispatch.attemptCount += 1;
        dispatch.claimedAt = now;
        dispatch.claimedBy = this.dispatcherId;
        dispatch.updatedAt = now;
        await dispatch.save({ transaction });
      }
      return rows.map((dispatch) => ({
        dispatchId: dispatch.dispatchId,
        runId: dispatch.runId,
        attemptCount: dispatch.attemptCount,
      }));
    });
    for (const dispatch of claimed) {
      try {
        const job = createRunJob(dispatch.runId, dispatch.dispatchId);
        await this.getQueue().add(job.name, job.data, job.options);
        await RunDispatchOutbox.update(
          { status: "published", claimedAt: null, claimedBy: null, lastErrorCode: null, updatedAt: new Date() },
          {
            where: { dispatchId: dispatch.dispatchId, status: "publishing", claimedBy: this.dispatcherId },
          },
        );
      } catch {
        const delays = [5_000, 15_000, 60_000];
        const delay = delays[Math.min(dispatch.attemptCount - 1, delays.length - 1)];
        await RunDispatchOutbox.update(
          {
            status: "pending",
            claimedAt: null,
            claimedBy: null,
            lastErrorCode: "QUEUE_PUBLISH_FAILED",
            nextAttemptAt: new Date(Date.now() + delay),
            updatedAt: new Date(),
          },
          { where: { dispatchId: dispatch.dispatchId, status: "publishing", claimedBy: this.dispatcherId } },
        ).catch(() => undefined);
      }
    }
  }

  async recoverPublishedOutbox() {
    const staleBefore = new Date(Date.now() - 60_000);
    const published = await RunDispatchOutbox.findAll({
      where: { status: "published", updatedAt: { [Op.lte]: staleBefore } },
      order: [["updatedAt", "ASC"]],
      limit: 50,
    });
    for (const dispatch of published) {
      const jobId = createRunJob(dispatch.runId, dispatch.dispatchId).options.jobId;
      const job = await this.getQueue().getJob(jobId);
      const state = job ? await job.getState().catch(() => "unknown") : "missing";
      if (job && !["completed", "failed"].includes(state)) continue;
      const retry = await sequelize.transaction(async (transaction) => {
        const current = await RunDispatchOutbox.findByPk(dispatch.dispatchId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const run = await AutomationRun.findByPk(dispatch.runId, { transaction, lock: transaction.LOCK.UPDATE });
        if (current?.status !== "published" || !run) return false;
        if (run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now()) return false;
        if (
          [
            "completed",
            "cancelled",
            "failed",
            "no_matching_policies",
            "identity_review",
            "waiting_for_manual_data",
            "waiting_for_sms",
          ].includes(run.status)
        ) {
          current.status = "consumed";
          current.updatedAt = new Date();
          await current.save({ transaction });
          return false;
        }
        current.status = "pending";
        current.nextAttemptAt = new Date();
        current.claimedAt = null;
        current.claimedBy = null;
        current.updatedAt = new Date();
        await current.save({ transaction });
        return true;
      });
      if (retry && job) await job.remove().catch(() => undefined);
    }
  }
}
