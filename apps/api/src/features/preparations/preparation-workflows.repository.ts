import { Inject, Injectable } from "@nestjs/common";
import { Op, type Sequelize, type Transaction } from "sequelize";
import { API_DATABASE } from "../../infrastructure/database";
import {
  EnrichmentJob,
  ImportPreparation,
  ImportPreparationWorkflow,
  ImportPreparationWorkflowJob,
  ImportPreparedRow,
  SourceRow,
  TenantMembership,
  User,
} from "../../infrastructure/database/db";

@Injectable()
export class ImportPreparationWorkflowsRepository {
  constructor(@Inject(API_DATABASE) private readonly database: Sequelize) {}

  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  findByIdempotency(
    tenantId: string,
    batchId: string,
    actorUserId: string,
    idempotencyKey: string,
    transaction: Transaction,
  ) {
    return ImportPreparationWorkflow.findOne({
      where: { tenantId, batchId, actorUserId, idempotencyKey },
      transaction,
    });
  }

  findPreparationForStart(preparationId: string, tenantId: string, batchId: string, transaction: Transaction) {
    return ImportPreparation.findOne({
      where: { preparationId, tenantId, batchId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findLatestPreparation(tenantId: string, batchId: string, transaction: Transaction) {
    return ImportPreparation.findOne({
      where: { tenantId, batchId },
      order: [["revision", "DESC"]],
      transaction,
      lock: transaction.LOCK.SHARE,
    });
  }

  findSourceRowVersions(batchId: string, transaction?: Transaction) {
    return SourceRow.findAll({ where: { batchId }, attributes: ["id", "rowVersion"], transaction });
  }

  findActiveWorkflow(tenantId: string, batchId: string, transaction: Transaction) {
    return ImportPreparationWorkflow.findOne({
      where: {
        tenantId,
        batchId,
        status: {
          [Op.in]: ["queued", "starting_registry", "waiting_registry", "starting_reanalysis", "waiting_reanalysis"],
        },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  createWorkflow(input: Parameters<typeof ImportPreparationWorkflow.create>[0], transaction: Transaction) {
    return ImportPreparationWorkflow.create(input, { transaction });
  }

  listWorkflows(batchId: string, tenantId: string) {
    return ImportPreparationWorkflow.findAll({
      where: { batchId, tenantId },
      order: [["createdAt", "DESC"]],
      limit: 20,
    });
  }

  findWorkflow(workflowId: string, batchId?: string, tenantId?: string) {
    return ImportPreparationWorkflow.findOne({
      where: { workflowId, ...(batchId ? { batchId } : {}), ...(tenantId ? { tenantId } : {}) },
    });
  }

  findWorkflowById(workflowId: string, transaction?: Transaction, forUpdate = false) {
    return ImportPreparationWorkflow.findByPk(workflowId, {
      transaction,
      ...(forUpdate && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  findWorkflowJobs(workflowId: string, transaction?: Transaction) {
    return ImportPreparationWorkflowJob.findAll({
      where: { workflowId },
      order: [["chunkNumber", "ASC"]],
      transaction,
    });
  }

  findEnrichmentJobs(jobIds: readonly string[], batchId: string, attributes?: string[], transaction?: Transaction) {
    if (jobIds.length === 0) return Promise.resolve([]);
    return EnrichmentJob.findAll({
      where: { jobId: [...jobIds], batchId },
      ...(attributes ? { attributes } : {}),
      transaction,
    });
  }

  findPreparationById(preparationId: string, attributes?: string[], transaction?: Transaction) {
    return ImportPreparation.findByPk(preparationId, {
      ...(attributes ? { attributes } : {}),
      transaction,
    });
  }

  findWorkflowForUpdate(workflowId: string, batchId: string, tenantId: string, transaction: Transaction) {
    return ImportPreparationWorkflow.findOne({
      where: { workflowId, batchId, tenantId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  saveWorkflow(workflow: ImportPreparationWorkflow, transaction: Transaction) {
    return workflow.save({ transaction });
  }

  findEnrichmentJobsByIds(jobIds: readonly string[], batchId: string, transaction?: Transaction) {
    if (jobIds.length === 0) return Promise.resolve([]);
    return EnrichmentJob.findAll({ where: { jobId: [...jobIds], batchId }, transaction });
  }

  findActiveForClaim(now: Date, transaction: Transaction) {
    return ImportPreparationWorkflow.findOne({
      where: {
        status: {
          [Op.in]: ["queued", "starting_registry", "waiting_registry", "starting_reanalysis", "waiting_reanalysis"],
        },
        [Op.and]: [
          { [Op.or]: [{ nextAttemptAt: null }, { nextAttemptAt: { [Op.lte]: now } }] },
          { [Op.or]: [{ leaseExpiresAt: null }, { leaseExpiresAt: { [Op.lte]: now } }] },
        ],
      },
      order: [
        ["createdAt", "ASC"],
        ["workflowId", "ASC"],
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
  }

  findActorStatus(userId: string, tenantId: string) {
    return Promise.all([
      User.findByPk(userId, { attributes: ["status"] }),
      TenantMembership.findOne({
        where: { tenantId, userId, status: "active" },
        attributes: ["role"],
      }),
    ]);
  }

  findSealedPreparation(preparationId: string, batchId: string) {
    return ImportPreparation.findOne({ where: { preparationId, batchId } });
  }

  findWaitingRegistryRows(preparationId: string) {
    return ImportPreparedRow.findAll({
      where: { preparationId, status: "waiting_registry" },
      order: [["rowNumber", "ASC"]],
      attributes: ["rowNumber"],
    });
  }

  findWorkflowJob(workflowId: string, chunkNumber: number) {
    return ImportPreparationWorkflowJob.findOne({ where: { workflowId, chunkNumber } });
  }

  createWorkflowJobIfMissing(workflowId: string, chunkNumber: number, jobId: string, batchId: string, createdAt: Date) {
    return ImportPreparationWorkflowJob.findOrCreate({
      where: { workflowId, chunkNumber },
      defaults: { workflowId, jobId, batchId, chunkNumber, createdAt },
    });
  }
}
