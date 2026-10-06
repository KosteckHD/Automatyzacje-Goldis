import { createHash, timingSafeEqual } from "node:crypto";
import {
  BadRequestException, Body, CanActivate, ConflictException, Controller,
  ExecutionContext, ForbiddenException, HttpCode, Injectable, Param, Post, Req, ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { validateIdentityMatchV1, validateOcSnapshotV1, type IdentityMatchV1, type OcSnapshotV1 } from "@goldis/core";
import type { Request } from "express";
import { AutomationRun } from "./db";
import { persistOcSnapshot } from "./oc-snapshot-store";
import { evaluateStoredSnapshot } from "./run-evaluation";
import { finalizeRunExport } from "./export-finalizer";
import { assertWorkerExecution, parseWorkerExecution, WorkerExecutionConflict } from "./worker-execution";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class WorkerResultGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = process.env.WORKER_AUTH_SECRET;
    const supplied = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7) : "";
    if (!expected || expected.length < 32 || !supplied) throw new ForbiddenException();
    const a = createHash("sha256").update(supplied).digest();
    const b = createHash("sha256").update(expected).digest();
    if (!timingSafeEqual(a, b)) throw new ForbiddenException();
    return true;
  }
}

/** Private worker checkpoint boundary; responses contain counts/status only. */
@Controller("internal/worker-runs")
@UseGuards(WorkerResultGuard)
export class WorkerResultController {
  @Post(":id/result")
  @HttpCode(200)
  async result(@Param("id") runId: string, @Body() body: unknown, @Req() _request: Request) {
    if (!uuidPattern.test(runId) || !body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestException("Nieprawidłowy wynik zadania");
    }
    const input = body as Record<string, unknown>;
    const keys = Object.keys(input);
    const hasSnapshot = keys.length === 3 && keys.includes("identity") && keys.includes("snapshot") && keys.includes("execution");
    if (!hasSnapshot && !(keys.length === 1 && keys[0] === "execution")) throw new BadRequestException("Nieprawidłowy wynik zadania");
    let execution;
    try { execution = parseWorkerExecution(input.execution); }
    catch { throw new BadRequestException("Nieprawidłowe wykonanie zadania"); }

    let identity: IdentityMatchV1 | null = null;
    let snapshot: OcSnapshotV1 | null = null;
    if (hasSnapshot) {
      try {
        identity = validateIdentityMatchV1(input.identity);
        snapshot = validateOcSnapshotV1(input.snapshot);
      } catch {
        throw new BadRequestException("Nieprawidłowy wynik zadania");
      }
    }
    try {
      const run = await AutomationRun.findByPk(runId);
      if (!run || !["reading_oc", "export_ready", "completed", "no_matching_policies"].includes(run.status)) {
        throw new ConflictException("Zadanie nie jest gotowe do zapisu wyniku");
      }
      assertWorkerExecution(run, execution, ["reading_oc", "export_ready", "completed", "no_matching_policies"]);
      if (identity && snapshot) {
        // Delivery may be retried after the API committed but the worker lost its response.
        // persistOcSnapshot accepts an identical checkpoint and rejects a changed result.
        await persistOcSnapshot(runId, identity, snapshot, { execution });
      }
      const evaluated = run.status === "reading_oc"
        ? await evaluateStoredSnapshot(runId, execution)
        : run.status === "export_ready"
          ? { outcome: "export_ready" as const }
          : { outcome: run.status };
      if (evaluated.outcome === "export_ready") {
        await finalizeRunExport(runId, { execution });
        return { outcome: "completed", artifactAvailable: true };
      }
      return { outcome: evaluated.outcome, artifactAvailable: evaluated.outcome === "completed" };
    } catch (error) {
      if (error instanceof WorkerExecutionConflict) throw new ConflictException("Wykonanie zadania nie jest już aktywne");
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException("Nie udało się zapisać wyniku zadania");
    }
  }
}
