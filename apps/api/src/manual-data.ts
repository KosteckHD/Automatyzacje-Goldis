import {
  Body, ConflictException, Controller, ForbiddenException, Injectable, Patch, Param, Req, UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { sequelize, AutomationRun, ImportBatch, ManualIntervention, RunEvent, RunManualDataOverride, RunIdentity, SourceRow } from "./db";
import { RequirePermission, PermissionGuard } from "./authorization-guard";
import { readSessionPrincipal, SessionGuard, verifyCsrfRequest } from "./session";
import { recordAuditEvent, type AuditActorContext } from "./audit";
import { fieldCodeForField, fieldForCode, immutableAfterStart, parseManualDataPatch, type ManualDataField } from "./manual-data-contract";
export { canResumeManualIntervention, parseManualDataPatch } from "./manual-data-contract";
export type { ManualDataField, ManualDataPatch } from "./manual-data-contract";

@Injectable()
export class ManualDataService {
  async patch(runId: string, actor: AuditActorContext, inputValue: unknown) {
    const input = parseManualDataPatch(inputValue);
    const [field, value] = (Object.entries(input.fields) as [ManualDataField, string][])[0];
    return sequelize.transaction(async (transaction) => {
      const run = await AutomationRun.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run) throw new ConflictException("Nie znaleziono zadania do poprawy");
      const batch = await ImportBatch.findByPk(run.batchId, { attributes: ["tenantId"], transaction });
      if (!batch || batch.tenantId !== actor.tenantId) throw new ConflictException("Nie znaleziono zadania do poprawy");
      if (run.manualDataVersion !== input.expectedVersion) throw new ConflictException("Dane zostały już poprawione. Odśwież zgłoszenie i spróbuj ponownie.");
      if (run.status !== "waiting_for_manual_data" && run.status !== "identity_review") {
        throw new ConflictException("Zadanie nie oczekuje na poprawę danych");
      }
      const incident = await ManualIntervention.findOne({
        where: { runId, status: "open" }, order: [["createdAt", "DESC"]], transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!incident || fieldForCode[incident.fieldCode ?? ""] !== field) {
        throw new ConflictException("Poprawka nie odpowiada polu aktualnego zgłoszenia");
      }
      const source = await SourceRow.findByPk(run.sourceRowId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!source) throw new ConflictException("Brak źródłowego wiersza zadania");
      if (field === "expectedPersonName") {
        const identity = await RunIdentity.findByPk(runId, { transaction, lock: transaction.LOCK.UPDATE });
        if (run.status !== "identity_review" || source.decisionMakerName?.trim() || identity
          || run.lastSafeStep || run.externalCaseRef) {
          throw new ConflictException("Oczekiwaną osobę można wskazać tylko przed potwierdzeniem tożsamości i startem oferty");
        }
      } else if (run.status !== "waiting_for_manual_data" || immutableAfterStart.has(run.lastSafeStep ?? "")
        || (run.lastSafeStep === "compensa_offer_draft_open" && !run.externalCaseRef)) {
        throw new ConflictException("Poprawka jest zablokowana po rozpoczęciu zapisu. Najpierw uzgodnij tę samą sprawę w portalu.");
      }

      const version = run.manualDataVersion + 1;
      const now = new Date();
      await RunManualDataOverride.create({
        runId, version, source: "admin_correction", fields: { [field]: value }, reason: input.reason,
        createdBy: actor.actorUserId, createdAt: now,
      }, { transaction });
      run.manualDataVersion = version;
      await run.save({ transaction });
      incident.revision += 1;
      incident.updatedAt = now;
      await incident.save({ transaction });
      await RunEvent.create({
        runId, status: run.status, step: "manual_data_corrected", errorCode: null, actorId: actor.actorUserId,
        metadata: { fieldCode: fieldCodeForField[field], version }, createdAt: now,
      }, { transaction });
      await recordAuditEvent({
        tenantId: actor.tenantId, actorUserId: actor.actorUserId,
        action: "run.manual_data_corrected", resourceType: "run", resourceId: runId, outcome: "succeeded",
      }, transaction);
      return { runId, manualDataVersion: version, fieldCode: fieldCodeForField[field], canResumeReview: true };
    });
  }
}

@Controller("runs")
@UseGuards(SessionGuard, PermissionGuard)
export class ManualDataController {
  constructor(private readonly manualData: ManualDataService) {}

  @Patch(":id/manual-data")
  @RequirePermission("run:manual_data", "route-run")
  patch(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    if (!verifyCsrfRequest(req)) throw new ForbiddenException("Wymagany jest poprawny token CSRF");
    const principal = readSessionPrincipal(req);
    if (!principal) throw new ForbiddenException();
    return this.manualData.patch(id, { tenantId: principal.tenantId, actorUserId: principal.userId }, body);
  }
}
