import { createHash, timingSafeEqual } from "node:crypto";
import { type IdentityMatchV1, type OcSnapshotV1, validateIdentityMatchV1, validateOcSnapshotV1 } from "@goldis/core";
import {
  BadRequestException,
  Body,
  type CanActivate,
  ConflictException,
  Controller,
  type ExecutionContext,
  ForbiddenException,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import {
  parseWorkerExecution,
  WorkerExecutionConflict,
  type WorkerExecutionFence,
} from "../../contracts/worker-execution";
import { loadApiSecretConfig } from "../../infrastructure/config";
import { ResultsService } from "./results.service";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class WorkerResultGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = loadApiSecretConfig().workerAuthSecret;
    const supplied = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
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
  constructor(@Inject(ResultsService) private readonly results: ResultsService) {}

  @Post(":id/result")
  @HttpCode(200)
  async result(@Param("id") runId: string, @Body() body: unknown, @Req() _request: Request) {
    if (!uuidPattern.test(runId) || !body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestException("Nieprawidłowy wynik zadania");
    }
    const input = body as Record<string, unknown>;
    const keys = Object.keys(input);
    const hasSnapshot =
      keys.length === 3 && keys.includes("identity") && keys.includes("snapshot") && keys.includes("execution");
    if (!hasSnapshot && !(keys.length === 1 && keys[0] === "execution")) {
      throw new BadRequestException("Nieprawidłowy wynik zadania");
    }
    let execution: WorkerExecutionFence;
    try {
      execution = parseWorkerExecution(input.execution);
    } catch {
      throw new BadRequestException("Nieprawidłowe wykonanie zadania");
    }

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
      return await this.results.acceptWorkerResult(runId, execution, identity, snapshot);
    } catch (error) {
      if (error instanceof WorkerExecutionConflict)
        throw new ConflictException("Wykonanie zadania nie jest już aktywne");
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException("Nie udało się zapisać wyniku zadania");
    }
  }
}
