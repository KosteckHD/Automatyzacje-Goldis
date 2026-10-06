import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json } from "express";
import { AppModule } from "./module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  // Complete UFG snapshots can exceed Express's default JSON limit.
  app.use("/api/internal/worker-runs", json({ limit: "5mb" }));
  app.getHttpAdapter().getInstance().set("trust proxy", 1);
  app.setGlobalPrefix("api");
  await app.listen(Number(process.env.API_PORT || 3001), "0.0.0.0");
}

bootstrap().catch((error) => {
  console.error("API_START_FAILED", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
