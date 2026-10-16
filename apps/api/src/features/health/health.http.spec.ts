import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { createHttpApplication } from "../../infrastructure/http";
import { HealthController } from "./health.controller";
import { HealthModule } from "./health.module";
import { HealthService } from "./health.service";

@Module({ imports: [HealthModule] })
class HealthHttpSpecModule {}

const healthyAutomation = {
  status: "ready",
  automationReady: true,
  servicesReady: true,
  worker: "online",
  portalMode: "live",
  portalConfig: "valid",
  message: "Automatyzacja gotowa.",
};
const healthyEnrichment = {
  status: "ready",
  available: true,
  worker: "ready",
  provider: "configured",
  providerName: "synthetic",
  message: "Worker wzbogacania odpowiada.",
};
const contractState = {
  ready: true,
  automation: healthyAutomation,
  enrichment: healthyEnrichment,
};

const contractHealthService = {
  live: () => ({ status: "ok", service: "goldis-api" }),
  liveness: () => ({ status: "alive", service: "goldis-api" }),
  readiness: async () => contractState.ready,
  automation: async () => contractState.automation,
  enrichment: async () => contractState.enrichment,
};

@Module({
  controllers: [HealthController],
  providers: [{ provide: HealthService, useValue: contractHealthService }],
})
class HealthHttpContractSpecModule {}

test("HealthModule composes in Nest and keeps public liveness routes stable", async () => {
  const app = await createHttpApplication(HealthHttpSpecModule, { logger: false });
  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/api/health`;

    const health = await fetch(baseUrl);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "goldis-api" });
    assert.equal(health.headers.get("cache-control"), "private, no-store");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");

    const liveness = await fetch(`${baseUrl}/live`);
    assert.equal(liveness.status, 200);
    assert.deepEqual(await liveness.json(), { status: "alive", service: "goldis-api" });
  } finally {
    contractState.ready = true;
    contractState.automation = healthyAutomation;
    contractState.enrichment = healthyEnrichment;
    await app.close();
  }
});

test("health dependency routes preserve their 200/503 status and public response contracts", async () => {
  const app = await createHttpApplication(HealthHttpContractSpecModule, { logger: false });
  try {
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/api/health`;

    const readyResponse = await fetch(`${baseUrl}/ready`);
    assert.equal(readyResponse.status, 200);
    assert.deepEqual(await readyResponse.json(), { status: "ready" });
    contractState.ready = false;
    const notReadyResponse = await fetch(`${baseUrl}/ready`);
    assert.equal(notReadyResponse.status, 503);
    assert.deepEqual(await notReadyResponse.json(), { status: "not_ready" });
    contractState.ready = true;

    const automationResponse = await fetch(`${baseUrl}/automation`);
    assert.equal(automationResponse.status, 200);
    assert.deepEqual(await automationResponse.json(), contractState.automation);
    contractState.automation = { ...contractState.automation, servicesReady: false };
    const automationUnavailable = await fetch(`${baseUrl}/automation`);
    assert.equal(automationUnavailable.status, 503);
    assert.deepEqual(await automationUnavailable.json(), contractState.automation);
    contractState.automation = { ...contractState.automation, servicesReady: true };

    const enrichmentResponse = await fetch(`${baseUrl}/enrichment`);
    assert.equal(enrichmentResponse.status, 200);
    assert.deepEqual(await enrichmentResponse.json(), contractState.enrichment);
    contractState.enrichment = { ...contractState.enrichment, available: false };
    const enrichmentUnavailable = await fetch(`${baseUrl}/enrichment`);
    assert.equal(enrichmentUnavailable.status, 503);
    assert.deepEqual(await enrichmentUnavailable.json(), contractState.enrichment);
    contractState.enrichment = { ...contractState.enrichment, available: true };
  } finally {
    contractState.ready = true;
    contractState.automation = healthyAutomation;
    contractState.enrichment = healthyEnrichment;
    await app.close();
  }
});
