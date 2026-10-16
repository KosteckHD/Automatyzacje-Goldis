import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { canResumeManualIntervention, canRetrySms } from "../interventions/public";
import { ArtifactDownloadService } from "../results/public";
import { canRecheckPortalIntervention } from "../review/public";
import { summarizeRun } from "./run-summary";
import { RunsReadRepository } from "./runs-read.repository";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RunsReadService {
  constructor(
    @Inject(RunsReadRepository) private readonly repository: RunsReadRepository,
    @Inject(ArtifactDownloadService) private readonly artifactDownloads: ArtifactDownloadService,
  ) {}

  async list(batchId: string) {
    if (!uuidPattern.test(batchId)) throw new BadRequestException("Nieprawidłowy identyfikator importu");
    return (await this.repository.findByBatch(batchId)).map(summarizeRun);
  }

  async get(id: string, role: string | null = null, userId: string | null = null) {
    if (!uuidPattern.test(id)) throw new BadRequestException("Nieprawidłowy identyfikator zadania");
    if (await this.repository.isDeletionPending(id)) throw new NotFoundException("Nie znaleziono zadania");
    const run = await this.repository.findRun(id);
    if (!run) throw new NotFoundException("Nie znaleziono zadania");
    const snapshot = await this.repository.findSnapshot(id);
    const currentOcCount = snapshot ? await this.repository.countCurrentPolicies(id, run.referenceDate) : null;
    const events = await this.repository.findEvents(id);
    const incident = ["identity_review", "waiting_for_manual_data", "waiting_for_sms"].includes(run.status)
      ? await this.repository.findOpenIntervention(id)
      : null;
    const manualOverride =
      run.manualDataVersion > 0 ? await this.repository.findManualOverride(id, run.manualDataVersion) : null;
    const isRunStarter = Boolean(userId && run.startedByUserId === userId);
    const retryCount = incident?.portal === "compensa" ? run.compensaSmsRetryCount : run.pzuSmsRetryCount;
    const canResumeAuth =
      incident?.kind === "sms" &&
      isRunStarter &&
      canRetrySms({
        status: run.status,
        errorCode: run.errorCode,
        reasonCode: incident.reasonCode,
        portal: incident.portal,
        retryCount,
      });
    const artifact = run.status === "completed" ? await this.repository.findReadyArtifact(id) : null;
    return {
      ...summarizeRun(run),
      policyCounts: snapshot ? { totalOcCount: snapshot.totalCount, currentOcCount } : null,
      artifactAvailable: Boolean(artifact && artifact.policyCount > 0),
      incident: incident
        ? {
            kind: incident.kind,
            portal: incident.portal,
            reasonCode: incident.reasonCode,
            fieldCode: incident.fieldCode,
            createdAt: incident.createdAt,
            retryAllowed: canResumeAuth,
            canResumeAuth,
            canResumeReview:
              canResumeManualIntervention({
                role: role ?? "",
                isRunStarter,
                runStatus: run.status,
                fieldCode: incident.fieldCode,
                lastSafeStep: run.lastSafeStep,
                externalCaseRef: run.externalCaseRef,
                manualDataVersion: run.manualDataVersion,
                overrideVersion: manualOverride?.version ?? null,
                fields: manualOverride?.fields ?? null,
              }) ||
              canRecheckPortalIntervention({
                role: role ?? "",
                runStatus: run.status,
                portal: incident.portal,
                kind: incident.kind,
                reasonCode: incident.reasonCode,
                fieldCode: incident.fieldCode,
                lastSafeStep: run.lastSafeStep,
                externalCaseRef: run.externalCaseRef,
              }),
          }
        : null,
      events: events.map((event) => ({
        status: event.status,
        step: event.step,
        errorCode: event.errorCode,
        createdAt: event.createdAt,
      })),
    };
  }

  downloadArtifact(id: string) {
    return this.artifactDownloads.download(id);
  }
}
