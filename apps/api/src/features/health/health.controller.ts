import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  live() {
    return this.health.live();
  }

  @Get("live")
  liveness() {
    return this.health.liveness();
  }

  @Get("ready")
  async readiness(@Res() response: Response) {
    const ready = await this.health.readiness();
    response
      .status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({ status: ready ? "ready" : "not_ready" });
  }

  @Get("automation")
  async automation(@Res() response: Response) {
    const result = await this.health.automation();
    response.status(result.servicesReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json(result);
  }

  @Get("enrichment")
  async enrichment(@Res() response: Response) {
    const result = await this.health.enrichment();
    response.status(result.available ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json(result);
  }
}
