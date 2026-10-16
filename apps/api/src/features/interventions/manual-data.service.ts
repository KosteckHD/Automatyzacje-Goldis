import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { AuditActorContext } from "../audit/public";
import {
  fieldCodeForField,
  fieldForCode,
  immutableAfterStart,
  type ManualDataField,
  parseManualDataPatch,
} from "./manual-data.contract";
import { ManualDataRepository } from "./manual-data.repository";

@Injectable()
export class ManualDataService {
  constructor(@Inject(ManualDataRepository) private readonly repository: ManualDataRepository) {}

  async patch(runId: string, actor: AuditActorContext, inputValue: unknown) {
    const input = parseManualDataPatch(inputValue);
    const [field, value] = (Object.entries(input.fields) as [ManualDataField, string][])[0];
    return this.repository.withTransaction(async (unitOfWork) => {
      const run = await unitOfWork.lockRun(runId);
      if (!run) throw new ConflictException("Nie znaleziono zadania do poprawy");
      if (run.startedByUserId !== actor.actorUserId)
        throw new ForbiddenException("Tylko osoba uruchamiająca może poprawić dane zadania");
      const tenantId = await unitOfWork.batchTenantId(run.batchId);
      if (!tenantId || tenantId !== actor.tenantId) throw new ConflictException("Nie znaleziono zadania do poprawy");
      if (run.manualDataVersion !== input.expectedVersion)
        throw new ConflictException("Dane zostały już poprawione. Odśwież zgłoszenie i spróbuj ponownie.");
      if (run.status !== "waiting_for_manual_data" && run.status !== "identity_review") {
        throw new ConflictException("Zadanie nie oczekuje na poprawę danych");
      }
      const incident = await unitOfWork.lockLatestOpenIntervention(runId);
      if (!incident || fieldForCode[incident.fieldCode ?? ""] !== field) {
        throw new ConflictException("Poprawka nie odpowiada polu aktualnego zgłoszenia");
      }
      const source = await unitOfWork.lockSourceDecisionMaker(run.sourceRowId);
      if (!source) throw new ConflictException("Brak źródłowego wiersza zadania");
      if (field === "expectedPersonName") {
        if (
          run.status !== "identity_review" ||
          source.decisionMakerName?.trim() ||
          (await unitOfWork.hasRunIdentity(runId)) ||
          run.lastSafeStep ||
          run.externalCaseRef
        ) {
          throw new ConflictException(
            "Oczekiwaną osobę można wskazać tylko przed potwierdzeniem tożsamości i startem oferty",
          );
        }
      } else if (
        run.status !== "waiting_for_manual_data" ||
        immutableAfterStart.has(run.lastSafeStep ?? "") ||
        (run.lastSafeStep === "compensa_offer_draft_open" && !run.externalCaseRef)
      ) {
        throw new ConflictException(
          "Poprawka jest zablokowana po rozpoczęciu zapisu. Najpierw uzgodnij tę samą sprawę w portalu.",
        );
      }

      const fieldCode = fieldCodeForField[field];
      const version = await unitOfWork.applyCorrection({
        runId,
        actorUserId: actor.actorUserId,
        field,
        fieldCode,
        value,
        reason: input.reason,
      });
      await unitOfWork.recordAudit({
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId,
        action: "run.manual_data_corrected",
        resourceType: "run",
        resourceId: runId,
        outcome: "succeeded",
      });
      return { runId, manualDataVersion: version, fieldCode, canResumeReview: true };
    });
  }
}
